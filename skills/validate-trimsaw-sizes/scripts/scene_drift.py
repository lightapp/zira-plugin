#!/usr/bin/env python3
"""Camera view over time: did a trimsaw camera's view move between its raw recordings?

For each clip, the median of about 300 frames spread over the clip is its scene snapshot: boards
moving through the picture drop out, while the floor, the machine and the stops stay. Where the
frames vary over time marks what moves. Each snapshot is registered to the reference snapshot on
steady texture only: 96 px patches every 40 px, Hann-windowed phase correlation of the gradient
magnitude with a sub-pixel peak, then a robust weighted least-squares similarity fit (shift,
rotation, scale). The transform is then expressed where it matters: along the stop axis of the
camera's 320 px analysis frame, at each stop line, and as the length change a board at that stop
would read (positive reads longer).

The analysis frame is the clip as displayed (its rotation metadata applied, or 90 degrees clockwise
for a landscape clip without it, the Vision-App RAW rule) letterboxed into a 320 px box. A 640x360
RAW clip becomes a 180x320 picture, so analysis y = raw x / 2 and a raw shift of d px moves board
ends d / 2 analysis px. The camera's small deskew (analysisFrameRotationDegrees) is ignored.

usage: python -I scene_drift.py --out DIR [--reference CLIP] [--stops JSON] [--in-per-px F]
       [--stop-side TOP|BOTTOM|LEFT|RIGHT] [--samples N] [--rotation auto|0|90|180|270]
       [--progress] CLIP [CLIP ...]

Writes DIR/scene.json and PNG snapshots, edge overlays and zooms (owner-only files) and prints a
JSON summary. Exit 0 done, 2 invalid input or failure, 3 some clips could not be read.
Decoding needs PyAV; the registration and geometry need only NumPy, and PNG output Pillow.
"""
import argparse
import json
import math
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

VERSION = 1
ANALYSIS_SIZE = 320
SAMPLES = 300
PATCH = 96
STEP = 40
MIN_PEAK = 0.15
STATIC_SHARE = 0.85
MOTION_PERCENTILE = 70  # the 30% of pixels that vary most over the clip count as moving…
MOTION_FLOOR = 8.0  # …unless they vary less than this (gray levels), as in an idle, noise-free view
MIN_TEXTURE = 2.0
STEADY_PX = 0.5  # analysis px along the stop axis; less than this changes nothing that matters
MIN_PATCHES = 8
MAX_RMS_PX = 0.6  # raw px
REGION_TOLERANCE_PX = 0.5  # analysis px of disagreement with the fitted motion
REGION_MIN_PATCHES = 3
SIDES = {"TOP": ("FRAME_Y", -1), "BOTTOM": ("FRAME_Y", 1), "LEFT": ("FRAME_X", -1), "RIGHT": ("FRAME_X", 1)}
# `[RAW_]yyyyMMdd_HHmmss_SSS[_partNNN].mp4`, optionally behind the Videos tab's `day_session_` prefix.
NAME = re.compile(r"^(?:\d{4}-\d{2}-\d{2}_\d{4}(?:-\d{2}){5}_)?(?:RAW_)?(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_\d{3}(?:_part(\d{3}))?\.mp4$", re.I)


class InputError(ValueError):
    pass


def recorded_at(name):
    """Site-local start of a raw recording from its name (…_20261019_085145_119_part001.mp4)."""
    m = NAME.match(os.path.basename(str(name)))
    if not m:
        return None
    y, mo, d, h, mi, s = (int(v) for v in m.groups()[:6])
    try:
        return datetime(y, mo, d, h, mi, s).strftime("%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None


# ---------- geometry: raw clip pixels to the camera's analysis frame ----------

class Mapping:
    """Raw pixel (x, y) to the displayed picture (rotated clockwise) letterboxed into the analysis box."""

    def __init__(self, width, height, rotation=90, size=ANALYSIS_SIZE):
        if rotation % 90:
            raise InputError("rotation must be 0, 90, 180 or 270")
        self.width, self.height, self.rotation, self.size = int(width), int(height), rotation % 360, size
        dw, dh = (self.height, self.width) if self.rotation in (90, 270) else (self.width, self.height)
        self.display = (dw, dh)
        self.scale = size / max(dw, dh)
        self.pad = ((size - dw * self.scale) / 2, (size - dh * self.scale) / 2)

    def to_display(self, x, y):
        w, h, r = self.width, self.height, self.rotation
        if r == 90:
            return h - y, x
        if r == 180:
            return w - x, h - y
        if r == 270:
            return y, w - x
        return x, y

    def from_display(self, u, v):
        w, h, r = self.width, self.height, self.rotation
        if r == 90:
            return v, h - u
        if r == 180:
            return w - u, h - v
        if r == 270:
            return w - v, u
        return u, v

    def to_analysis(self, x, y):
        u, v = self.to_display(x, y)
        return self.pad[0] + u * self.scale, self.pad[1] + v * self.scale

    def from_analysis(self, ax, ay):
        return self.from_display((ax - self.pad[0]) / self.scale, (ay - self.pad[1]) / self.scale)

    def display_image(self, img):
        return np.rot90(img, k=-(self.rotation // 90)) if self.rotation else img

    def describe(self):
        return {"rawSize": [self.width, self.height], "rotation": self.rotation, "displaySize": list(self.display),
                "analysisSize": self.size, "scale": round(self.scale, 6), "padding": [round(p, 3) for p in self.pad]}


def stop_layout(stops, side=None):
    """Axis, reading sign and how the side was decided. Stops on the low side (TOP, LEFT) read shorter
    when their board ends move toward the blade (+), stops on the high side read longer."""
    if side:
        side = side.upper()
        if side not in SIDES:
            raise InputError("--stop-side is TOP, BOTTOM, LEFT or RIGHT")
        axis, sign = SIDES[side]
        return {"axis": axis, "stopSide": side, "sign": sign, "sideSource": "given"}
    pts = sorted((float(k), float(v)) for k, v in (stops or {}).items())
    if len({s for s, _ in pts}) >= 2:
        sizes = np.array([s for s, _ in pts])
        pos = np.array([p for _, p in pts])
        slope = float(np.polyfit(sizes, pos, 1)[0])
        if abs(slope) > 1e-6:
            side = "TOP" if slope < 0 else "BOTTOM"
            return {"axis": "FRAME_Y", "stopSide": side, "sign": SIDES[side][1], "sideSource": "stops"}
    return {"axis": "FRAME_Y", "stopSide": None, "sign": None, "sideSource": None}


def parse_stops(text):
    if text in (None, ""):
        return None
    try:
        raw = json.loads(text)
    except ValueError as error:
        raise InputError(f"--stops is a JSON object such as {{\"42\": 126.9}}: {error}") from None
    if not isinstance(raw, dict) or not raw:
        raise InputError("--stops is a JSON object of stop size to analysis px, such as {\"42\": 126.9}")
    stops = {}
    for k, v in raw.items():
        try:
            size, pos = float(k), float(v)
        except (TypeError, ValueError):
            raise InputError(f"--stops entry {k}: {v} is not a size and a position") from None
        if not (0 < size < 1000) or not (-ANALYSIS_SIZE <= pos <= 2 * ANALYSIS_SIZE) or not math.isfinite(pos):
            raise InputError(f"--stops entry {k}: {v} is outside the analysis frame")
        stops[k] = pos
    return stops


# ---------- image operations (NumPy only) ----------

def blur(a, sigma=1.5):
    r = int(math.ceil(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    p = np.pad(a, ((r, r), (0, 0)), mode="reflect")
    a = sum(k[i] * p[i:i + a.shape[0]] for i in range(2 * r + 1))
    p = np.pad(a, ((0, 0), (r, r)), mode="reflect")
    return sum(k[i] * p[:, i:i + a.shape[1]] for i in range(2 * r + 1))


def gradmag(gray):
    gy, gx = np.gradient(blur(np.asarray(gray, dtype=np.float64)))
    return np.hypot(gx, gy)


def phase_corr(a, b):
    """Shift (dx, dy) that moves patch a onto patch b, sub-pixel, and the correlation peak (0-1)."""
    win = np.outer(np.hanning(a.shape[0]), np.hanning(a.shape[1]))
    fa = np.fft.fft2((a - a.mean()) * win)
    fb = np.fft.fft2((b - b.mean()) * win)
    r = fb * np.conj(fa)
    r /= np.abs(r) + 1e-9
    corr = np.real(np.fft.ifft2(r))
    iy, ix = np.unravel_index(np.argmax(corr), corr.shape)

    def sub(m, c):
        y0, y1, y2 = m[(c - 1) % len(m)], m[c], m[(c + 1) % len(m)]
        d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) + 1e-12)
        return c + (d if abs(d) < 1 else 0)

    fy, fx = sub(corr[:, ix], iy), sub(corr[iy, :], ix)
    h, w = corr.shape
    if fy > h / 2:
        fy -= h
    if fx > w / 2:
        fx -= w
    return float(fx), float(fy), float(corr[iy, ix])


def register(ref_g, cur_g, static, patch=PATCH, step=STEP):
    """Similarity transform (about the matched patches' centroid) taking the reference onto the clip.
    Returns None with fewer than four matched steady patches."""
    h, w = ref_g.shape
    pts, shifts, peaks = [], [], []
    for y in range(0, h - patch + 1, step):
        for x in range(0, w - patch + 1, step):
            if static[y:y + patch, x:x + patch].mean() < STATIC_SHARE:
                continue
            a, b = ref_g[y:y + patch, x:x + patch], cur_g[y:y + patch, x:x + patch]
            if a.std() < MIN_TEXTURE:
                continue
            dx, dy, peak = phase_corr(a, b)
            if peak < MIN_PEAK or abs(dx) > patch / 4 or abs(dy) > patch / 4:
                continue
            pts.append((x + patch / 2, y + patch / 2))
            shifts.append((dx, dy))
            peaks.append(peak)
    if len(pts) < 4:
        return None
    pts, sh, wts = np.array(pts), np.array(shifts), np.array(peaks)
    keep = np.ones(len(pts), bool)
    for _ in range(4):
        # x' = a x - b y + tx ; y' = b x + a y + ty, about the kept patches' centroid
        c = pts[keep].mean(axis=0)
        X = pts - c
        k = keep
        n = int(k.sum())
        A = np.zeros((2 * n, 4))
        A[0::2, 0], A[0::2, 1], A[0::2, 2] = X[k, 0], -X[k, 1], 1
        A[1::2, 0], A[1::2, 1], A[1::2, 3] = X[k, 1], X[k, 0], 1
        rhs = np.empty(2 * n)
        rhs[0::2], rhs[1::2] = X[k, 0] + sh[k, 0], X[k, 1] + sh[k, 1]
        sw = np.repeat(np.sqrt(wts[k]), 2)
        (a, b, tx, ty), *_ = np.linalg.lstsq(A * sw[:, None], rhs * sw, rcond=None)
        pred = np.stack([a * X[:, 0] - b * X[:, 1] + tx - X[:, 0], b * X[:, 0] + a * X[:, 1] + ty - X[:, 1]], 1)
        res = np.hypot(*(pred - sh).T)
        new = res < max(0.6, 2.5 * float(np.median(res[keep])))
        if new.sum() < 4 or (new == keep).all():
            break
        keep = new
    return {"center": [float(v) for v in c], "a": float(a), "b": float(b), "tx": float(tx), "ty": float(ty),
            "scale": math.hypot(a, b), "rotDeg": math.degrees(math.atan2(b, a)), "patches": int(keep.sum()), "of": len(pts),
            "rmsPx": float(np.sqrt((res[keep] ** 2).mean())),
            "patchList": [{"x": float(x), "y": float(y), "dx": float(dx), "dy": float(dy), "peak": float(p), "kept": bool(kk)}
                          for (x, y), (dx, dy), p, kk in zip(pts, sh, wts, keep)]}


def apply(t, x, y):
    cx, cy = t["center"]
    X, Y = x - cx, y - cy
    return t["a"] * X - t["b"] * Y + t["tx"] + cx, t["b"] * X + t["a"] * Y + t["ty"] + cy


IDENTITY = {"center": [0.0, 0.0], "a": 1.0, "b": 0.0, "tx": 0.0, "ty": 0.0, "scale": 1.0, "rotDeg": 0.0,
            "patches": 0, "of": 0, "rmsPx": 0.0, "patchList": []}


def axis_shift(t, mapping, axis, ax, ay):
    """Analysis px the transform moves the analysis point (ax, ay) along the axis."""
    x, y = mapping.from_analysis(ax, ay)
    nx, ny = apply(t, x, y)
    bx, by = mapping.to_analysis(nx, ny)
    return (by - ay) if axis == "FRAME_Y" else (bx - ax)


def point_on_axis(mapping, axis, position):
    centre_x = mapping.pad[0] + mapping.display[0] * mapping.scale / 2
    centre_y = mapping.pad[1] + mapping.display[1] * mapping.scale / 2
    return (centre_x, position) if axis == "FRAME_Y" else (position, centre_y)


def regions(t, mapping, axis):
    """Left, middle and right thirds of the displayed picture: how far each moved along the stop axis,
    and by how much that differs from the fitted motion of the whole view."""
    x0 = mapping.pad[0]
    width = mapping.display[0] * mapping.scale
    out = []
    for i, name in enumerate(("left", "middle", "right")):
        moved, resid, kept = [], [], 0
        for p in t["patchList"]:
            ax, ay = mapping.to_analysis(p["x"], p["y"])
            if not (x0 + i * width / 3 <= ax < x0 + (i + 1) * width / 3 or (i == 2 and ax == x0 + width)):
                continue
            bx, by = mapping.to_analysis(p["x"] + p["dx"], p["y"] + p["dy"])
            actual = (by - ay) if axis == "FRAME_Y" else (bx - ax)
            moved.append(actual)
            resid.append(actual - axis_shift(t, mapping, axis, ax, ay))
            kept += p["kept"]
        out.append({"region": name, "patches": len(moved), "kept": kept,
                    "shiftPx": rounded(np.median(moved)) if moved else None,
                    "residualPx": rounded(np.median(resid)) if resid else None})
    return out


def verdict(t, region_list, shift):
    """steady, view_moved (the whole recorded view moved together), part_moved or uncertain."""
    if t is None:
        return "uncertain", "Fewer than 4 steady details matched the reference, so the view cannot be compared."
    if t["patches"] < MIN_PATCHES:
        return "uncertain", f"Only {t['patches']} steady details matched the reference; at least {MIN_PATCHES} are needed."
    if t["rmsPx"] > MAX_RMS_PX:
        return "uncertain", f"The matched details disagree by {t['rmsPx']:.2f} px rms (more than {MAX_RMS_PX}), so no single motion fits."
    off = [r for r in region_list if r["patches"] >= REGION_MIN_PATCHES and r["residualPx"] is not None
           and abs(r["residualPx"]) >= REGION_TOLERANCE_PX]
    if off and sum(r["patches"] >= REGION_MIN_PATCHES for r in region_list) >= 2:
        worst = max(off, key=lambda r: abs(r["residualPx"]))
        return "part_moved", (f"The {worst['region']} third moved {worst['shiftPx']:+.2f} px along the stop axis, "
                              f"{abs(worst['residualPx']):.2f} px unlike the rest of the view: part of the picture moved, not the whole view.")
    if abs(shift) >= STEADY_PX:
        return "view_moved", (f"The whole recorded view moved together by {shift:+.2f} px along the stop axis "
                              f"({t['patches']} of {t['of']} steady details agree). Compare the readings at the same times "
                              "before concluding the camera moved.")
    return "steady", f"The view moved {shift:+.2f} px along the stop axis, under {STEADY_PX} px."


# ---------- decoding (PyAV) ----------

def frame_rotation(frame):
    """Clockwise display rotation from the frame's display matrix, or None without one."""
    try:
        has_matrix = any("DISPLAYMATRIX" in str(getattr(sd, "type", "")) for sd in frame.side_data)
    except Exception:  # noqa: BLE001 - older or unusual containers
        has_matrix = False
    if not has_matrix:
        return None
    try:
        return int(round(-float(frame.rotation))) % 360  # FFmpeg reports counterclockwise degrees
    except Exception:  # noqa: BLE001
        return None


def decode_snapshot(path, samples=SAMPLES):
    """Median RGB snapshot, per-pixel temporal spread (motion), frame counts and rotation metadata."""
    import av  # imported here so the registration can be used and tested without PyAV

    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        total = int(stream.frames or 0)
        stride = max(1, total // samples) if total else 1
        kept, n, first, last, rotation = [], 0, None, None, None
        for frame in container.decode(stream):
            if n == 0:
                rotation = frame_rotation(frame)
            if frame.time is not None:
                first = frame.time if first is None else first
                last = frame.time
            if n % stride == 0:
                kept.append(frame.to_ndarray(format="rgb24"))
                if not total and len(kept) > 2 * samples:  # unknown length: thin out, keep the spread
                    kept, stride = kept[::2], stride * 2
            n += 1
    if not kept:
        raise InputError("no video frames")
    stack = np.stack(kept)
    del kept
    median = np.empty(stack.shape[1:], np.uint8)
    for c in range(3):
        median[..., c] = np.median(stack[..., c], axis=0).astype(np.uint8)
    total_g = np.zeros(stack.shape[1:3])
    total_g2 = np.zeros(stack.shape[1:3])
    for f in stack:
        g = f.mean(axis=2)
        total_g += g
        total_g2 += g * g
    m = len(stack)
    motion = np.sqrt(np.maximum(total_g2 / m - (total_g / m) ** 2, 0))
    seconds = (last - first) if first is not None and last is not None else None
    return {"median": median, "motion": motion, "frames": n, "framesUsed": m,
            "seconds": round(float(seconds), 1) if seconds is not None else None, "rotation": rotation,
            "size": [int(stack.shape[2]), int(stack.shape[1])]}


# ---------- output ----------

def private_dir(path):
    path = Path(path)
    if not path.exists():
        path.mkdir(parents=True, mode=0o700)
    return path


def save_png(path, array):
    from PIL import Image

    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        Image.fromarray(np.ascontiguousarray(array)).save(fh, format="PNG", optimize=True)
    os.chmod(path, 0o600)


def thumbnail(rgb, long_side=ANALYSIS_SIZE):
    from PIL import Image

    img = Image.fromarray(np.ascontiguousarray(rgb))
    factor = long_side / max(img.size)
    if factor < 1:
        img = img.resize((max(1, round(img.size[0] * factor)), max(1, round(img.size[1] * factor))), Image.Resampling.BOX)
    return np.asarray(img)


def edge_overlay(ref_g, cur_g):
    """Reference edges red, this clip's edges cyan, both white."""
    e1 = ref_g / (np.percentile(ref_g, 99) + 1e-9)
    e2 = cur_g / (np.percentile(cur_g, 99) + 1e-9)
    return np.clip(np.stack([e1, e2, e2], 2) * 255, 0, 255).astype(np.uint8)


def zoom(overlay, t, mapping, factor=3, patch=PATCH):
    """The best-matching steady patch of the overlay, enlarged so a pixel or two of shift shows."""
    best = max((p for p in t["patchList"] if p["kept"]), key=lambda p: p["peak"], default=None)
    if best is None:
        return None
    h, w = overlay.shape[:2]
    x0 = int(min(max(best["x"] - patch / 2, 0), w - patch))
    y0 = int(min(max(best["y"] - patch / 2, 0), h - patch))
    crop = mapping.display_image(overlay[y0:y0 + patch, x0:x0 + patch])
    return np.repeat(np.repeat(crop, factor, axis=0), factor, axis=1)


def safe_stem(name):
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(name).stem)[:120]
    return stem or "clip"


def write_json(path, data):
    tmp = f"{path}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1)
    os.replace(tmp, path)
    os.chmod(path, 0o600)


# ---------- analysis ----------

def rounded(v, d=2):
    return None if v is None else round(float(v), d) + 0.0  # + 0.0 turns -0.0 into 0.0


def summarize(clips, layout, in_per_px):
    """One verdict for the whole set and a plain-words sentence for the report."""
    compared = [c for c in clips if not c["reference"] and c["verdict"] in ("steady", "view_moved", "part_moved")]
    uncertain = [c for c in clips if not c["reference"] and c["verdict"] == "uncertain"]
    turned = [c for c in compared if c["verdict"] == "view_moved"]
    part = [c for c in compared if c["verdict"] == "part_moved"]
    inches = in_per_px is not None
    if not compared:
        return {"verdict": "uncertain", "compared": 0, "uncertain": len(uncertain), "maxShiftPx": None, "spreadPx": None,
                "maxReadsIn": None, "spreadIn": None, "largest": None,
                "sentence": "The recordings could not be compared reliably (too few steady details matched, or the picture "
                            "changed), so this check cannot say whether the camera moved."}
    largest = max(compared, key=lambda c: abs(c["shiftPx"]))
    shifts = [0.0] + [c["shiftPx"] for c in compared]
    spread = max(shifts) - min(shifts)
    spread_in = spread * in_per_px if inches else None
    amount = f"{spread:.1f} px ({spread_in:.2f} in.)" if inches else f"{spread:.1f} px of the 320 px analysis frame"
    if turned:
        sentence = (f"The whole recorded view shifted up to {amount} between recordings. A camera that moved shifts "
                    "every stop's readings by about that much in the same direction at the same times; compare the "
                    "readings before suggesting a mount fix.")
        if part:
            sentence += " Some recordings also show only part of the picture moving."
        overall = "view_moved"
    elif part:
        worst = max(part, key=lambda c: max((abs(r["residualPx"] or 0) for r in c["regions"]), default=0))
        region = max(worst["regions"], key=lambda r: abs(r["residualPx"] or 0))
        sentence = (f"Part of the picture moved between recordings (the {region['region']} third, {region['shiftPx']:+.1f} px) "
                    "while the rest stayed: something in view moved, not the whole camera. Check what changed there.")
        overall = "part_moved"
    else:
        sentence = (f"The camera view stayed steady: the recordings differ by at most {amount} along the stop axis, "
                    f"under the {STEADY_PX} px that would change readings.")
        overall = "steady"
    if uncertain:
        sentence += f" {len(uncertain)} recording{'s' if len(uncertain) > 1 else ''} could not be compared."
    max_in = largest.get("readsIn")
    return {"verdict": overall, "compared": len(compared), "uncertain": len(uncertain), "cameraTurned": len(turned),
            "partMoved": len(part), "maxShiftPx": largest["shiftPx"], "maxReadsIn": max_in,
            "spreadPx": round(spread, 2), "spreadIn": rounded(spread_in), "largest": largest["clip"], "sentence": sentence}


def analyze(clips, out_dir, reference=None, stops=None, in_per_px=None, stop_side=None, samples=SAMPLES,
            rotation="auto", progress=None, decoder=decode_snapshot):
    clips = [str(c) for c in clips]
    if len(clips) < 2:
        raise InputError("give at least two clips: a reference and one to compare")
    if len({os.path.basename(c) for c in clips}) != len(clips):
        raise InputError("clip file names must be unique")
    for c in clips:
        if not os.path.isfile(c):
            raise InputError(f"not a file: {c}")
    if in_per_px is not None and not (0 < in_per_px < 5):
        raise InputError("--in-per-px must be a plausible scale, such as 0.367")
    layout = stop_layout(stops, stop_side)
    if reference is None:
        reference = min(clips, key=lambda c: (recorded_at(c) or "9999", os.path.basename(c)))
    ref_matches = [c for c in clips if c == reference or os.path.basename(c) == os.path.basename(str(reference))]
    if not ref_matches:
        raise InputError("--reference must be one of the clips")
    reference = ref_matches[0]
    out = private_dir(out_dir)
    order = [reference] + [c for c in clips if c != reference]
    snaps, results, failed = {}, {}, []
    for i, clip in enumerate(order):
        name = os.path.basename(clip)
        if progress:
            progress({"event": "clip", "done": i, "total": len(order), "clip": name})
        try:
            snaps[clip] = decoder(clip, samples)
        except Exception as error:  # noqa: BLE001 - one unreadable clip must not lose the others
            if clip == reference:
                raise InputError(f"the reference clip could not be read: {error}") from None
            failed.append(name)
            results[clip] = {"clip": name, "recordedAt": recorded_at(name), "reference": False, "error": str(error)[:300],
                             "transform": None, "verdict": "uncertain", "why": "The clip could not be decoded."}
    ref = snaps[reference]
    if rotation == "auto":
        rot = ref["rotation"]
        if rot is not None:
            rot_source, rot_note = "metadata", "Rotation from the clip's display matrix."
        else:
            w, h = ref["size"]
            rot, rot_source = (90 if w > h else 0), "assumed"
            rot_note = ("No rotation metadata: a landscape clip is displayed turned 90 degrees clockwise (the Vision-App RAW rule)."
                        if w > h else "No rotation metadata: a portrait clip is analysed as recorded.")
    else:
        rot, rot_source, rot_note = int(rotation), "given", "Rotation given with --rotation."
    mapping = Mapping(*ref["size"], rotation=rot)
    axis, sign = layout["axis"], layout["sign"]
    positions = {k: float(v) for k, v in (stops or {}).items()}
    centre = (mapping.pad[1] + mapping.display[1] * mapping.scale / 2) if axis == "FRAME_Y" else (mapping.pad[0] + mapping.display[0] * mapping.scale / 2)
    probe = list(positions.values()) or [centre]
    ref_gray = ref["median"].mean(axis=2)
    ref_g = gradmag(ref_gray)
    stems = set()
    for clip in order:
        if clip in results:
            continue
        snap, name = snaps[clip], os.path.basename(clip)
        stem = safe_stem(name)
        while stem in stems:
            stem += "_"
        stems.add(stem)
        r = {"clip": name, "recordedAt": recorded_at(name), "reference": clip == reference, "frames": snap["frames"],
             "framesUsed": snap["framesUsed"], "seconds": snap["seconds"], "size": snap["size"]}
        gray = snap["median"].mean(axis=2)
        r["brightness"] = round(float(gray.mean()), 1)
        r["snapshot"] = f"{stem}.png"
        save_png(out / r["snapshot"], thumbnail(mapping.display_image(snap["median"])))
        same_picture = snap["size"] == ref["size"] and (snap["rotation"] is None or ref["rotation"] is None or snap["rotation"] == ref["rotation"])
        if clip == reference:
            t = IDENTITY
        elif not same_picture:
            t = None
        else:
            both = np.maximum(ref["motion"], snap["motion"])
            static = (both < max(float(np.percentile(both, MOTION_PERCENTILE)), MOTION_FLOOR)).astype(float)
            cur_g = gradmag(gray)
            t = register(ref_g, cur_g, static)
            if t is not None:
                ov = edge_overlay(ref_g, cur_g)
                r["overlay"] = f"{stem}-overlay.png"
                save_png(out / r["overlay"], mapping.display_image(ov))
                z = zoom(ov, t, mapping)
                if z is not None:
                    r["zoom"] = f"{stem}-zoom.png"
                    save_png(out / r["zoom"], z)
        if t is None:
            r.update({"transform": None, "shiftPx": None, "readsIn": None, "stops": None, "regions": [],
                      "verdict": "uncertain", "why": ("Recorded at another picture size or orientation than the reference; "
                                                      "the camera's recording settings changed." if not same_picture else
                                                      verdict(None, [], 0)[1])})
            results[clip] = r
            continue
        r["transform"] = {"tx": rounded(t["tx"], 3), "ty": rounded(t["ty"], 3), "rotDeg": rounded(t["rotDeg"], 4),
                          "scale": rounded(t["scale"], 5), "rmsPx": rounded(t["rmsPx"], 3), "patches": t["patches"], "of": t["of"]}
        shifts = [axis_shift(t, mapping, axis, *point_on_axis(mapping, axis, p)) for p in probe]
        shift = float(np.mean(shifts))
        reads = (lambda d: rounded(sign * d * in_per_px)) if (sign is not None and in_per_px is not None) else (lambda d: None)
        r["shiftPx"], r["readsIn"] = rounded(shift), reads(shift)
        r["stops"] = {k: {"shiftPx": rounded(s), "readsIn": reads(s)} for k, s in zip(positions, shifts)} if positions else None
        r["regions"] = regions(t, mapping, axis) if clip != reference else []
        r["verdict"], r["why"] = ("reference", "The view every other recording is compared with.") if clip == reference \
            else verdict(t, r["regions"], shift)
        results[clip] = r
    clip_list = sorted(results.values(), key=lambda c: (c.get("recordedAt") or "", c["clip"]))
    scene = {
        "kind": "trimsaw-scene", "version": VERSION, "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "reference": os.path.basename(reference), "referenceAt": recorded_at(reference),
        "mapping": {**mapping.describe(), "rotationSource": rot_source, "axis": axis, "stopSide": layout["stopSide"],
                    "sideSource": layout["sideSource"], "readingSign": sign,
                    "note": f"{rot_note} Analysis frame: the displayed clip letterboxed into a {ANALYSIS_SIZE} px box; "
                            "the camera's small deskew is ignored. Shifts are along the stop axis "
                            f"({'analysis y' if axis == 'FRAME_Y' else 'analysis x'}), "
                            + ("at each stop line." if positions else "at the frame centre (no stop positions given).")},
        "stops": positions or None, "inPerPx": in_per_px,
        "thresholds": {"steadyPx": STEADY_PX, "minPatches": MIN_PATCHES, "maxRmsPx": MAX_RMS_PX, "regionTolerancePx": REGION_TOLERANCE_PX,
                       "patchPx": PATCH, "stepPx": STEP, "minPeak": MIN_PEAK, "staticShare": STATIC_SHARE,
                       "motionPercentile": MOTION_PERCENTILE, "motionFloor": MOTION_FLOOR, "samples": samples},
        "clips": clip_list,
        "summary": summarize(clip_list, layout, in_per_px if sign is not None else None),
        "failed": failed,
    }
    write_json(out / "scene.json", scene)
    if progress:
        progress({"event": "done", "done": len(order), "total": len(order)})
    return scene


def main(argv=None):
    parser = argparse.ArgumentParser(description="Camera view drift between a trimsaw camera's raw recordings.")
    parser.add_argument("clips", nargs="+", help="raw clips (.mp4)")
    parser.add_argument("--out", required=True, help="private output folder for scene.json and the PNGs")
    parser.add_argument("--reference", help="the clip every other one is compared with (default: the earliest)")
    parser.add_argument("--stops", help='applied stop positions, analysis px along the stop axis: {"42": 126.9, …}')
    parser.add_argument("--in-per-px", type=float, help="the camera's scale, inches per analysis px")
    parser.add_argument("--stop-side", help="TOP, BOTTOM, LEFT or RIGHT (default: from the stops, else unknown)")
    parser.add_argument("--samples", type=int, default=SAMPLES, help="frames per clip for the median snapshot")
    parser.add_argument("--rotation", default="auto", choices=["auto", "0", "90", "180", "270"])
    parser.add_argument("--progress", action="store_true", help="JSON progress lines on stderr")
    o = parser.parse_args(argv)

    def progress(event):
        sys.stderr.write(json.dumps(event) + "\n")
        sys.stderr.flush()

    try:
        if not (10 <= o.samples <= 2000):
            raise InputError("--samples is between 10 and 2000")
        scene = analyze(o.clips, o.out, reference=o.reference, stops=parse_stops(o.stops), in_per_px=o.in_per_px,
                        stop_side=o.stop_side, samples=o.samples, rotation=o.rotation, progress=progress if o.progress else None)
    except (InputError, OSError) as error:
        sys.stderr.write(f"error: {error}\n")
        return 2
    print(json.dumps({"kind": "trimsaw-scene-result", "scene": str(Path(o.out) / "scene.json"), "reference": scene["reference"],
                      "summary": scene["summary"], "clips": [{k: c.get(k) for k in ("clip", "recordedAt", "verdict", "shiftPx", "readsIn")}
                                                             for c in scene["clips"]]}, indent=1))
    return 3 if scene["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
