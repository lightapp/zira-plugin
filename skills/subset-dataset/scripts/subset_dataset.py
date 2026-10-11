#!/usr/bin/env python3
"""Zira dataset subset: pick at least N images containing each class from a dataset version.

Targets count images that contain a class, not boxes, so one image with several classes counts
toward each of them. Each class target is spread over train/val/test in proportion to where
that class appears (split mode "proportional"), so val and test stay populated; images keep
their split. Selection is greedy and deterministic for a given seed. `plan` previews; `create`
writes a new dataset ZIP in the version layout plus a manifest that records how it was made.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "evaluate-model" / "scripts"))
from model_evaluation import EvalError, SPLITS, file_sha256, load_dataset, read_labels  # noqa: E402

MANIFEST_FORMAT = "zira.dataset-subset.manifest"
MANIFEST_VERSION = 1
EXIT_OK, EXIT_INVALID = 0, 2


def parse_targets(text: str, names: list[str]) -> dict[int, int]:
    """'nail=200,raisedNail=150' or 'all=100'; class names match case-insensitively."""
    lookup = {n.lower(): i for i, n in enumerate(names)}
    targets: dict[int, int] = {}
    for part in filter(None, (p.strip() for p in str(text).split(","))):
        name, _, value = part.partition("=")
        if not value.strip().isdigit():
            raise EvalError(f"target {part!r} needs a whole number, for example nail=200")
        count = int(value)
        if name.strip().lower() == "all":
            for i in range(len(names)):
                targets.setdefault(i, count)
            continue
        if name.strip().lower() not in lookup:
            raise EvalError(f"unknown class {name.strip()!r}; this dataset has {', '.join(names)}")
        targets[lookup[name.strip().lower()]] = count
    if not any(targets.values()):
        raise EvalError("give at least one class target above 0, for example raisedNail=100")
    return targets


def _hash(seed: str, key: str) -> int:
    return int.from_bytes(hashlib.sha256(f"{seed}:{key}".encode()).digest()[:8], "big")


def allocate(target: int, available: dict[str, int]) -> dict[str, int]:
    """Largest-remainder split of one class target in proportion to availability per split."""
    total = sum(available.values())
    if not total or not target:
        return {s: 0 for s in available}
    target = min(target, total)
    raw = {s: target * n / total for s, n in available.items()}
    share = {s: min(int(v), available[s]) for s, v in raw.items()}
    for s in sorted(available, key=lambda s: (raw[s] - int(raw[s])), reverse=True):
        if sum(share.values()) >= target:
            break
        if share[s] < available[s]:
            share[s] += 1
    # Rounding can still leave a gap when a split is exhausted; fill from the others.
    for s in sorted(available, key=lambda s: available[s] - share[s], reverse=True):
        while sum(share.values()) < target and share[s] < available[s]:
            share[s] += 1
    return share


def solve(items: list[dict], targets: dict[int, int], seed: str) -> list[dict]:
    """Greedy cover: take the image that advances the most unmet classes, preferring less
    overshoot, ties broken by a seeded hash; then drop images that are no longer needed."""
    need = {c: t for c, t in targets.items() if t > 0}
    got = {c: 0 for c in need}
    pool = [i for i in items if any(c in need for c in i["classes"])]
    chosen: list[dict] = []
    taken: set[str] = set()
    while any(got[c] < need[c] for c in need):
        best, best_key = None, None
        for item in pool:
            if item["name"] in taken:
                continue
            gain = sum(1 for c in item["classes"] if c in need and got[c] < need[c])
            if not gain:
                continue
            over = sum(1 for c in item["classes"] if c in need and got[c] >= need[c])
            key = (-gain, over, _hash(seed, item["name"]))
            if best_key is None or key < best_key:
                best, best_key = item, key
        if best is None:
            break  # targets were capped to availability, so this means nothing more can help
        chosen.append(best)
        taken.add(best["name"])
        for c in best["classes"]:
            if c in got:
                got[c] += 1
    for item in list(reversed(chosen)):
        if all(got[c] - (1 if c in item["classes"] else 0) >= need[c] for c in need):
            chosen.remove(item)
            for c in item["classes"]:
                if c in got:
                    got[c] -= 1
    return chosen


def plan(dataset_path: Path, targets_text: str, split_mode: str = "proportional", seed: str = "zira-subset",
         use_available: bool = False, work_dir: Path | None = None) -> dict:
    dataset = load_dataset(dataset_path, "all", None, work_dir)
    names = dataset.class_names
    targets = parse_targets(targets_text, names)
    items, problems = [], 0
    for item in dataset.items:
        boxes, issues = read_labels(item.label, len(names))
        problems += bool(issues)
        items.append({"name": item.name, "split": item.split, "item": item, "classes": {b["classId"] for b in boxes},
                      "boxes": boxes})
    splits = [s for s in SPLITS if dataset.counts.get(s)]
    available = {c: {s: sum(1 for i in items if i["split"] == s and c in i["classes"]) for s in splits} for c in range(len(names))}
    shortfalls = [{"class": names[c], "requested": t, "available": sum(available[c].values())}
                  for c, t in targets.items() if t > sum(available[c].values())]
    effective = {c: min(t, sum(available[c].values())) for c, t in targets.items()}
    selected: list[dict] = []
    if split_mode == "proportional":
        for s in splits:
            per_split = {c: allocate(effective[c], available[c])[s] for c in effective}
            selected += solve([i for i in items if i["split"] == s], per_split, f"{seed}:{s}")
    elif split_mode == "keep":
        selected = solve(items, effective, seed)
    else:
        raise EvalError("split mode must be proportional or keep")
    achieved = {names[c]: {s: sum(1 for i in selected if i["split"] == s and c in i["classes"]) for s in splits} for c in range(len(names))}
    classes = []
    for c, name in enumerate(names):
        got = sum(achieved[name].values())
        requested = targets.get(c, 0)
        classes.append({"class": name, "requested": requested, "available": sum(available[c].values()),
                        "availableBySplit": available[c], "images": got, "imagesBySplit": achieved[name],
                        "boxes": sum(1 for i in selected for b in i["boxes"] if b["classId"] == c),
                        **({"overshoot": got - requested} if requested and got > requested else {}),
                        **({"short": requested - got} if requested > got else {})})
    selected.sort(key=lambda i: (SPLITS.index(i["split"]), i["name"]))
    return {
        "dataset": dataset, "selected": selected, "names": names, "targets": targets,
        "summary": {"kind": "dataset-subset-plan", "source": dataset_path.name, "splitMode": split_mode, "seed": seed,
                    "images": len(selected), "sourceImages": len(items),
                    "imagesBySplit": {s: sum(1 for i in selected if i["split"] == s) for s in splits},
                    "classes": classes, "complete": not shortfalls or use_available,
                    **({"shortfalls": shortfalls} if shortfalls else {}),
                    **({"labelProblems": problems} if problems else {})},
    }


def create(result: dict, out: Path, source: Path, name: str, source_id: str | None = None) -> dict:
    if out.exists():
        raise EvalError(f"refusing to overwrite {out}; choose another name")
    dataset, selected = result["dataset"], result["selected"]
    out.parent.mkdir(parents=True, exist_ok=True)
    partial = out.with_name(out.name + ".partial")
    manifest = {
        "format": MANIFEST_FORMAT, "version": MANIFEST_VERSION, "name": name,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": {"file": source.name, "sha256": file_sha256(source) if source.is_file() else None,
                   **({"versionId": source_id} if source_id else {})},
        "classNames": result["names"],
        "targets": {result["names"][c]: t for c, t in result["targets"].items()},
        "splitMode": result["summary"]["splitMode"], "seed": result["summary"]["seed"],
        "classes": result["summary"]["classes"], "imagesBySplit": result["summary"]["imagesBySplit"],
        "images": [{"split": i["split"], "image": i["name"]} for i in selected],
    }
    names = result["names"]
    data_yaml = "".join(f'{s}: "../{s}/images"\n' for s in result["summary"]["imagesBySplit"]) + \
        f"nc: {len(names)}\nnames:\n" + "".join(f"  - {json.dumps(n)}\n" for n in names)
    with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("data.yaml", data_yaml)
        for i in selected:
            item = i["item"]
            bundle.write(item.image, f"{item.split}/images/{item.image.name}")
            if item.label.is_file():
                bundle.write(item.label, f"{item.split}/labels/{item.label.name}")
        bundle.writestr("subset-manifest.json", json.dumps(manifest, indent=2))
    partial.replace(out)
    return {**result["summary"], "kind": "dataset-subset", "name": name, "zip": str(out), "sizeBytes": out.stat().st_size}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="subset_dataset.py", description="Plan or create a per-class subset of a dataset version.",
                                epilog="Exit 0 success, 2 invalid input or impossible request.")
    p.add_argument("command", choices=["plan", "create"])
    p.add_argument("--dataset", required=True, help="dataset version .zip or folder")
    p.add_argument("--min", required=True, dest="targets", help="images per class, e.g. nail=200,raisedNail=150 or all=100")
    p.add_argument("--split-mode", default="proportional", choices=["proportional", "keep"])
    p.add_argument("--seed", default="zira-subset")
    p.add_argument("--use-available", action="store_true", help="accept fewer images where a class has too few")
    p.add_argument("--name", help="new dataset name (create)")
    p.add_argument("--out", help="ZIP to write (create)")
    p.add_argument("--work-dir", help="where a .zip dataset is unpacked")
    p.add_argument("--source-id", help="Zira file ID of the source version, recorded in the manifest")
    args = p.parse_args(argv)
    try:
        source = Path(args.dataset).expanduser().resolve()
        result = plan(source, args.targets, args.split_mode, args.seed, args.use_available,
                      Path(args.work_dir).expanduser() if args.work_dir else None)
        if args.command == "plan":
            print(json.dumps(result["summary"]))
            return EXIT_OK
        if not args.name or not args.out:
            raise EvalError("create needs --name and --out")
        if not result["summary"]["complete"]:
            short = ", ".join(f"{s['class']} has {s['available']} of {s['requested']}" for s in result["summary"]["shortfalls"])
            raise EvalError(f"not enough images: {short}. Lower the targets or pass --use-available.")
        print(json.dumps(create(result, Path(args.out).expanduser(), source, args.name, args.source_id)))
        return EXIT_OK
    except EvalError as error:
        print(f"error: {error}", file=sys.stderr)
        return EXIT_INVALID


if __name__ == "__main__":
    sys.exit(main())
