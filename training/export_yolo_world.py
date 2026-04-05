#!/usr/bin/env python3
"""
Export YOLO World v2 (small) with pre-baked recycling-specific classes to ONNX.

This creates a fixed-class detector for waste items NOT covered by COCO-80.
Similar classes are consolidated (e.g. aluminum can + tin can → metal can)
to reduce inter-class confusion. The CLIP text embeddings are computed once
at export time and frozen into the model weights — no CLIP encoder needed
at runtime.

Usage:
    pip install ultralytics
    python export_yolo_world.py

Output:
    ../public/models/yolo-world-s.onnx
"""

from pathlib import Path
from ultralytics import YOLO

# ── Classes to pre-bake ──
# Must match YOLO_WORLD_CLASSES in lib/yolo-world-inference.ts exactly.
RECYCLING_CLASSES = [
    "metal can",
    "cardboard",
    "paper bag",
    "plastic bag",
    "napkin",
    "wrapper",
    "straw",
    "styrofoam",
    "food container",
    "milk carton",
    "juice box",
    "paper plate",
    "paper cup",
    "aluminum foil",
    "paper towel",
    "egg carton",
    "coffee cup sleeve",
    "plastic bottle cap",
    "glass jar",
    "yogurt cup",
    "chip bag",
    "cigarette butt",
    "battery",
]

OUTPUT_DIR = Path(__file__).parent.parent / "public" / "models"


def main():
    print(f"Loading yolov8s-worldv2...")
    model = YOLO("yolov8s-worldv2.pt")

    print(f"Setting {len(RECYCLING_CLASSES)} custom classes...")
    model.set_classes(RECYCLING_CLASSES)

    print("Exporting to ONNX...")
    output_path = model.export(
        format="onnx",
        imgsz=640,
        simplify=True,
        opset=17,
    )

    # Move to public/models/
    src = Path(output_path)
    dst = OUTPUT_DIR / "yolo-world-s.onnx"
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)

    size_mb = dst.stat().st_size / (1024 * 1024)
    print(f"\nExported: {dst}")
    print(f"Size: {size_mb:.1f} MB")
    print(f"Classes: {len(RECYCLING_CLASSES)}")
    print("\nClass list:")
    for i, cls in enumerate(RECYCLING_CLASSES):
        print(f"  {i:2d}: {cls}")


if __name__ == "__main__":
    main()
