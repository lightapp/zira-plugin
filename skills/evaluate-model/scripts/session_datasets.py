#!/usr/bin/env python3
"""Turn QA snapshot sessions into local pallets, geometry and nails datasets.

A session folder (`<day>/<session>/` copied from Zira) holds full frames in `images/`, the device
models' output in `labels/`, reviewer corrections in `annotations/`, image marks in `marks/` and the
class names in `data.yaml`. This builds the same per-model datasets as Zira's "Generate training
datasets" (see slices.py), on this computer and without creating anything in Zira, so new models can
be run on frames they were never trained on.

Labels come from the reviewer's correction when there is one (it wins even when empty, as in
zira-web), otherwise from the device output. Device output is what the running models predicted, not
verified truth, so every dataset records which source each image used (`zira-reference.json`), and the
evaluator reports agreement with the device rather than accuracy for those images. Where a frame's
`inspections/` record lists the device's detections with scores, the sidecar keeps the camera's
confidence for each device label line (`deviceScores`).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import slices  # noqa: E402
from model_evaluation import EvalError, IMAGE_SUFFIXES, read_class_names  # noqa: E402

REFERENCE_FORMAT = "zira.session-reference"
OUTPUTS = ("pallets", "geometry", "nails")
REFERENCES = ("auto", "annotations", "device")
EXIT_OK, EXIT_INVALID = 0, 2


# ---------------------------------------------------------------- session input

def session_id(folder: Path) -> str:
    return f"{folder.parent.name}::{folder.name}"


def reference_for(folder: Path, stem: str, mode: str) -> tuple[str | None, str | None]:
    """(label text, source) for one frame; (None, None) when the chosen source has no file."""
    corrected, device = folder / "annotations" / f"{stem}.txt", folder / "labels" / f"{stem}.txt"
    if mode in ("auto", "annotations") and corrected.is_file():
        return corrected.read_text(), "annotations"
    if mode in ("auto", "device") and device.is_file():
        return device.read_text(), "device"
    return None, None


INSPECTION_DETECTIONS = ("snapshotAnnotations", "snapshotNailAnnotations")
SCORE_TOLERANCE = 1e-5  # label files round the device's boxes to 6 decimals


def device_scores(folder: Path, stem: str, names: list[str], boxes: list[tuple]) -> list[float | None]:
    """The camera's confidence for each device label box, from the frame's inspection record.

    Inspections list the device models' detections (`xywh-top-left`, normalized) with a score; the
    label file is the same boxes as YOLO centres. Not every inspection carries them, so a box
    without a same-class detection at the same place gets None."""
    try:
        inspection = json.loads((folder / "inspections" / f"{stem}.json").read_text())
    except (FileNotFoundError, ValueError):
        return [None] * len(boxes)
    holder = inspection.get("standalone") if isinstance(inspection, dict) else None
    detections = []
    for record in (holder, inspection):
        if not isinstance(record, dict):
            continue
        for key in INSPECTION_DETECTIONS:
            found = record.get(key)
            listed = found.get("detections") if isinstance(found, dict) else None
            for d in listed if isinstance(listed, list) else []:
                try:
                    detections.append((str(d["label"]), float(d["x"]) + float(d["w"]) / 2, float(d["y"]) + float(d["h"]) / 2,
                                       float(d["w"]), float(d["h"]), float(d["score"])))
                except (KeyError, TypeError, ValueError):
                    continue
        if detections:
            break
    scores = []
    for class_id, x, y, w, h in boxes:
        name = names[class_id] if 0 <= class_id < len(names) else None
        score = next((d[5] for d in detections if d[0] == name and abs(d[1] - x) <= SCORE_TOLERANCE and abs(d[2] - y) <= SCORE_TOLERANCE
                      and abs(d[3] - w) <= SCORE_TOLERANCE and abs(d[4] - h) <= SCORE_TOLERANCE), None)
        scores.append(round(score, 4) if score is not None else None)
    return scores


def read_marks(folder: Path, stem: str) -> list[dict]:
    path = folder / "marks" / f"{stem}.review.json"
    try:
        payload = json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return []
    marks = payload.get("marks") if isinstance(payload, dict) else None
    out = []
    for mark in marks if isinstance(marks, list) else []:
        if not isinstance(mark, dict):
            continue
        regions = mark.get("sliceRegions") if isinstance(mark.get("sliceRegions"), dict) else {}
        out.append({"categories": [str(c) for c in mark.get("categories") or [] if isinstance(c, str)],
                    "note": str(mark.get("note") or "")[:500],
                    "sliceIds": [str(s) for s in mark.get("sliceIds") or [] if isinstance(s, str)],
                    "sliceRegions": {str(k): v for k, v in regions.items()
                                     if isinstance(v, list) and len(v) == 4 and all(isinstance(n, (int, float)) for n in v)}})
    return out


def region_iou(a: list[float], b: slices.Crop) -> float:
    ax2, ay2 = a[0] + a[2], a[1] + a[3]
    bx2, by2 = b.left + b.width, b.top + b.height
    inter = max(0.0, min(ax2, bx2) - max(a[0], b.left)) * max(0.0, min(ay2, by2) - max(a[1], b.top))
    union = a[2] * a[3] + b.width * b.height - inter
    return inter / union if union > 0 else 0.0


def marks_for_slice(marks: list[dict], piece: slices.Slice) -> list[str]:
    """Categories of the marks that name this slice, by id or by a stored region (IoU >= 0.5, as in
    zira-web's resolveMarkedSlices, so a mark survives a re-detected layout)."""
    found = []
    for mark in marks:
        region = mark["sliceRegions"].get(piece.id)
        hit = piece.id in mark["sliceIds"] and (region is None or region_iou(region, piece.crop) >= 0.5)
        hit = hit or any(region_iou(r, piece.crop) >= 0.5 for r in mark["sliceRegions"].values())
        if hit:
            found.extend(mark["categories"] or ["Marked"])
    return sorted(set(found))


# ---------------------------------------------------------------- one frame (runs in a worker)

def process_frame(job: dict) -> dict:
    image_path, folder = Path(job["image"]), Path(job["session"])
    stem, suffix = image_path.stem, image_path.suffix.lower()
    text, source = reference_for(folder, stem, job["reference"])
    record = {"image": image_path.name, "session": session_id(folder), "labelSource": source}
    if source is None:
        return {**record, "skipped": "no-reference"}
    boxes = slices.parse_yolo(text)
    if not boxes:
        return {**record, "skipped": "no-labels"}
    try:
        frame = slices.open_frame(image_path)
    except OSError as error:
        return {**record, "skipped": f"unreadable: {error}"[:200]}
    width, height = frame.size
    record["size"] = [width, height]
    roots, split, maps = {k: Path(v) for k, v in job["roots"].items()}, job["split"], job["maps"]
    marks = read_marks(folder, stem)
    if marks:
        record["marks"] = sorted({c for m in marks for c in m["categories"]})
    # Camera confidence per label box; reviewer corrections are not the device's, so they get none.
    scores = device_scores(folder, stem, job["names"], boxes) if source == "device" else [None] * len(boxes)
    record["deviceScores"] = {}

    for output, size in (("pallets", job["palletSize"]), ("geometry", job["geometrySize"])):
        if output not in roots:
            continue
        name = f"{stem}{suffix}"
        slices.save_image(slices.render_stretched(frame, size), roots[output] / split / "images" / name, suffix)
        mapping = {int(k): v for k, v in maps[output].items()}
        written = slices.remap_yolo_text(text, mapping)
        (roots[output] / split / "labels" / f"{stem}.txt").write_text(written)
        kept = [s for box, s in zip(boxes, scores) if box[0] in mapping]
        if any(s is not None for s in kept) and len(kept) == len(slices.parse_yolo(written)):
            record["deviceScores"][f"{output}:{name}"] = kept

    if "nails" in roots:
        boards_ids, stringer_ids = set(job["boardIds"]), set(job["stringerIds"])
        nail_map = {int(k): v for k, v in maps["nails"].items()}
        boards, stringers, nails, nail_scores = [], [], [], []
        for box, score in zip(boxes, scores):
            region = slices.yolo_to_pixel(box, width, height)
            if box[0] in boards_ids:
                boards.append(region)
            if box[0] in stringer_ids:
                stringers.append(region)
            if box[0] in nail_map:
                nails.append((nail_map[box[0]], region))
                nail_scores.append((region, score))
        pieces = slices.compute_slices(boards, stringers, width, height, job["padding"], job["nailCropSize"], job["maxSlices"])
        record["slices"] = []
        for piece in pieces:
            name = f"{stem}__{piece.id}{suffix}"
            slices.save_image(slices.render_slice(frame, piece), roots["nails"] / split / "images" / name, suffix)
            labels = slices.slice_labels(nails, piece)
            (roots["nails"] / split / "labels" / f"{stem}__{piece.id}.txt").write_text(slices.format_yolo(labels))
            # slice_labels keeps the nails that overlap the crop, in order; the same test lines the scores up.
            bounds = slices.Region(piece.crop.left, piece.crop.top, piece.crop.left + piece.crop.width, piece.crop.top + piece.crop.height)
            kept = [s for region, s in nail_scores if slices.intersect(region, bounds) is not None]
            if any(s is not None for s in kept) and len(kept) == len(labels):
                record["deviceScores"][f"nails:{name}"] = kept
            entry = {"id": piece.id, "image": name, "crop": [piece.crop.left, piece.crop.top, piece.crop.width, piece.crop.height],
                     "scale": piece.scale, "content": [piece.scaled_width, piece.scaled_height],
                     "pad": [piece.pad_left, piece.pad_top], "boxes": len(labels)}
            marked = marks_for_slice(marks, piece)
            if marked:
                entry["marks"] = marked
            record["slices"].append(entry)
    return record


# ---------------------------------------------------------------- prepare

def find_frames(folder: Path) -> list[Path]:
    images = folder / "images"
    if not images.is_dir():
        raise EvalError(f"{folder} is not a session folder (no images/)")
    return sorted(p for p in images.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES)


def write_data_yaml(root: Path, names: list[str]) -> None:
    lines = ["train: ../train/images", "val: ../val/images", "test: ../test/images", f"nc: {len(names)}", "names:"]
    lines += [f"  - {json.dumps(n)}" for n in names]
    (root / "data.yaml").write_text("\n".join(lines) + "\n")


def class_plan(names: list[str], outputs: list[str], fixed: dict[str, list[str]]) -> dict:
    plan = {}
    for output in outputs:
        order = fixed.get(output) or slices.OUTPUT_ORDERS[output]
        plan[output] = slices.build_output_map(order, names, fixed=output in fixed)
    return plan


def prepare(sessions: list[str], out: str, name: str, outputs: list[str], split: str = "test", reference: str = "auto",
            nail_classes: list[str] | None = None, padding: float = slices.INTERSECTION_PADDING,
            max_slices: int = 300, workers: int | None = None, replace: bool = False, progress=None) -> dict:
    started = time.perf_counter()
    if not sessions:
        raise EvalError("give at least one --session folder")
    unknown = [o for o in outputs if o not in OUTPUTS]
    if unknown or not outputs:
        raise EvalError(f"outputs must be among {', '.join(OUTPUTS)}")
    if reference not in REFERENCES:
        raise EvalError(f"reference must be one of {', '.join(REFERENCES)}")
    if split not in ("train", "val", "test"):
        raise EvalError("split must be train, val or test")
    if not name or any(c in name for c in "/\\") or name.startswith("."):
        raise EvalError("name must be a plain folder name")
    folders = [Path(s).expanduser().resolve() for s in sessions]
    names = read_class_names(folders[0])
    for folder in folders[1:]:
        if read_class_names(folder) != names:
            raise EvalError(f"{folder} lists different classes in data.yaml than {folders[0]}; prepare them separately")
    plan = class_plan(names, outputs, {"nails": nail_classes} if nail_classes else {})

    out_dir = Path(out).expanduser().resolve()
    roots, staging = {}, {}
    for output in outputs:
        final = out_dir / f"{name}_{output}"
        if final.exists() and not replace:
            raise EvalError(f"{final} already exists; choose another --name or pass --replace")
        stage = out_dir / f".{name}_{output}.partial"
        if stage.exists():
            shutil.rmtree(stage)
        for kind in ("images", "labels"):
            (stage / split / kind).mkdir(parents=True)
        write_data_yaml(stage, plan[output][0])
        roots[output], staging[output] = final, stage

    frames, seen = [], {}
    for folder in folders:
        for image in find_frames(folder):
            if image.stem in seen:
                raise EvalError(f"frame {image.name} is in both {seen[image.stem]} and {session_id(folder)}")
            seen[image.stem] = session_id(folder)
            frames.append((folder, image))
    base = {"roots": {k: str(v) for k, v in staging.items()}, "split": split, "reference": reference, "names": names,
            "maps": {k: {str(s): d for s, d in v[1].items()} for k, v in plan.items()},
            "boardIds": sorted(slices.source_ids(names, slices.BOARD_SOURCE_NAMES)),
            "stringerIds": sorted(slices.source_ids(names, slices.STRINGER_SOURCE_NAMES)),
            "padding": padding, "nailCropSize": slices.NAIL_CROP_SIZE, "maxSlices": max_slices,
            "palletSize": slices.PALLET_SIZE, "geometrySize": slices.GEOMETRY_SIZE}
    jobs = [{**base, "image": str(image), "session": str(folder)} for folder, image in frames]
    progress = progress or (lambda *a, **k: None)
    progress("start", total=len(jobs), sessions=len(folders))
    records = []
    count = max(1, min(workers or (os.cpu_count() or 2) - 1, 8))
    if count == 1 or len(jobs) < 4:
        mapped = map(process_frame, jobs)
    else:
        pool = ProcessPoolExecutor(max_workers=count)
        mapped = pool.map(process_frame, jobs, chunksize=4)
    try:
        for index, record in enumerate(mapped, 1):
            records.append(record)
            progress("frame", done=index, total=len(jobs), image=record["image"])
    finally:
        if count > 1 and len(jobs) >= 4:
            pool.shutdown(cancel_futures=True)

    used = [r for r in records if "skipped" not in r]
    skipped = {}
    for r in records:
        if "skipped" in r:
            skipped[r["skipped"].split(":")[0]] = skipped.get(r["skipped"].split(":")[0], 0) + 1
    sources = {s: sum(1 for r in used if r["labelSource"] == s) for s in ("annotations", "device")}
    result = {"kind": "zira.session-datasets", "name": name, "split": split, "reference": reference,
              "sessions": [session_id(f) for f in folders], "sessionClasses": names,
              "frames": {"found": len(records), "used": len(used), **({"skipped": skipped} if skipped else {})},
              "labelSources": sources, "outputs": {}}
    for output in outputs:
        stage, final = staging[output], roots[output]
        if output == "nails":
            items = {f"{split}/images/{s['image']}": r["labelSource"] for r in used for s in r.get("slices", [])}
        else:
            items = {f"{split}/images/{r['image']}": r["labelSource"] for r in used}
        sidecar = {"format": REFERENCE_FORMAT, "version": 1, "output": output, "sessions": result["sessions"],
                   "reference": reference, "classes": plan[output][0],
                   "note": "Labels are reviewer corrections where present, otherwise the device models' own output (unverified).",
                   "labelSources": {s: sum(1 for v in items.values() if v == s) for s in ("annotations", "device")},
                   "images": items}
        # The camera's confidence per label line, for images whose inspection carried one.
        prefix = f"{output}:"
        scored = {f"{split}/images/{key[len(prefix):]}": values for r in used
                  for key, values in r.get("deviceScores", {}).items() if key.startswith(prefix)}
        if scored:
            sidecar["deviceScores"] = scored
        if output == "nails":
            sidecar["slices"] = {f"{split}/images/{s['image']}": {"frame": r["image"], "session": r["session"], **s}
                                 for r in used for s in r.get("slices", [])}
        (stage / "zira-reference.json").write_text(json.dumps(sidecar, separators=(",", ":")))
        if final.exists():
            shutil.rmtree(final)
        os.replace(stage, final)
        result["outputs"][output] = {"path": str(final), "images": len(items), "classes": plan[output][0],
                                     "labelSources": sidecar["labelSources"], "imagesWithDeviceScores": len(scored)}
    if "nails" in outputs:
        marked = sum(1 for r in used for s in r.get("slices", []) if s.get("marks"))
        result["outputs"]["nails"].update(frames=len(used), markedSlices=marked)
    result["elapsedSeconds"] = round(time.perf_counter() - started, 2)
    progress("done", frames=len(records))
    return result


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="session_datasets.py",
                                description="Build local pallets, geometry and nails datasets from QA snapshot session folders.",
                                epilog="Exit 0 done, 2 invalid input. Writes only under --out; nothing is sent to Zira.")
    p.add_argument("--session", action="append", default=[], help="session folder (<day>/<session>/ with images/ and data.yaml); repeatable")
    p.add_argument("--out", required=True, help="folder to create the datasets in")
    p.add_argument("--name", required=True, help="dataset name; outputs are <name>_pallets, <name>_geometry, <name>_nails")
    p.add_argument("--outputs", default="nails", help="comma-separated: pallets, geometry, nails (default nails)")
    p.add_argument("--split", default="test", help="split folder to write (default test: frames never trained on)")
    p.add_argument("--reference", default="auto", choices=REFERENCES,
                   help="labels to use: auto (reviewer correction, else device output), annotations only, or device output only")
    p.add_argument("--nail-classes", help="fixed nails class list, e.g. the model's (default: the platform's compact order)")
    p.add_argument("--padding", type=float, default=slices.INTERSECTION_PADDING, help="intersection padding per side (default 0.1)")
    p.add_argument("--max-slices", type=int, default=300, help="safety cap of nail slices per frame (default 300)")
    p.add_argument("--workers", type=int, help="parallel frames (default: CPU count - 1, at most 8)")
    p.add_argument("--replace", action="store_true", help="replace datasets of the same name in --out")
    p.add_argument("--progress", action="store_true", help="JSON-lines progress events on stderr")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    emit = (lambda event, **f: print(json.dumps({"event": event, **f}), file=sys.stderr, flush=True)) if args.progress else None
    try:
        result = prepare(args.session, args.out, args.name, [o.strip() for o in args.outputs.split(",") if o.strip()],
                         split=args.split, reference=args.reference,
                         nail_classes=[n.strip() for n in args.nail_classes.split(",") if n.strip()] if args.nail_classes else None,
                         padding=args.padding, max_slices=args.max_slices, workers=args.workers, replace=args.replace,
                         progress=emit)
    except EvalError as error:
        print(f"error: {error}", file=sys.stderr)
        return EXIT_INVALID
    print(json.dumps(result))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
