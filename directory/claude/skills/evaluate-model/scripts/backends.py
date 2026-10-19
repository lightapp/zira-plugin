"""Model backends: LiteRT (.tflite) exports and Ultralytics (.pt) checkpoints.

Each backend returns normalized xywh boxes with class ids and scores. LiteRT and Ultralytics
preprocess differently (stretch resize vs letterbox); the difference is recorded in the
report's `preprocessing`, because it changes scores.
"""

from __future__ import annotations

import contextlib
import math
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image


@dataclass
class Prediction:
    boxes: list[dict]
    width: int
    height: int
    preprocess_ms: float
    model_ms: float
    postprocess_ms: float


def _ms(start: float) -> float:
    return (time.perf_counter() - start) * 1000


def box_iou(a: dict, b: dict) -> float:
    ax1, ay1, ax2, ay2 = a["x"] - a["w"] / 2, a["y"] - a["h"] / 2, a["x"] + a["w"] / 2, a["y"] + a["h"] / 2
    bx1, by1, bx2, by2 = b["x"] - b["w"] / 2, b["y"] - b["h"] / 2, b["x"] + b["w"] / 2, b["y"] + b["h"] / 2
    inter = max(0.0, min(ax2, bx2) - max(ax1, bx1)) * max(0.0, min(ay2, by2) - max(ay1, by1))
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


def nms(boxes: list[dict], threshold: float) -> list[dict]:
    pending = sorted(boxes, key=lambda b: b["score"], reverse=True)
    kept = []
    while pending:
        best = pending.pop(0)
        kept.append(best)
        pending = [b for b in pending if b["classId"] != best["classId"] or box_iou(best, b) <= threshold]
    return kept


def dequantize(value: np.ndarray, detail: dict) -> np.ndarray:
    if not np.issubdtype(value.dtype, np.integer):
        return value.astype(np.float32, copy=False)
    scale, zero = detail.get("quantization", (0.0, 0))
    return (value.astype(np.float32) - float(zero)) * float(scale) if scale else value.astype(np.float32)


def input_geometry(detail: dict) -> tuple[int, int, bool]:
    shape = [int(x) for x in detail["shape"]]
    if len(shape) != 4:
        raise ValueError(f"expected a 4D image input, got {shape}")
    nchw = shape[1] in (1, 3, 4) and shape[-1] not in (1, 3, 4)
    height, width = (shape[2], shape[3]) if nchw else (shape[1], shape[2])
    return width, height, nchw


def prepare_input(image: Image.Image, detail: dict) -> np.ndarray:
    """Stretch-resize to the input size (no letterbox), RGB, scaled to 0..1, then quantized if needed."""
    width, height, nchw = input_geometry(detail)
    pixels = np.asarray(image.resize((width, height), Image.Resampling.BILINEAR), dtype=np.float32) / 255.0
    if nchw:
        pixels = np.transpose(pixels, (2, 0, 1))
    pixels = np.expand_dims(pixels, 0)
    dtype = detail["dtype"]
    if np.issubdtype(dtype, np.integer):
        scale, zero = detail.get("quantization", (0.0, 0))
        pixels = np.rint(pixels / float(scale) + float(zero)) if scale else np.rint(pixels * 255.0)
        info = np.iinfo(dtype)
        return np.clip(pixels, info.min, info.max).astype(dtype)
    return pixels.astype(dtype)


def output_class_count(shape: list[int]) -> int | None:
    """Class count implied by a raw YOLO head ([1, 4+C, N] or [1, N, 4+C]); None for end-to-end [N, 6].

    The feature axis (4 box values plus one score per class) is the smaller one in real heads."""
    dims = [d for d in shape if d != 1] if len(shape) == 3 else list(shape)
    if len(dims) != 2:
        return None
    rows, cols = dims
    if cols == 6 and rows > cols:
        return None  # end-to-end NMS output carries class ids, not scores per class
    features = min(rows, cols)
    return features - 4 if features > 4 else None


def decode_output(raw: np.ndarray, detail: dict, class_count: int, confidence: float, nms_iou: float,
                  input_width: int, input_height: int) -> tuple[list[dict], str]:
    output = dequantize(raw, detail)
    if output.ndim == 3 and output.shape[0] == 1:
        output = output[0]
    if output.ndim != 2:
        raise ValueError(f"expected a 2D YOLO output after removing batch, got {list(output.shape)}")
    rows, cols = output.shape
    boxes = []
    if cols == 6 and rows > cols:
        layout = "end-to-end"
        for x1, y1, x2, y2, score, cls in output[:, :6].astype(float):
            class_id = int(cls)
            if not all(math.isfinite(v) for v in (x1, y1, x2, y2, score)) or score < confidence or not 0 <= class_id < class_count:
                continue
            if max(abs(x1), abs(y1), abs(x2), abs(y2)) > 2.0:
                x1, x2, y1, y2 = x1 / input_width, x2 / input_width, y1 / input_height, y2 / input_height
            left, right, top, bottom = min(x1, x2), max(x1, x2), min(y1, y2), max(y1, y2)
            boxes.append({"classId": class_id, "score": float(score), "x": (left + right) / 2, "y": (top + bottom) / 2,
                          "w": right - left, "h": bottom - top})
    else:
        if rows == 4 + class_count:
            features, layout = output, "features-first"
        elif cols == 4 + class_count:
            features, layout = output.T, "boxes-first"
        else:
            raise ValueError(f"model output {list(output.shape)} has {min(rows, cols) - 4} class scores, expected {class_count}")
        scores = features[4:]
        class_ids = np.argmax(scores, axis=0)
        best = scores[class_ids, np.arange(scores.shape[1])]
        for index in np.nonzero(best >= confidence)[0]:
            x, y, w, h = (float(v) for v in features[:4, index])
            if not all(math.isfinite(v) for v in (x, y, w, h)):
                continue
            if max(abs(x), abs(y), abs(w), abs(h)) > 2.0:
                x, w, y, h = x / input_width, w / input_width, y / input_height, h / input_height
            boxes.append({"classId": int(class_ids[index]), "score": float(best[index]), "x": x, "y": y, "w": w, "h": h})
    clipped = []
    for b in boxes:
        x1, y1 = max(0.0, b["x"] - b["w"] / 2), max(0.0, b["y"] - b["h"] / 2)
        x2, y2 = min(1.0, b["x"] + b["w"] / 2), min(1.0, b["y"] + b["h"] / 2)
        if x2 > x1 and y2 > y1:
            clipped.append({**b, "x": (x1 + x2) / 2, "y": (y1 + y2) / 2, "w": x2 - x1, "h": y2 - y1})
    return nms(clipped, nms_iou), layout


class LiteRtModel:
    def __init__(self, path: Path, threads: int, interpreter=None):
        if interpreter is None:
            from ai_edge_litert.interpreter import Interpreter
            interpreter = Interpreter(model_path=str(path), num_threads=max(1, min(os.cpu_count() or 4, threads)))
        interpreter.allocate_tensors()
        self.interpreter = interpreter
        self.input = interpreter.get_input_details()[0]
        self.output = interpreter.get_output_details()[0]
        width, height, nchw = input_geometry(self.input)
        self.size = (width, height)
        out_shape = [int(x) for x in self.output["shape"]]
        self.class_names = None  # LiteRT exports carry no class names
        self.class_count = output_class_count(out_shape)
        self.info = {"type": "LiteRT", "inputShape": [int(x) for x in self.input["shape"]],
                     "inputDtype": np.dtype(self.input["dtype"]).name, "inputLayout": "NCHW" if nchw else "NHWC",
                     "outputShape": out_shape, "outputDtype": np.dtype(self.output["dtype"]).name}
        self.preprocessing = {"resize": "stretch", "interpolation": "bilinear", "size": [width, height],
                              "color": "RGB", "scale": "0..1", "quantized": bool(np.issubdtype(self.input["dtype"], np.integer)),
                              "nms": "this tool, per class"}
        self.layout = None

    def predict(self, image_path: Path, confidence: float, nms_iou: float) -> Prediction:
        with Image.open(image_path) as opened:
            image = opened.convert("RGB")
        start = time.perf_counter()
        tensor = prepare_input(image, self.input)
        pre = _ms(start)
        start = time.perf_counter()
        self.interpreter.set_tensor(self.input["index"], tensor)
        self.interpreter.invoke()
        raw = self.interpreter.get_tensor(self.output["index"])
        model = _ms(start)
        start = time.perf_counter()
        count = self.class_count if self.class_count is not None else 10 ** 6
        boxes, self.layout = decode_output(raw, self.output, count, confidence, nms_iou, *self.size)
        self.info["outputLayout"] = self.layout
        return Prediction(boxes, image.width, image.height, pre, model, _ms(start))


class UltralyticsModel:
    def __init__(self, path: Path, device: str):
        policy = Path(__file__).with_name("distribution-policy.json")
        if policy.exists() and json.loads(policy.read_text()).get("ptModels") is not True:
            raise ValueError("This public build supports .tflite models only; .pt support is not released.")
        os.environ.setdefault("YOLO_CONFIG_DIR", os.environ.get("ZIRA_MODEL_EVAL_CACHE", str(Path.home() / ".cache" / "zira" / "model-evaluation")) + "/ultralytics")
        with contextlib.redirect_stdout(sys.stderr):
            from ultralytics import YOLO
        self.model = YOLO(str(path))
        self.device = device
        train_args = (getattr(self.model, "ckpt", None) or {}).get("train_args", {})
        size = train_args.get("imgsz", 640)
        size = max(size) if isinstance(size, (list, tuple)) else size
        try:
            self.image_size = int(size)
        except (TypeError, ValueError):
            self.image_size = 640
        names = getattr(self.model, "names", None) or {}
        self.class_names = [str(names[k]) for k in sorted(names)] if isinstance(names, dict) else [str(n) for n in names]
        self.class_count = len(self.class_names)
        self.info = {"type": "Ultralytics PT", "imageSize": self.image_size, "device": device, "task": getattr(self.model, "task", None)}
        self.preprocessing = {"resize": "letterbox", "size": [self.image_size, self.image_size], "color": "RGB",
                              "scale": "0..1", "nms": "Ultralytics"}

    def predict(self, image_path: Path, confidence: float, nms_iou: float) -> Prediction:
        with Image.open(image_path) as opened:
            width, height = opened.size
        start = time.perf_counter()
        result = self.model.predict(source=str(image_path), imgsz=self.image_size, conf=confidence, iou=nms_iou,
                                    device=self.device, verbose=False)[0]
        elapsed = _ms(start)
        speed = getattr(result, "speed", {}) or {}
        boxes = []
        if result.boxes is not None:
            for (x, y, w, h), cls, score in zip(result.boxes.xywhn.cpu().numpy(), result.boxes.cls.cpu().numpy(),
                                                result.boxes.conf.cpu().numpy()):
                boxes.append({"classId": int(cls), "score": float(score), "x": float(x), "y": float(y), "w": float(w), "h": float(h)})
        return Prediction(boxes, width, height, float(speed.get("preprocess", 0.0)),
                          float(speed.get("inference", elapsed)), float(speed.get("postprocess", 0.0)))


def load_model(path: Path, threads: int = 4, device: str = "cpu"):
    suffix = path.suffix.lower()
    if suffix == ".tflite":
        return LiteRtModel(path, threads)
    if suffix == ".pt":
        return UltralyticsModel(path, device)
    raise ValueError("model must be a .tflite export or .pt checkpoint")
