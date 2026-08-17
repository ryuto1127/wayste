"""Pull labeled bbox data for the demo classes from COCO (no photography).

COCO-2017 has real bbox labels for three of our classes — use it to bulk up
recall. It CANNOT distinguish paper vs plastic cups (both are just "cup"),
so cups must come from Roboflow Universe datasets instead (see README).

Runs in Colab (recommended — the download happens there, not locally):

    !pip -q install fiftyone
    !python fetch_open_data.py
    # → writes ./coco_yolo/ in YOLO layout; merge into your Roboflow
    #   project (Upload) or directly into dataset/ before training.

License: COCO images are CC-BY 4.0 — fine for the demo; keep attribution
if any of this ships in marketing material.
"""

import fiftyone as fo
import fiftyone.zoo as foz

# COCO class → demo class. Cups are intentionally ABSENT (label can't tell
# paper from plastic). "bottle" in COCO includes glass/wine bottles — the
# per-class cap keeps the noise tolerable; skim the export and delete
# obvious non-PET bottles if the validation mAP for plastic_bottle sags.
CLASS_MAP = {
    "spoon": "metal_spoon",
    "bottle": "plastic_bottle",
}
MAX_PER_CLASS = 600
EXPORT_DIR = "coco_yolo"

merged = None
for coco_name, demo_name in CLASS_MAP.items():
    ds = foz.load_zoo_dataset(
        "coco-2017",
        split="train",
        label_types=["detections"],
        classes=[coco_name],
        max_samples=MAX_PER_CLASS,
        dataset_name=f"coco_{coco_name}",
    )
    # Keep only the target class's boxes, renamed to the demo class.
    view = ds.filter_labels("ground_truth", fo.ViewField("label") == coco_name)
    for sample in view:
        for det in sample.ground_truth.detections:
            det.label = demo_name
        sample.save()
    merged = view if merged is None else merged.concat(view)

merged.export(
    export_dir=EXPORT_DIR,
    dataset_type=fo.types.YOLOv5Dataset,
    label_field="ground_truth",
    classes=sorted(set(CLASS_MAP.values())),
)
print(f"Exported {len(merged)} images to {EXPORT_DIR}/")
