#!/usr/bin/env python3
"""Find rare defect examples (such as raised nails) among nail slices, and turn the ones a person
accepted into a dataset.

`scan` runs a model that knows the defect class at a low confidence over every slice of a prepared
nails dataset (usually QA session frames, see evaluate-model's session_datasets.py) and ranks the
candidates: model score first, slices a reviewer marked as a nails defect raised, and boxes a reviewer
already labeled as the defect kept aside as known examples. `export` reads the review decisions and
writes the accepted slices, with every other nail labeled as in the reference, as a YOLO dataset.
Nothing is sent to Zira.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "evaluate-model" / "scripts"))

from model_evaluation import EvalError, box_iou, file_sha256, load_dataset, read_labels, read_reference  # noqa: E402

RUN_FORMAT = "zira.defect-candidates"
EXPORT_FORMAT = "zira.defect-dataset"
REJECT, SKIP = "reject", "skip"  # "skip" is the reviewer's "unsure": left out of training, listed for a second look
OVERLAP = 0.3  # a candidate on a reference box relabels that box instead of adding one
EXIT_OK, EXIT_INVALID = 0, 2


def box(b: dict) -> dict:
    return {k: round(float(b[k]), 6) for k in ("x", "y", "w", "h")}


def is_defect_mark(category: str) -> bool:
    return "defect" in category.lower()


# ---------------------------------------------------------------- scan

def classes_of(target) -> list[str]:
    """One class or several ("raisedNail,protrudeNail"), in order, without repeats."""
    raw = target if isinstance(target, (list, tuple)) else str(target or "").split(",")
    return list(dict.fromkeys(t.strip() for t in raw if str(t).strip()))


def scan(dataset: str, model_path: str, target, model_classes: list[str] | None = None, confidence: float = 0.05,
         nms_iou: float = 0.45, limit: int | None = None, threads: int = 4, frames_root: str | None = None,
         load_model=None, progress=None, cancelled=lambda: False, data_source_id: str | None = None) -> dict:
    started = time.perf_counter()
    progress = progress or (lambda *a, **k: None)
    data = load_dataset(Path(dataset), "all", limit)
    names = data.class_names
    path = Path(model_path).expanduser().resolve()
    if not path.is_file():
        raise EvalError(f"model file not found: {path}")
    if load_model is None:
        import backends
        load_model = backends.load_model
    model = load_model(path, threads=threads, device="cpu")
    classes = model.class_names or model_classes
    if not classes:
        raise EvalError("the model file has no class names; pass --model-classes with the classes Zira recorded")
    targets = classes_of(target)
    if not targets:
        raise EvalError("choose at least one class to look for")
    missing = [t for t in targets if t not in classes]
    if missing:
        raise EvalError(f"the model has no {', '.join(missing)} class ({', '.join(classes)}); choose a model trained with it")
    model_ids = {classes.index(t): t for t in targets}
    data_ids = {names.index(t) for t in targets if t in names}
    reference = read_reference(data.root) or {}
    slice_meta = reference.get("slices", {})

    items, scanned = [], 0
    progress("start", total=len(data.items), model=path.name, target=", ".join(targets))
    for index, item in enumerate(data.items, 1):
        if cancelled():
            progress("cancelled", done=index - 1, total=len(data.items))
            break
        scanned += 1
        truth, _ = read_labels(item.label, len(names))
        known = [i for i, t in enumerate(truth) if t["classId"] in data_ids]
        found = [b for b in model.predict(item.image, confidence=confidence, nms_iou=nms_iou).boxes if b["classId"] in model_ids]
        meta = slice_meta.get(item.name, {})
        marks = [m for m in meta.get("marks", []) if isinstance(m, str)]
        candidates = []
        for b in sorted(found, key=lambda b: -b["score"]):
            overlaps = sorted(((box_iou(b, t), i) for i, t in enumerate(truth)), reverse=True)
            best = overlaps[0] if overlaps and overlaps[0][0] >= OVERLAP else None
            if best and best[1] in known:
                continue  # a reviewer already labeled this one
            candidates.append({**box(b), "score": round(float(b["score"]), 4), "class": model_ids[b["classId"]],
                               **({"referenceIndex": best[1], "referenceClass": names[truth[best[1]]["classId"]]} if best else {})})
        defect_marked = any(is_defect_mark(m) for m in marks)
        if not candidates and not known and not defect_marked:
            if index % 200 == 0 or index == len(data.items):
                progress("slice", done=index, total=len(data.items))
            continue
        top = candidates[0]["score"] if candidates else 0.0
        items.append({
            "image": item.name, "split": item.split,
            **{k: meta[k] for k in ("frame", "session", "crop", "scale", "pad", "content") if k in meta},
            **({"labelSource": reference.get("images", {}).get(item.name)} if reference else {}),
            "marks": marks, "known": len(known),
            "truth": [{"classId": t["classId"], **box(t)} for t in truth],
            "candidates": candidates,
            # The model's confidence leads; a reviewer's "nails defect" mark lifts a slice for a look.
            "rank": round(top + (0.3 if defect_marked else 0.0), 4),
        })
        if index % 200 == 0 or index == len(data.items):
            progress("slice", done=index, total=len(data.items))
    review = sorted((i for i in items if i["candidates"] or (not i["known"] and any(is_defect_mark(m) for m in i["marks"]))),
                    key=lambda i: (-i["rank"], i["image"]))
    known_items = [i for i in items if i["known"] and not i["candidates"]]
    complete = scanned == len(data.items)
    return {
        "format": RUN_FORMAT, "version": 1, "complete": complete,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "target": targets[0], "targets": targets,
        **({"dataSourceId": str(data_source_id)} if data_source_id else {}),
        "dataset": {"path": str(data.root), "name": Path(dataset).name, "classNames": names, "slices": len(data.items),
                    "scanned": scanned, **({"sessions": reference.get("sessions", [])} if reference else {})},
        # QA session slices carry the device's own detections (or a reviewer's correction); a dataset
        # version carries what annotators drew.
        "labelsFrom": "sessions" if reference else "dataset",
        **({"framesRoot": str(Path(frames_root).expanduser().resolve())} if frames_root else {}),
        "model": {"path": str(path), "name": path.name, "sha256": file_sha256(path), "classNames": classes},
        "settings": {"confidence": confidence, "nmsIou": nms_iou, "overlap": OVERLAP},
        "totals": {"toReview": len(review), "candidateBoxes": sum(len(i["candidates"]) for i in review),
                   "markedSlices": sum(1 for i in items if any(is_defect_mark(m) for m in i["marks"])),
                   "knownSlices": len([i for i in items if i["known"]]), "knownBoxes": sum(i["known"] for i in items)},
        "elapsedSeconds": round(time.perf_counter() - started, 2),
        "review": review,
        "knownItems": known_items,
    }


# ---------------------------------------------------------------- export

def read_decisions(path: Path) -> dict:
    try:
        doc = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    except ValueError as error:
        raise EvalError(f"decisions file is not valid JSON: {error}") from error
    decisions = doc.get("decisions", doc) if isinstance(doc, dict) else {}
    return decisions if isinstance(decisions, dict) else {}


def labelled(item: dict, choices: dict, names: list[str], targets: list[str]) -> tuple[list[dict], bool, bool]:
    """The slice's reference boxes with the reviewer's choices applied. Keys are candidate indexes
    ("0") or reference box indexes ("r0"). A candidate on a reference box relabels that box, otherwise
    it is added; a reference box is relabeled in place; a rejected candidate changes nothing."""
    boxes = [dict(t) for t in item["truth"]]
    accepted = changed = False
    for key, label in sorted(choices.items()):
        key = str(key)
        if label in (REJECT, SKIP):
            continue
        class_id = names.index(label)
        if key.startswith("r") and key[1:].isdigit() and int(key[1:]) < len(boxes):
            boxes[int(key[1:])]["classId"] = class_id
        elif key.isdigit() and int(key) < len(item["candidates"]):
            candidate = item["candidates"][int(key)]
            if candidate.get("referenceIndex") is not None:
                boxes[candidate["referenceIndex"]]["classId"] = class_id
            else:
                boxes.append({"classId": class_id, **{k: candidate[k] for k in ("x", "y", "w", "h")}})
        else:
            continue
        accepted = accepted or label in targets
        changed = True
    return boxes, accepted, changed


def export(run_dir: str, out: str, name: str, decisions_file: str | None = None, all_reviewed: bool = False,
           include_known: bool = True, val_share: float = 0.15, zip_path: str | None = None, replace: bool = False,
           whole: bool = False, keep_unsure: bool = False) -> dict:
    """Accepted slices as a new dataset, or with `whole` every slice of the scanned dataset with the
    decisions applied and its splits kept (a corrected version of a training dataset)."""
    all_reviewed = all_reviewed or whole  # a corrected version keeps every reviewed relabel
    run_path = Path(run_dir).expanduser().resolve()
    run = json.loads((run_path / "candidates.json").read_text())
    if run.get("format") != RUN_FORMAT:
        raise EvalError(f"{run_path} is not a find-defects run")
    decisions = read_decisions(Path(decisions_file) if decisions_file else run_path / "decisions.json")
    targets, root = run.get("targets") or [run["target"]], Path(run["dataset"]["path"])
    names = list(run["dataset"]["classNames"])
    used = {label for d in decisions.values() for label in (d.get("boxes", {}) if isinstance(d, dict) else {}).values()}
    for label in sorted(used - {REJECT, SKIP}) + targets:
        if label not in names:
            names.append(label)
    if not name or any(c in name for c in "/\\") or name.startswith("."):
        raise EvalError("name must be a plain folder name")
    final = Path(out).expanduser().resolve() / name
    if final.exists() and not replace:
        raise EvalError(f"{final} already exists; choose another --name or pass --replace")
    if not 0 <= val_share < 1:
        raise EvalError("val share must be at least 0 and below 1")

    rows, counts = [], {"accepted": 0, "relabeled": 0, "rejected": 0, "known": 0, "targetBoxes": 0, "unsure": 0}
    unsure = []
    for item in run.get("review", []):
        choices = (decisions.get(item["image"]) or {}).get("boxes", {})
        choices = {k: v for k, v in choices.items() if v in names or v in (REJECT, SKIP)}
        if not choices:
            continue
        if SKIP in choices.values() and not keep_unsure:
            # Better to leave an example out than to teach a label nobody could confirm.
            counts["unsure"] += 1
            unsure.append(item["image"])
            continue
        boxes, accepted, changed = labelled(item, choices, names, targets)
        counts["rejected"] += sum(1 for v in choices.values() if v == REJECT)
        if accepted:
            counts["accepted"] += 1
        elif changed:
            counts["relabeled"] += 1
        if accepted or (all_reviewed and any(v != SKIP for v in choices.values())):
            rows.append((item, boxes))
    if include_known:
        for item in run.get("knownItems", []):
            counts["known"] += 1
            rows.append((item, [dict(t) for t in item["truth"]]))
    if not rows and not (whole and counts["rejected"]):
        raise EvalError("no accepted slices yet; review some candidates first")

    stage = final.with_name(f".{name}.partial")
    if stage.exists():
        shutil.rmtree(stage)
    target_ids = {names.index(t) for t in targets}
    write_box = lambda b: f"{b['classId']} {b['x']:.6f} {b['y']:.6f} {b['w']:.6f} {b['h']:.6f}\n"

    def place(source: Path, split: str, label_text: str) -> None:
        for kind in ("images", "labels"):
            (stage / split / kind).mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, stage / split / "images" / source.name)
        (stage / split / "labels" / f"{source.stem}.txt").write_text(label_text)

    if whole:
        # Every slice keeps its split and its label file; reviewed ones get the corrected boxes.
        corrected = {item["image"]: boxes for item, boxes in rows}
        left_out = set(unsure)
        data = load_dataset(root, "all")
        for item in data.items:
            if item.name in left_out:
                continue
            if item.name in corrected:
                boxes = corrected[item.name]
                place(item.image, item.split, "".join(write_box(b) for b in boxes))
                counts["targetBoxes"] += sum(1 for b in boxes if b["classId"] in target_ids)
            else:
                place(item.image, item.split, item.label.read_text() if item.label.is_file() else "")
                counts["targetBoxes"] += sum(1 for b in read_labels(item.label, len(names))[0] if b["classId"] in target_ids)
        rows = [(None, None)] * (len(data.items) - len(left_out))
    for item, boxes in ([] if whole else rows):
        split = "val" if int(hashlib.sha1(item["image"].encode()).hexdigest()[:8], 16) / 0xFFFFFFFF < val_share else "train"
        source = (root / item["image"]).resolve()
        if not source.is_relative_to(root.resolve()) or not source.is_file():
            raise EvalError(f"slice image missing: {item['image']}")
        place(source, split, "".join(write_box(b) for b in boxes))
        counts["targetBoxes"] += sum(1 for b in boxes if b["classId"] in target_ids)
    lines = ["train: ../train/images", "val: ../val/images", "test: ../test/images", f"nc: {len(names)}", "names:"]
    (stage / "data.yaml").write_text("\n".join(lines + [f"  - {json.dumps(n)}" for n in names]) + "\n")
    splits = {s: len(list((stage / s / "images").glob("*"))) for s in ("train", "val", "test") if (stage / s).is_dir()}
    manifest = {"format": EXPORT_FORMAT, "version": 1, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "target": targets[0], "targets": targets, "classNames": names, "images": len(rows), "splits": splits, "counts": counts,
                "whole": whole, **({"unsureLeftOut": unsure} if unsure else {}),
                "source": {"run": str(run_path), "dataset": str(root), "sessions": run["dataset"].get("sessions", []),
                           "model": run["model"]["name"], "modelSha256": run["model"]["sha256"]},
                "note": "Accepted slices keep every other nail as labeled in the reference (reviewer correction or device output)."}
    (stage / "defects-manifest.json").write_text(json.dumps(manifest, indent=2))
    if final.exists():
        shutil.rmtree(final)
    final.parent.mkdir(parents=True, exist_ok=True)
    os.replace(stage, final)
    result = {"kind": "zira.defect-export", "path": str(final), **manifest}
    if zip_path:
        archive = Path(zip_path).expanduser()
        if archive.exists():
            raise EvalError(f"{archive} already exists; choose another name")
        partial = archive.with_name(archive.name + ".partial")
        with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED) as bundle:
            for file in sorted(p for p in final.rglob("*") if p.is_file()):
                bundle.write(file, file.relative_to(final).as_posix())
        os.replace(partial, archive)
        result["zip"] = str(archive)
    return result


# ---------------------------------------------------------------- CLI

def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="find_defects.py", description="Rank likely defect slices and export reviewed ones.",
                                epilog="Exit 0 done, 2 invalid input. Writes only the files named; nothing is sent to Zira.")
    sub = p.add_subparsers(dest="command", required=True)
    s = sub.add_parser("scan", help="rank candidate slices with a model that knows the defect class")
    s.add_argument("--dataset", required=True, help="nails dataset folder (data.yaml, <split>/images)")
    s.add_argument("--model", required=True, help=".tflite or .pt model trained with the defect class")
    s.add_argument("--target", default="raisedNail", help="class or comma-separated classes to look for (default raisedNail)")
    s.add_argument("--model-classes", help="comma-separated class names Zira recorded for a .tflite")
    s.add_argument("--confidence", type=float, default=0.05, help="lowest score kept (default 0.05: find more, review decides)")
    s.add_argument("--limit", type=int, help="scan only the first N slices")
    s.add_argument("--threads", type=int, default=4)
    s.add_argument("--frames-root", help="folder of the session frames, for showing a slice on its pallet")
    s.add_argument("--device-id", help="the Zira data source the slices came from (recorded for the review page)")
    s.add_argument("--out", required=True, help="run folder to create (candidates.json)")
    s.add_argument("--progress", action="store_true", help="JSON-lines progress on stderr")
    e = sub.add_parser("export", help="write accepted slices as a dataset")
    e.add_argument("--run", required=True)
    e.add_argument("--decisions", help="decisions JSON (default: the run's decisions.json)")
    e.add_argument("--out", required=True)
    e.add_argument("--name", required=True)
    e.add_argument("--all-reviewed", action="store_true", help="also include reviewed slices without the defect (hard negatives and relabels)")
    e.add_argument("--no-known", action="store_true", help="leave out slices a reviewer had already labeled with the defect")
    e.add_argument("--val-share", type=float, default=0.15)
    e.add_argument("--zip", help="also write the dataset as this ZIP (for Zira's Add dataset upload)")
    e.add_argument("--replace", action="store_true")
    e.add_argument("--whole", action="store_true", help="every slice of the scanned dataset with the decisions applied, splits kept")
    e.add_argument("--keep-unsure", action="store_true", help="keep slices marked unsure (with their current labels) instead of leaving them out")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "scan":
            out = Path(args.out).expanduser()
            if (out / "candidates.json").exists():
                raise EvalError(f"{out} already has a run; choose a new --out")
            emit = (lambda event, **f: print(json.dumps({"event": event, **f}), file=sys.stderr, flush=True)) if args.progress else None
            if not 0 < args.confidence < 1:
                raise EvalError("confidence must be between 0 and 1")
            result = scan(args.dataset, args.model, args.target,
                          [c.strip() for c in args.model_classes.split(",")] if args.model_classes else None,
                          args.confidence, limit=args.limit, threads=args.threads, frames_root=args.frames_root, progress=emit,
                          data_source_id=args.device_id)
            out.mkdir(parents=True, exist_ok=True)
            (out / "candidates.json").write_text(json.dumps(result, separators=(",", ":")))
            summary = {k: result[k] for k in ("target", "targets", "complete", "totals", "elapsedSeconds")}
            print(json.dumps({"kind": "zira.defect-scan", "run": str(out.resolve()), **summary,
                              "model": result["model"]["name"], "slices": result["dataset"]["slices"]}))
        else:
            print(json.dumps(export(args.run, args.out, args.name, args.decisions, args.all_reviewed, not args.no_known,
                                    args.val_share, args.zip, args.replace, args.whole, args.keep_unsure)))
    except (EvalError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return EXIT_INVALID
    except ImportError as error:
        print(f"error: {error}. Prepare the model runtime first: node ../evaluate-model/scripts/evaluate.mjs setup", file=sys.stderr)
        return EXIT_INVALID
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
