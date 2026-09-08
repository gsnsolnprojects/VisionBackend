#!/usr/bin/env python3
"""
Convert YOLO PyTorch model to TFLite format (for on-device mobile inference)

This script converts a YOLO PyTorch model (.pt) to TFLite format (.tflite).
It uses the ultralytics library's built-in export functionality, which
handles the PyTorch -> ONNX -> TensorFlow -> TFLite pipeline internally.

Usage:
    python convert-to-tflite.py --input /path/to/best.pt --output-dir /path/to/output

Example:
    python convert-to-tflite.py --input models/gsn/Corrosion/bike_rust_model_2/best.pt --output-dir models/gsn/Corrosion/bike_rust_model_2
"""

import argparse
import sys
import os
import shutil
from pathlib import Path

try:
    from ultralytics import YOLO
except ImportError:
    print("ERROR: ultralytics package not found. Install with: pip install ultralytics", file=sys.stderr)
    sys.exit(1)


def convert_to_tflite(input_path, output_dir, imgsz=640):
    """
    Convert YOLO model from PyTorch to TFLite format.

    Args:
        input_path: Path to input .pt model file
        output_dir: Directory where the exported TFLite artifacts should end up
        imgsz: Input image size the model expects

    Returns:
        list[str]: Paths to the .tflite files produced, or empty list on failure
    """
    try:
        if not os.path.exists(input_path):
            print(f"ERROR: Input file not found: {input_path}", file=sys.stderr)
            return []

        os.makedirs(output_dir, exist_ok=True)

        print(f"Loading model: {input_path}")
        sys.stdout.flush()
        model = YOLO(input_path)

        print(f"Exporting to TFLite (imgsz={imgsz})... this can take a few minutes")
        sys.stdout.flush()

        # Ultralytics exports to a `<name>_saved_model/` dir next to the input
        # .pt file, containing float32, float16, and int8 .tflite variants.
        exported_path = model.export(format="tflite", imgsz=imgsz)

        exported_path = Path(exported_path)
        source_dir = exported_path if exported_path.is_dir() else exported_path.parent

        tflite_files = sorted(source_dir.glob("*.tflite"))
        if not tflite_files:
            print(f"ERROR: No .tflite files found in export output: {source_dir}", file=sys.stderr)
            return []

        moved_paths = []
        for f in tflite_files:
            dest = Path(output_dir) / f.name
            if str(f) != str(dest):
                shutil.copy2(f, dest)
            moved_paths.append(str(dest))
            size_mb = dest.stat().st_size / (1024 * 1024)
            print(f"  {dest.name}: {size_mb:.2f} MB")

        print(f"Done. {len(moved_paths)} TFLite file(s) copied to: {output_dir}")
        sys.stdout.flush()
        return moved_paths

    except Exception as e:
        print(f"ERROR: Conversion failed: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return []


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Convert YOLO PyTorch model to TFLite format"
    )
    parser.add_argument("--input", required=True, help="Path to input .pt model file")
    parser.add_argument("--output-dir", required=True, help="Directory for exported .tflite files")
    parser.add_argument("--imgsz", type=int, default=640, help="Input image size (default 640)")

    args = parser.parse_args()

    input_path = os.path.abspath(args.input)
    output_dir = os.path.abspath(args.output_dir)

    results = convert_to_tflite(input_path, output_dir, args.imgsz)
    sys.exit(0 if results else 1)
