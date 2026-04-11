#!/usr/bin/env python3
"""
Export YOLO World v2 (small) with pre-baked recycling-specific classes to ONNX.

This creates a fixed-class detector for waste items NOT covered by COCO-80.
Visually specific class names are used to avoid model confusion
(e.g. "aluminium beverage can" instead of "metal can" to prevent misclassification
as "battery"). The CLIP text embeddings are computed once at export time and frozen
into the model weights — no CLIP encoder needed at runtime.

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
    # ── Original 36 classes (indices 0-35, DO NOT reorder) ──
    "aluminium beverage can",
    "steel food can",
    "plastic bottle",
    "glass bottle",
    "glass jar",
    "cardboard",
    "paper bag",
    "paper cup",
    "paper plate",
    "paper towel",
    "napkin",
    "newspaper",
    "milk carton",
    "juice box",
    "egg carton",
    "pizza box",
    "plastic bag",
    "plastic bottle cap",
    "plastic wrapper",
    "chip bag",
    "styrofoam cup",
    "styrofoam container",
    "plastic straw",
    "plastic food container",
    "plastic cup",
    "yogurt cup",
    "plastic utensil",
    "coffee cup",
    "coffee cup sleeve",
    "aluminum foil",
    "banana peel",
    "apple core",
    "battery",
    "cigarette butt",
    "pen",
    "plastic bottle label",
    # ── New material sub-classification classes (indices 36+) ──
    "steel beverage can",
    "ceramic mug",
    "ceramic bowl",
    "paper bowl",
    "plastic container",
    "metal fork",
    "metal knife",
    "metal spoon",
    "plastic fork",
    "plastic knife",
    "plastic spoon",
    "wooden fork",
    "wooden knife",
    "wooden spoon",
    "wooden chopsticks",
    "glass wine glass",
    "plastic wine glass",
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
