"""Per-model inputs from full pallet frames, exactly as Zira's "Generate training datasets" builds them.

A Pallet Vision frame (about 3072 px) feeds three models: pallets (whole frame stretched to 320),
geometry (whole frame stretched to 1024) and nails (320 px slices around every board x stringer
intersection). This is a port of platform `src/prodVision/utils/datasetSplitUtils.ts`; zira-web's
`src/lib/visionhub/intersectionSlices.js` is the same algorithm. Slice geometry, ids
(`b<board>-s<stringer>`) and label text match those two exactly, and the test vectors of zira-web's
`docs/context/design/nail-crop-preprocessing-spec.md` are unit tests here. Resampling pixels uses
Pillow's Lanczos, which is close to but not byte-identical with sharp's lanczos3.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

PALLET_SIZE = 320
GEOMETRY_SIZE = 1024
NAIL_CROP_SIZE = 320
INTERSECTION_PADDING = 0.1

# Canonical, compact output taxonomies. `leadBoard` folds into `board`; unknown names are dropped.
PALLETS_ORDER = ["pallet"]
GEOMETRY_ORDER = ["pallet", "board", "boardCluster", "brokenBoard", "stringer"]
# `raisedNail` is a reviewer-added class and stays last, so older nails datasets keep their ids.
NAILS_ORDER = ["nail", "protrudeNail", "flushNail", "raisedNail"]
BOARD_SOURCE_NAMES = {"board", "leadBoard", "boardCluster", "brokenBoard"}
STRINGER_SOURCE_NAMES = {"stringer"}
BOARD_ALIAS_NAME = "leadBoard"
OUTPUT_ORDERS = {"pallets": PALLETS_ORDER, "geometry": GEOMETRY_ORDER, "nails": NAILS_ORDER}


@dataclass(frozen=True)
class Region:
    left: float
    top: float
    right: float
    bottom: float


@dataclass(frozen=True)
class Crop:
    left: int
    top: int
    width: int
    height: int


@dataclass(frozen=True)
class Slice:
    """One nail crop: where it sits in the frame and how it was letterboxed onto the canvas."""
    id: str
    board: int
    stringer: int
    crop: Crop
    scale: float
    scaled_width: int
    scaled_height: int
    pad_left: int
    pad_top: int
    target: int


# ---------------------------------------------------------------- class taxonomy

def build_output_map(order: list[str], source_names: list[str], fixed: bool = False) -> tuple[list[str], dict[int, int]]:
    """Destination names and a source-id -> destination-id map.

    By default the names are compacted to the classes the source has, as the platform does. With
    `fixed` the order is kept whole, so ids line up with a model trained on exactly those classes."""
    has = set(source_names)
    present = (lambda name: True) if fixed else (
        lambda name: ("board" in has or BOARD_ALIAS_NAME in has) if name == "board" else name in has)
    names = [name for name in order if present(name)]
    index = {name: i for i, name in enumerate(names)}
    mapping = {}
    for source_id, name in enumerate(source_names):
        target = "board" if name == BOARD_ALIAS_NAME and "board" in order else name if name in order else None
        if target is not None and target in index:
            mapping[source_id] = index[target]
    return names, mapping


def source_ids(source_names: list[str], wanted: set[str]) -> set[int]:
    return {i for i, name in enumerate(source_names) if name in wanted}


# ---------------------------------------------------------------- YOLO geometry

def parse_yolo(text: str) -> list[tuple[int, float, float, float, float]]:
    """Lines with five finite numbers; anything else is skipped, as the platform does."""
    boxes = []
    for line in str(text or "").splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        try:
            values = [float(v) for v in parts[:5]]
        except ValueError:
            continue
        if not all(math.isfinite(v) for v in values) or not values[0].is_integer():
            continue
        boxes.append((int(values[0]), *values[1:]))
    return boxes


def yolo_to_pixel(box, width: int, height: int) -> Region:
    _, x, y, w, h = box
    return Region((x - w / 2) * width, (y - h / 2) * height, (x + w / 2) * width, (y + h / 2) * height)


def to_fixed(value: float, digits: int = 6) -> str:
    """JavaScript's Number.prototype.toFixed: exact binary value, ties away from zero, no -0."""
    text = str(Decimal(value).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))
    return text[1:] if text.startswith("-") and not text.strip("-0.") else text


def format_yolo(boxes: list[tuple[int, float, float, float, float]]) -> str:
    lines = [" ".join([str(int(b[0]))] + [to_fixed(v) for v in b[1:]]) for b in boxes]
    return "\n".join(lines) + ("\n" if lines else "")


def remap_yolo_text(text: str, mapping: dict[int, int]) -> str:
    """Class-id remap that keeps the coordinate text as written (platform remapYoloContentForCopy)."""
    out = []
    for line in str(text or "").splitlines():
        parts = line.split()
        if not parts:
            continue
        try:
            source = float(parts[0])
        except ValueError:
            continue
        if not source.is_integer() or int(source) not in mapping:
            continue
        parts[0] = str(mapping[int(source)])
        out.append(" ".join(parts))
    return "\n".join(out) + ("\n" if out else "")


def intersect(a: Region, b: Region) -> Region | None:
    left, top = max(a.left, b.left), max(a.top, b.top)
    right, bottom = min(a.right, b.right), min(a.bottom, b.bottom)
    return Region(left, top, right, bottom) if right > left and bottom > top else None


def make_intersection_crop(region: Region, padding: float, width: int, height: int) -> Crop:
    """The intersection padded by `padding` of its own size per side, rounded outward, clamped."""
    rw, rh = region.right - region.left, region.bottom - region.top
    left = max(0, math.floor(region.left - padding * rw))
    top = max(0, math.floor(region.top - padding * rh))
    right = min(width, math.ceil(region.right + padding * rw))
    bottom = min(height, math.ceil(region.bottom + padding * rh))
    return Crop(left, top, max(1, right - left), max(1, bottom - top))


def letterbox(crop: Crop, target: int) -> tuple[float, int, int, int, int]:
    """Scale (downscale only), scaled size and the floor-biased black padding on a target square."""
    scale = min(1.0, target / crop.width, target / crop.height)
    scaled_width = max(1, js_round(crop.width * scale))
    scaled_height = max(1, js_round(crop.height * scale))
    return scale, scaled_width, scaled_height, (target - scaled_width) // 2, (target - scaled_height) // 2


def js_round(value: float) -> int:
    """Math.round: halves go up (toward +infinity), unlike Python's banker's rounding."""
    return math.floor(value + 0.5)


def sort_regions_in_layout_order(regions: list[Region]) -> list[Region]:
    """Wide deck boards stack top to bottom, tall stringers run left to right; ties break on edges."""
    span_x = sum(r.right - r.left for r in regions)
    span_y = sum(r.bottom - r.top for r in regions)
    if span_x >= span_y:
        return sorted(regions, key=lambda r: (r.top, r.left, r.bottom, r.right))
    return sorted(regions, key=lambda r: (r.left, r.top, r.right, r.bottom))


def compute_slices(boards: list[Region], stringers: list[Region], width: int, height: int,
                   padding: float = INTERSECTION_PADDING, target: int = NAIL_CROP_SIZE,
                   max_slices: int | None = None) -> list[Slice]:
    """Every board x stringer pair that overlaps, in layout order, board-major."""
    slices = []
    ordered_boards, ordered_stringers = sort_regions_in_layout_order(boards), sort_regions_in_layout_order(stringers)
    for bi, board in enumerate(ordered_boards):
        for si, stringer in enumerate(ordered_stringers):
            if max_slices is not None and len(slices) >= max_slices:
                return slices
            region = intersect(board, stringer)
            if region is None:
                continue
            crop = make_intersection_crop(region, padding, width, height)
            scale, sw, sh, pad_left, pad_top = letterbox(crop, target)
            slices.append(Slice(f"b{bi}-s{si}", bi, si, crop, scale, sw, sh, pad_left, pad_top, target))
    return slices


def slice_labels(nails: list[tuple[int, Region]], piece: Slice) -> list[tuple[int, float, float, float, float]]:
    """Nail boxes clipped to the crop (any overlap counts), moved onto the canvas, YOLO-normalized."""
    crop, canvas = piece.crop, piece.target
    bounds = Region(crop.left, crop.top, crop.left + crop.width, crop.top + crop.height)
    labels = []
    for class_id, nail in nails:
        clipped = intersect(nail, bounds)
        if clipped is None:
            continue
        left = piece.pad_left + (clipped.left - crop.left) * piece.scale
        top = piece.pad_top + (clipped.top - crop.top) * piece.scale
        right = piece.pad_left + (clipped.right - crop.left) * piece.scale
        bottom = piece.pad_top + (clipped.bottom - crop.top) * piece.scale
        labels.append((class_id, (left + right) / 2 / canvas, (top + bottom) / 2 / canvas,
                       (right - left) / canvas, (bottom - top) / canvas))
    return labels


def slice_box_to_frame(box: dict, piece: Slice, width: int, height: int) -> dict | None:
    """A detection on the slice canvas (normalized xywh) back in frame coordinates (normalized
    xywh), clipped to the crop; None when it lies only on the black padding."""
    canvas = piece.target
    x1, y1 = (box["x"] - box["w"] / 2) * canvas, (box["y"] - box["h"] / 2) * canvas
    x2, y2 = (box["x"] + box["w"] / 2) * canvas, (box["y"] + box["h"] / 2) * canvas
    to_frame_x = lambda v: piece.crop.left + (v - piece.pad_left) / piece.scale
    to_frame_y = lambda v: piece.crop.top + (v - piece.pad_top) / piece.scale
    crop = piece.crop
    region = intersect(Region(to_frame_x(x1), to_frame_y(y1), to_frame_x(x2), to_frame_y(y2)),
                       Region(crop.left, crop.top, crop.left + crop.width, crop.top + crop.height))
    if region is None:
        return None
    return {**box, "x": (region.left + region.right) / 2 / width, "y": (region.top + region.bottom) / 2 / height,
            "w": (region.right - region.left) / width, "h": (region.bottom - region.top) / height}


# ---------------------------------------------------------------- pixels

def open_frame(path):
    """Decoded RGB frame with EXIF orientation applied and any alpha flattened onto black."""
    from PIL import Image, ImageOps

    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened)
        if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
            rgba = image.convert("RGBA")
            background = Image.new("RGBA", rgba.size, (0, 0, 0, 255))
            return Image.alpha_composite(background, rgba).convert("RGB")
        return image.convert("RGB")


def render_slice(frame, piece: Slice):
    from PIL import Image

    crop = piece.crop
    region = frame.crop((crop.left, crop.top, crop.left + crop.width, crop.top + crop.height))
    if piece.scale < 1:
        region = region.resize((piece.scaled_width, piece.scaled_height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (piece.target, piece.target), (0, 0, 0))
    canvas.paste(region, (piece.pad_left, piece.pad_top))
    return canvas


def render_stretched(frame, size: int):
    from PIL import Image

    return frame.resize((size, size), Image.Resampling.LANCZOS)


def save_image(image, path, suffix: str) -> None:
    """Same format as the source frame, with the platform's quality settings."""
    suffix = suffix.lower()
    if suffix == ".png":
        image.save(path, format="PNG", compress_level=6)
    elif suffix == ".webp":
        image.save(path, format="WEBP", quality=90)
    else:
        image.save(path, format="JPEG", quality=90)
