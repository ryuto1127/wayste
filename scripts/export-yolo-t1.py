"""
Re-export YOLO11m to ONNX without built-in NMS, with FP16 weights.

The default ultralytics export produces raw [1, 84, 8400] predictions
(4 bbox coords + 80 COCO class scores x 8400 candidates) without NMS.
NMS is handled in JS post-processing instead, matching the YOLO World
pipeline and avoiding the slow NMS operator on WebGPU.

Requirements:
    pip install ultralytics onnxruntime

Usage:
    python scripts/export-yolo-t1.py
"""

import os


def main():
    from ultralytics import YOLO

    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    output_path = os.path.join(project_root, "public", "models", "yolo26m.onnx")

    # Record old file size
    old_size = None
    if os.path.exists(output_path):
        old_size = os.path.getsize(output_path)

    # Load YOLO26m weights from training directory
    weights_path = os.path.join(project_root, "training", "yolo26m.pt")
    if not os.path.exists(weights_path):
        print(f"Error: weights not found at {weights_path}")
        return
    model = YOLO(weights_path)

    # Disable end-to-end NMS so the export produces raw [1, 84, 8400] output.
    # NMS is performed in JS post-processing instead (faster on WebGPU).
    model.model.end2end = False
    model.model.model[-1].end2end = False  # Detect head

    # Export to ONNX — no NMS (default), FP16 weights, simplified graph.
    # half=True converts weight storage to float16 (~38 MB vs ~77 MB FP32).
    export_path = model.export(
        format="onnx",
        imgsz=640,
        half=True,
        simplify=True,
        opset=17,
    )

    # Move to the expected location
    if os.path.abspath(export_path) != os.path.abspath(output_path):
        import shutil
        shutil.move(export_path, output_path)

    # Verify output shape
    import onnxruntime as onnrt
    import numpy as np

    sess = onnrt.InferenceSession(output_path)
    dummy = np.random.randn(1, 3, 640, 640).astype(np.float32)
    outputs = sess.run(None, {sess.get_inputs()[0].name: dummy})
    print(f"Output shape: {outputs[0].shape}")
    print(f"Output dtype: {outputs[0].dtype}")

    # Report sizes
    new_size = os.path.getsize(output_path)
    if old_size is not None:
        print(f"Old size: {old_size / 1024 / 1024:.1f} MB")
    print(f"New size: {new_size / 1024 / 1024:.1f} MB")
    if old_size is not None:
        reduction = (1 - new_size / old_size) * 100
        print(f"Change: {reduction:+.1f}%")

    print(f"\nModel saved to: {output_path}")


if __name__ == "__main__":
    main()
