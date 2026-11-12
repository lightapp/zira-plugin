#!/usr/bin/env python3
"""Zira model evaluation: run a detection model (.tflite or .pt) on a dataset version and score it.

Part of the Zira plugin's "Evaluate a Model" skill. Writes a versioned JSON report that keeps
ground truth and predictions separate and records dataset, model, class mapping, preprocessing,
thresholds and timing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import queue
import signal
import sys
import time
import zipfile
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

REQUEST_VERSION = 1
REPORT_FORMAT = "zira.model-evaluation.report"
REPORT_VERSION = 1
SPLITS = ("train", "val", "test")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
EXIT_OK, EXIT_INVALID, EXIT_PARTIAL = 0, 2, 3
MAX_WORKERS = 16


class EvalError(Exception):
    """An invalid request or input; reported on stderr with exit 2."""


# ---------------------------------------------------------------- dataset

@dataclass
class Item:
    name: str  # path relative to the dataset root, used as the stable image id
    split: str
    image: Path
    label: Path


@dataclass
class Dataset:
    root: Path
    layout: str
    class_names: list[str]
    items: list[Item] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)


def read_class_names(root: Path) -> list[str]:
    import yaml

    for candidate in ("data.yaml", "data.yml", "dataset.yaml"):
        path = root / candidate
        if path.is_file():
            doc = yaml.safe_load(path.read_text()) or {}
            names = doc.get("names")
            if isinstance(names, dict):
                keys = sorted(int(k) for k in names)
                if keys != list(range(len(keys))):
                    raise EvalError(f"{candidate} class ids must be 0..n-1, got {keys}")
                return [str(names[k] if k in names else names[str(k)]) for k in keys]
            if isinstance(names, list) and names:
                return [str(n) for n in names]
            raise EvalError(f"{candidate} has no class names")
    raise EvalError("dataset has no data.yaml with class names")


def find_split_dirs(root: Path, split: str) -> tuple[str, Path, Path] | None:
    """Zira datasets use images/<split>; classic Ultralytics exports use <split>/images."""
    zira = (root / "images" / split, root / "labels" / split)
    classic = (root / split / "images", root / split / "labels")
    if zira[0].is_dir():
        return "images/<split>", *zira
    if classic[0].is_dir():
        return "<split>/images", *classic
    return None


def extract_zip(archive: Path, work_dir: Path) -> Path:
    """Unpacks a Zira dataset version ZIP once per archive content; refuses paths that escape the folder."""
    digest = file_sha256(archive)[:16]
    target = (work_dir / f"{archive.stem}-{digest}").resolve()
    if (target / ".complete").is_file():
        return dataset_root(target)
    staging = target.with_name(target.name + ".partial")
    if staging.exists():
        import shutil
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            destination = (staging / member.filename).resolve()
            if not destination.is_relative_to(staging.resolve()):
                raise EvalError(f"unsafe path in dataset archive: {member.filename}")
        bundle.extractall(staging)
    (staging / ".complete").write_text(archive.name)
    if target.exists():
        import shutil
        shutil.rmtree(target)
    os.replace(staging, target)
    return dataset_root(target)


def dataset_root(folder: Path) -> Path:
    """A ZIP with a single top folder holds the dataset inside it."""
    entries = [p for p in folder.iterdir() if not p.name.startswith(("__MACOSX", "."))]
    if len(entries) == 1 and entries[0].is_dir() and not (folder / "data.yaml").exists():
        return entries[0]
    return folder


def load_dataset(root: Path, split: str, limit: int | None = None, work_dir: Path | None = None) -> Dataset:
    root = root.expanduser().resolve()
    if root.is_file() and root.suffix.lower() == ".zip":
        root = extract_zip(root, (work_dir or root.parent / ".zira-model-evaluation").expanduser())
    if not root.is_dir():
        raise EvalError(f"dataset folder not found: {root}")
    names = read_class_names(root)
    wanted = SPLITS if split == "all" else (split,)
    dataset = Dataset(root=root, layout="", class_names=names)
    layouts = set()
    for name in wanted:
        found = find_split_dirs(root, name)
        if not found:
            dataset.counts[name] = 0
            continue
        layout, images, labels = found
        layouts.add(layout)
        files = sorted(p for p in images.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES)
        dataset.counts[name] = len(files)
        for image in files:
            rel = image.relative_to(images)
            dataset.items.append(Item(name=image.relative_to(root).as_posix(), split=name, image=image,
                                      label=(labels / rel).with_suffix(".txt")))
    if len(layouts) > 1:
        raise EvalError("dataset mixes images/<split> and <split>/images layouts")
    dataset.layout = layouts.pop() if layouts else ""
    if not dataset.items:
        raise EvalError(f"no images found for split {split!r}; counts {dataset.counts}")
    if limit:
        dataset.items = dataset.items[:limit]
    return dataset


def read_labels(path: Path, class_count: int) -> tuple[list[dict], list[str]]:
    """YOLO detection labels; problems are reported, never silently dropped."""
    boxes, problems = [], []
    try:
        lines = path.read_text().splitlines()
    except FileNotFoundError:
        return boxes, problems  # an unlabeled image has no ground truth boxes
    for number, line in enumerate(lines, 1):
        parts = line.split()
        if not parts:
            continue
        if len(parts) != 5:
            problems.append(f"line {number}: expected 5 values, got {len(parts)}")
            continue
        try:
            class_id = int(parts[0])
            x, y, w, h = (float(v) for v in parts[1:])
        except ValueError:
            problems.append(f"line {number}: not numeric")
            continue
        if not 0 <= class_id < class_count:
            problems.append(f"line {number}: class {class_id} outside data.yaml names")
            continue
        if w <= 0 or h <= 0 or not all(math.isfinite(v) for v in (x, y, w, h)):
            problems.append(f"line {number}: empty or invalid box")
            continue
        boxes.append({"classId": class_id, "x": x, "y": y, "w": w, "h": h})
    return boxes, problems


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def dataset_fingerprint(items: list[Item]) -> str:
    """Identifies the evaluated images and their labels, so a rerun can be compared."""
    digest = hashlib.sha256()
    for item in items:
        digest.update(item.name.encode())
        digest.update(b"\0")
        digest.update(item.label.read_bytes() if item.label.is_file() else b"<none>")
        digest.update(b"\0")
    return digest.hexdigest()


def read_reference(root: Path) -> dict | None:
    """Where a session-built dataset's labels came from (session_datasets.py writes it): reviewer
    corrections or the device models' own output. None for an ordinary dataset version."""
    try:
        doc = json.loads((root / "zira-reference.json").read_text())
    except (FileNotFoundError, ValueError):
        return None
    if not isinstance(doc, dict) or doc.get("format") != "zira.session-reference" or not isinstance(doc.get("images"), dict):
        return None
    return doc


# ---------------------------------------------------------------- matching and metrics

def box_iou(a: dict, b: dict) -> float:
    ax1, ay1, ax2, ay2 = a["x"] - a["w"] / 2, a["y"] - a["h"] / 2, a["x"] + a["w"] / 2, a["y"] + a["h"] / 2
    bx1, by1, bx2, by2 = b["x"] - b["w"] / 2, b["y"] - b["h"] / 2, b["x"] + b["w"] / 2, b["y"] + b["h"] / 2
    inter = max(0.0, min(ax2, bx2) - max(ax1, bx1)) * max(0.0, min(ay2, by2) - max(ay1, by1))
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


def match_boxes(truth: list[dict], predictions: list[dict], threshold: float) -> list[dict]:
    """Greedy same-class matching by IoU, highest overlap first."""
    candidates = sorted(
        ((box_iou(t, p), ti, pi) for ti, t in enumerate(truth) for pi, p in enumerate(predictions)
         if t["classId"] == p["classId"]),
        reverse=True)
    used_t, used_p, pairs = set(), set(), []
    for overlap, ti, pi in candidates:
        if overlap < threshold or ti in used_t or pi in used_p:
            continue
        used_t.add(ti)
        used_p.add(pi)
        pairs.append({"truth": ti, "prediction": pi, "iou": round(overlap, 4)})
    return pairs


def rates(tp: int, fp: int, fn: int) -> dict:
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1 = 2 * precision * recall / (precision + recall) if precision and recall else (0.0 if precision is not None and recall is not None else None)
    return {"tp": tp, "fp": fp, "fn": fn, "precision": precision, "recall": recall, "f1": f1}


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * q
    low, high = math.floor(position), math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def timing(values: list[float]) -> dict:
    return {"meanMs": sum(values) / len(values) if values else None, "p95Ms": percentile(values, 0.95)}


# ---------------------------------------------------------------- class mapping

def check_class_mapping(dataset_names: list[str], model, allow_mismatch: bool, known_names: list[str] | None = None) -> dict:
    """A class mismatch would make metrics meaningless, so it stops the run by default.

    `known_names` are the model's classes as Zira recorded them at training; they name a LiteRT
    export, which carries none itself, so knot-vs-raisedNail is caught even when counts match."""
    mapping = {"datasetNames": dataset_names}
    names = model.class_names if model.class_names is not None else known_names
    if model.class_names is not None and known_names is not None and known_names != model.class_names:
        mapping["recordedNames"] = known_names  # the checkpoint's own names win; keep Zira's for review
    if names is not None:
        mapping.update(source="model-names" if model.class_names is not None else "recorded-names", modelNames=names)
        if model.class_count is not None and model.class_count != len(names):
            raise EvalError(f"the model predicts {model.class_count} classes but its recorded class list has {len(names)}")
        mismatch = names != dataset_names
        detail = f"the model's classes ({', '.join(names)}) differ from the dataset's ({', '.join(dataset_names)})"
        comparable = [i < len(names) and names[i] == n for i, n in enumerate(dataset_names)]
    else:
        mapping.update(source="class-count", modelClassCount=model.class_count,
                       warning="The model carries no class names; ids are assumed to follow data.yaml order.")
        mismatch = model.class_count is not None and model.class_count != len(dataset_names)
        detail = f"model predicts {model.class_count} classes but data.yaml lists {len(dataset_names)}"
        comparable = [not mismatch] * len(dataset_names)
    mapping["mismatch"] = mismatch
    mapping["comparable"] = comparable
    if mismatch and not allow_mismatch:
        raise EvalError(f"class mismatch: {detail}. Use a matching dataset, or --allow-class-mismatch to score only the classes that match.")
    if mismatch:
        kept = [n for n, ok in zip(dataset_names, comparable) if ok]
        mapping["warning"] = (f"Class mismatch: {detail[0].upper() + detail[1:]}. Overall results count only the classes that match "
                              f"({', '.join(kept) if kept else 'none'}); the others are listed but not comparable.")
    return mapping


# ---------------------------------------------------------------- request and run

def build_request(args: argparse.Namespace) -> dict:
    if args.request:
        request = json.loads(Path(args.request).read_text())
        if request.get("version") != REQUEST_VERSION:
            raise EvalError(f"unsupported request version {request.get('version')!r}; expected {REQUEST_VERSION}")
    else:
        request = {"version": REQUEST_VERSION}
    for key, value in (("dataset", args.dataset), ("model", args.model), ("split", args.split),
                       ("confidence", args.confidence), ("nmsIou", args.nms_iou), ("matchIou", args.match_iou),
                       ("threads", args.threads), ("workers", args.workers), ("limit", args.limit), ("device", args.device), ("workDir", args.work_dir),
                       ("allowClassMismatch", args.allow_class_mismatch or None),
                       ("modelClassNames", [n.strip() for n in args.model_classes.split(",")] if args.model_classes else None)):
        if value is not None:
            request[key] = value
    request.setdefault("split", "val")
    request.setdefault("confidence", 0.25)
    request.setdefault("nmsIou", 0.45)
    request.setdefault("matchIou", 0.5)
    request.setdefault("threads", 4)
    request.setdefault("workers", default_workers())
    request.setdefault("device", "cpu")
    for key in ("dataset", "model"):
        if not request.get(key):
            raise EvalError(f"--{key} is required")
    if request["split"] not in (*SPLITS, "all"):
        raise EvalError("split must be train, val, test or all")
    for key in ("confidence", "nmsIou", "matchIou"):
        if not 0 <= float(request[key]) <= 1:
            raise EvalError(f"{key} must be between 0 and 1")
    if request.get("limit") is not None and int(request["limit"]) < 1:
        raise EvalError("limit must be at least 1")
    if not 1 <= int(request["workers"]) <= MAX_WORKERS:
        raise EvalError(f"workers must be 1 to {MAX_WORKERS}")
    return request


def default_workers() -> int:
    """Half the CPUs, at most six: each worker is one interpreter (about 170 MB at 1024 input)."""
    return max(1, min(6, (os.cpu_count() or 2) // 2))


def predict_stream(models: list, items: list, confidence: float, nms_iou: float, cancelled):
    """(item, prediction) in dataset order. With several models (one interpreter per thread, LiteRT releases
    Python's lock while a model runs) stills are scored in parallel; each still is scored on its own by one
    interpreter, so the results are those of a one-worker run. Stops before the next still once cancelled."""
    if len(models) == 1:
        for item in items:
            if cancelled():
                return
            yield item, models[0].predict(item.image, confidence=confidence, nms_iou=nms_iou)
        return
    free: queue.Queue = queue.Queue()
    for model in models:
        free.put(model)

    def run(item):
        model = free.get()
        try:
            return model.predict(item.image, confidence=confidence, nms_iou=nms_iou)
        finally:
            free.put(model)

    pool = ThreadPoolExecutor(max_workers=len(models), thread_name_prefix="predict")
    pending: deque = deque()
    upcoming = iter(items)
    try:
        while True:
            while len(pending) < 2 * len(models):  # a bounded look-ahead keeps memory flat on large splits
                item = next(upcoming, None)
                if item is None:
                    break
                pending.append((item, pool.submit(run, item)))
            if not pending or cancelled():
                return
            item, future = pending.popleft()
            yield item, future.result()
    finally:
        pool.shutdown(wait=True, cancel_futures=True)


class Progress:
    """JSON lines on stderr so an agent or UI can follow a long run."""

    def __init__(self, enabled: bool, stream=sys.stderr):
        self.enabled, self.stream = enabled, stream

    def __call__(self, event: str, **fields):
        if self.enabled:
            print(json.dumps({"event": event, **fields}), file=self.stream, flush=True)


def evaluate(request: dict, *, load_model=None, progress=None, cancelled=lambda: False) -> dict:
    """Runs the request and returns the report. load_model is injectable for tests."""
    progress = progress or Progress(False)
    started = time.perf_counter()
    dataset = load_dataset(Path(request["dataset"]), request["split"], request.get("limit"),
                            Path(request["workDir"]) if request.get("workDir") else None)
    model_path = Path(request["model"]).expanduser().resolve()
    if not model_path.is_file():
        raise EvalError(f"model file not found: {model_path}")
    if load_model is None:
        import backends
        load_model = backends.load_model
    load_started = time.perf_counter()
    # Parallel workers for LiteRT models; an Ultralytics checkpoint runs its own threads.
    workers = int(request.get("workers") or 1) if model_path.suffix.lower() == ".tflite" else 1
    if workers > 1:
        models = [load_model(model_path, threads=1, device=request["device"]) for _ in range(workers)]
    else:
        models = [load_model(model_path, threads=int(request["threads"]), device=request["device"])]
    model = models[0]
    load_seconds = time.perf_counter() - load_started
    mapping = check_class_mapping(dataset.class_names, model, bool(request.get("allowClassMismatch")), request.get("modelClassNames"))

    count = len(dataset.class_names)
    stats = [[0, 0, 0] for _ in range(count)]
    reference = read_reference(dataset.root)
    by_source: dict[str, list[list[int]]] = {}
    confusion: dict[tuple[int, int], int] = {}
    pre_ms, model_ms, post_ms, images, label_problems = [], [], [], [], []
    total = len(dataset.items)
    progress("start", total=total, model=model_path.name, split=request["split"])
    stream = predict_stream(models, dataset.items, float(request["confidence"]), float(request["nmsIou"]), cancelled)
    for index, (item, out) in enumerate(stream, 1):
        truth, problems = read_labels(item.label, count)
        if problems:
            label_problems.append({"image": item.name, "problems": problems[:20]})
        scores = (reference.get("deviceScores") or {}).get(item.name) if reference else None
        if isinstance(scores, list) and len(scores) == len(truth) and not problems:
            for box, score in zip(truth, scores):
                if isinstance(score, (int, float)):
                    box["deviceScore"] = float(score)
        predictions = [p for p in out.boxes if 0 <= p["classId"] < count]
        pre_ms.append(out.preprocess_ms)
        model_ms.append(out.model_ms)
        post_ms.append(out.postprocess_ms)
        pairs = match_boxes(truth, predictions, float(request["matchIou"]))
        matched_t = {p["truth"] for p in pairs}
        matched_p = {p["prediction"] for p in pairs}
        # A missed label with an unmatched prediction of another class on it was found, but named wrong.
        confused, free = [], [i for i in range(len(predictions)) if i not in matched_p]
        for ti, t in enumerate(truth):
            if ti in matched_t or not free:
                continue
            overlap, pi = max((box_iou(t, predictions[i]), i) for i in free)
            if overlap >= float(request["matchIou"]) and predictions[pi]["classId"] != t["classId"]:
                key = (t["classId"], predictions[pi]["classId"])
                confusion[key] = confusion.get(key, 0) + 1
                confused.append({"truth": ti, "prediction": pi})
                free.remove(pi)
        source = reference["images"].get(item.name, "unknown") if reference else None
        targets = [stats] + ([by_source.setdefault(source, [[0, 0, 0] for _ in range(count)])] if reference else [])
        for i, box in enumerate(truth):
            for table in targets:
                table[box["classId"]][0 if i in matched_t else 2] += 1
        for i, box in enumerate(predictions):
            if i not in matched_p:
                for table in targets:
                    table[box["classId"]][1] += 1
        images.append({"image": item.name, "split": item.split, **({"labelSource": source} if reference else {}),
                       "width": out.width, "height": out.height,
                       "truth": truth, "predictions": predictions, "matches": pairs,
                       "tp": len(pairs), "fp": len(predictions) - len(pairs), "fn": len(truth) - len(pairs),
                       **({"confused": confused} if confused else {}),
                       "timingMs": {"preprocess": out.preprocess_ms, "model": out.model_ms, "postprocess": out.postprocess_ms}})
        progress("image", done=index, total=total, image=item.name)
    if len(images) < total:
        progress("cancelled", done=len(images), total=total)
    complete = len(images) == total

    comparable_totals = lambda table: [sum(row[i] for c, row in enumerate(table) if mapping["comparable"][c]) for i in range(3)]
    totals = comparable_totals(stats)
    model_names = mapping.get("modelNames") or []
    model_class = lambda i: model_names[i] if i < len(model_names) else None
    report = {
        "format": REPORT_FORMAT,
        "version": REPORT_VERSION,
        "complete": complete,
        **({} if complete else {"cancelled": True, "evaluated": len(images), "requested": total}),
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "request": request,
        "dataset": {"path": str(dataset.root), "layout": dataset.layout, "split": request["split"],
                    "imageCounts": dataset.counts, "evaluatedImages": len(images),
                    "classNames": dataset.class_names, "fingerprint": dataset_fingerprint(dataset.items[:len(images)])},
        "model": {"path": str(model_path), "name": model_path.name, "sha256": file_sha256(model_path),
                  "sizeBytes": model_path.stat().st_size, **model.info},
        "classMapping": mapping,
        "preprocessing": model.preprocessing,
        "settings": {**{k: request[k] for k in ("confidence", "nmsIou", "matchIou", "threads", "device")}, "workers": workers},
        "summary": {"images": len(images), **rates(*totals)},
        "classes": [{"classId": i, "name": n, **rates(*stats[i]),
                     **({} if mapping["comparable"][i] else {"comparable": False, "modelClass": model_class(i)})}
                    for i, n in enumerate(dataset.class_names)],
        "timing": {
            "note": "Measured on this computer; not device latency. Model time excludes image loading and decoding.",
            "loadModelSeconds": load_seconds,
            "workers": workers,
            "preprocess": timing(pre_ms), "model": timing(model_ms), "postprocess": timing(post_ms),
            "elapsedSeconds": time.perf_counter() - started,
        },
        **({"labelProblems": label_problems} if label_problems else {}),
        # Labels found at the right place under another class, e.g. nails predicted as knots. Each one is
        # also a miss of the labeled class and an extra of the predicted one in the counts above.
        "confusions": [{"labelClass": dataset.class_names[t], "predictedClass": model_class(p) or str(p), "count": n}
                       for (t, p), n in sorted(confusion.items(), key=lambda kv: (-kv[1], kv[0]))],
        **({"reference": {
            "sessions": reference.get("sessions", []),
            "note": ("Labels are reviewer corrections where present (annotations), otherwise the device models' own output "
                     "(device, unverified). On device-labelled images precision is the share of this model's detections the "
                     "device also made, and recall the share of the device's detections this model found."),
            "labelSources": {k: sum(1 for r in images if r.get("labelSource") == k) for k in sorted(by_source)},
            "summaryBySource": {k: rates(*comparable_totals(table)) for k, table in sorted(by_source.items())},
            # Device labels with the camera's own confidence (from the frames' inspection records).
            "deviceScores": {"labels": sum(1 for r in images for t in r["truth"] if "deviceScore" in t),
                             "deviceLabels": sum(len(r["truth"]) for r in images if r.get("labelSource") == "device")},
        }} if reference else {}),
        # Misses and false positives first, so review starts with the errors.
        "images": sorted(images, key=lambda r: (-(r["fp"] + r["fn"]), r["image"])),
    }
    progress("done", complete=complete, images=len(images))
    return report


def inspect(dataset_path: str | None, model_path: str | None, work_dir: str | None, model_classes: list[str] | None,
            load_model=None) -> dict:
    """Quick check of local inputs before a run: dataset layout, classes and images per split; the
    model's type and class count; and whether the two fit together."""
    out: dict = {"kind": "model-evaluation-inspect"}
    names = None
    if dataset_path:
        dataset = load_dataset(Path(dataset_path), "all", None, Path(work_dir) if work_dir else None)
        names = dataset.class_names
        out["dataset"] = {"path": str(dataset.root), "layout": dataset.layout, "classNames": names,
                          "imagesBySplit": {k: v for k, v in dataset.counts.items() if v}, "images": len(dataset.items)}
    if model_path:
        path = Path(model_path).expanduser().resolve()
        if not path.is_file():
            raise EvalError(f"model file not found: {path}")
        if path.suffix.lower() not in (".tflite", ".pt"):
            raise EvalError("model must be a .tflite export or .pt checkpoint")
        info: dict = {"path": str(path), "name": path.name, "format": path.suffix.lower().lstrip("."), "sizeBytes": path.stat().st_size}
        try:
            if load_model is None:
                import backends
                load_model = backends.load_model
            model = load_model(path, threads=1, device="cpu")
            info.update(classNames=model.class_names, classCount=model.class_count, preprocessing=model.preprocessing)
        except ImportError:
            info["runtime"] = "missing" if path.suffix.lower() == ".tflite" else "pt-missing"
        except ValueError as error:
            raise EvalError(f"cannot read the model: {error}") from error
        known = model_classes or info.get("classNames")
        if known:
            info["classNamesUsed"] = known
        out["model"] = info
        if names is not None:
            if known:
                out["sameClasses"] = known == names
            elif info.get("classCount") is not None:
                out["sameClassCount"] = info["classCount"] == len(names)
                out["note"] = "The model file has no class names; give them with --model-classes to check them by name."
    return out


def write_report(report: dict, out: str | None) -> None:
    text = json.dumps(report, separators=(",", ":"), allow_nan=False)
    if not out or out == "-":
        print(text)
        return
    path = Path(out).expanduser()
    if path.exists():
        raise EvalError(f"refusing to overwrite {path}; choose a new --out")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".partial")
    temporary.write_text(text)
    os.replace(temporary, path)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="model_evaluation.py",
        description="Zira model evaluation: run a .tflite (LiteRT) or .pt (Ultralytics) detection model on a dataset version and write a versioned JSON report.",
        epilog="Exit 0 complete, 2 invalid input or failure, 3 cancelled (partial report written).")
    p.add_argument("--request", help=f"versioned request JSON (version {REQUEST_VERSION}); flags override its fields")
    p.add_argument("--dataset", help="dataset version .zip, or a folder with data.yaml and images/<split> or <split>/images")
    p.add_argument("--work-dir", help="where a .zip dataset is unpacked (default: beside the archive)")
    p.add_argument("--model", help=".tflite or .pt model file")
    p.add_argument("--split", choices=(*SPLITS, "all"), help="images to evaluate (default val)")
    p.add_argument("--confidence", type=float, help="minimum prediction score (default 0.25)")
    p.add_argument("--nms-iou", type=float, help="NMS IoU threshold for raw TFLite outputs (default 0.45)")
    p.add_argument("--match-iou", type=float, help="IoU needed to count a prediction as a match (default 0.5)")
    p.add_argument("--threads", type=int, help="TFLite interpreter threads with one worker (default 4)")
    p.add_argument("--workers", type=int, help=f"stills scored in parallel, one interpreter each (default half the CPUs, at most 6; up to {MAX_WORKERS})")
    p.add_argument("--device", help="Ultralytics device, e.g. cpu or mps (default cpu)")
    p.add_argument("--limit", type=int, help="evaluate only the first N images (for a quick check)")
    p.add_argument("--allow-class-mismatch", action="store_true", help="run even when classes differ; overall results count only matching classes")
    p.add_argument("--model-classes", help="comma-separated class names Zira recorded for the model (names a .tflite export)")
    p.add_argument("--out", help="report file to create (default stdout); never overwritten")
    p.add_argument("--html", help="also write a self-contained HTML view (summary, per-class table, image gallery with boxes)")
    p.add_argument("--progress", action="store_true", help="JSON-lines progress events on stderr")
    p.add_argument("--inspect", action="store_true", help="only check the dataset and/or model and print what was found")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    stop = {"requested": False}

    def request_stop(signum, frame):
        stop["requested"] = True  # finish the current image, then write a partial report

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    try:
        if args.inspect:
            if not args.dataset and not args.model:
                raise EvalError("--inspect needs --dataset and/or --model")
            classes = [n.strip() for n in args.model_classes.split(",")] if args.model_classes else None
            print(json.dumps(inspect(args.dataset, args.model, args.work_dir, classes)))
            return EXIT_OK
        request = build_request(args)
        report = evaluate(request, progress=Progress(args.progress), cancelled=lambda: stop["requested"])
        write_report(report, args.out)
        if args.html:
            import report_html
            report_html.write(report, Path(report["dataset"]["path"]), Path(args.html).expanduser())
    except (EvalError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return EXIT_INVALID
    except ImportError as error:
        print(f"error: {error}. Prepare the model runtime first: node evaluate.mjs setup", file=sys.stderr)
        return EXIT_INVALID
    return EXIT_OK if report["complete"] else EXIT_PARTIAL


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
