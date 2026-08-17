"""Train the demo waste model (few classes, production-grade on demo items).

Runs locally (Apple Silicon MPS) or on Google Colab (free T4 GPU — faster).
Colab: upload the labeled dataset zip + this script, then:

    !pip install ultralytics
    !python train_demo_yolo.py

Dataset layout (Roboflow "YOLO" export produces exactly this):

    dataset/
      data.yaml          # names must match CLASSES below, in the same order
      train/images/*.jpg
      train/labels/*.txt
      valid/images/*.jpg
      valid/labels/*.txt

The export at the bottom produces the NMS-free end-to-end ONNX the kiosk
expects (output shape [1, 300, 6] = x1, y1, x2, y2, confidence, class_id —
same contract as public/models/15class_v1.onnx). After training:

  1. Copy the exported .onnx to public/models/demo_v1.onnx
  2. Copy docs/demo-model/yolo-rules.demo.json over public/models/yolo-rules.json
  3. Point initYolo at the new file (lib/yolo-inference.ts default model URL)
"""

import os

from ultralytics import YOLO

# ── Config ──────────────────────────────────────────────────────────────
# Class list — ORDER MATTERS and must match data.yaml `names`.
CLASSES = [
    "plastic_bottle",  # 資源 + 統合アイテム(キャップ/ラベル分解はsite configのcompoundsが担当)
    "can",             # 資源 — ペットボトルと円筒形ペア(任意クラス: データが無ければ外す)
    "paper_cup",       # 可燃 — プラカップとの見分けが最大の見せ場
    "plastic_cup",     # プラ
    "battery",         # 特別
]
# 不燃(金属スプーン)は意図的にYOLO未学習 — unknown_object→VLM判定の
# 実演に使う(docs/demo-model/README.md参照)。公開スプーンデータは
# 目視QA不合格(COCO=食事脇役/遮蔽、Universe=小規模のみ)だった。

# Same backbone size as the current production model (26m). If the kiosk's
# YOLO ms readout shows m is too slow for 30fps on the demo machine, retrain
# with "yolo26s.pt" — on a task this small the accuracy is effectively the
# same (the COCO gap between sizes reflects 80-class generalist difficulty,
# not a 6-class specialist fine-tune).
BASE_MODEL = "yolo26m.pt"
DATA_YAML = "dataset/data.yaml"
# 100 is an upper bound, not a target: patience below stops training once
# val mAP plateaus, which on a 5-class fine-tune happens well before 100.
EPOCHS = 100
IMGSZ = 640
# Write checkpoints to Google Drive when running in Colab. The VM's own disk
# is wiped when the runtime disconnects or expires — a multi-hour run then
# leaves NOTHING. On Drive, `resume=True` below picks up where it stopped.
DRIVE_PROJECT = "/content/drive/MyDrive/wayste_training"
PROJECT = DRIVE_PROJECT if os.path.isdir("/content/drive/MyDrive") else "runs"
RUN_NAME = "demo5"

# ── Train (auto-resumes an interrupted run) ─────────────────────────────
last_ckpt = os.path.join(PROJECT, RUN_NAME, "weights", "last.pt")
if os.path.exists(last_ckpt):
    print(f"resuming from {last_ckpt}")
    model = YOLO(last_ckpt)
    model.train(resume=True)
else:
    model = YOLO(BASE_MODEL)
    model.train(
        data=DATA_YAML,
        epochs=EPOCHS,
        imgsz=IMGSZ,
        batch=-1,          # auto batch size for the available GPU/MPS memory
        patience=30,       # early stop when val mAP plateaus
        degrees=15,        # rotation — hands present items at odd angles
        scale=0.5,         # distance variation
        fliplr=0.5,
        hsv_v=0.5,         # strong brightness variation — venue lighting unknown
        hsv_s=0.5,
        mosaic=1.0,
        close_mosaic=20,
        project=PROJECT,
        name=RUN_NAME,
        exist_ok=True,
        save_period=5,     # extra checkpoint every 5 epochs
    )

# ── Validate ────────────────────────────────────────────────────────────
metrics = model.val()
print("mAP50-95:", metrics.box.map, "mAP50:", metrics.box.map50)
print("Per-class mAP50-95:", dict(zip(CLASSES, metrics.box.maps)))

# ── Export (kiosk contract: end-to-end NMS-free FP16 ONNX, 640×640) ─────
onnx_path = model.export(format="onnx", imgsz=IMGSZ, half=True)
print("Exported:", onnx_path)
print("Verify with:  python -c \"import onnx; m=onnx.load('%s'); "
      "print([ (o.name, [d.dim_value for d in o.type.tensor_type.shape.dim]) "
      "for o in m.graph.output ])\"  → expect [1, 300, 6]" % onnx_path)
