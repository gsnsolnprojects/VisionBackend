#!/usr/bin/env python3
"""
YOLO Training Script

This script trains a YOLO model using the configuration provided by the backend.
It reads a JSON config file and runs YOLO training, outputting logs in a format
that the Node.js worker can parse.

Usage:
    python train.py --config /path/to/training-config.json
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

try:
    from ultralytics import YOLO
except ImportError:
    print("ERROR: ultralytics package not found. Install with: pip install ultralytics", file=sys.stderr)
    sys.exit(1)

# ✅ Image extensions Ultralytics accepts for detect training
_IMAGE_EXTS = {
    '.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp',
    '.jp2', '.jpeg2000', '.dng', '.mpo', '.heic', '.avif',
}


def _list_images(folder):
    """Return image filenames in folder (non-recursive)."""
    if not os.path.isdir(folder):
        return []
    try:
        return [
            f for f in os.listdir(folder)
            if os.path.isfile(os.path.join(folder, f))
            and Path(f).suffix.lower() in _IMAGE_EXTS
        ]
    except OSError:
        return []


def ensure_nonempty_val(dataset_path, data_yaml_path):
    """
    YOLO requires a non-empty val set. Small splits can leave images/val empty.

    Strategy:
      1. If images/val already has images → nothing to do
      2. Else copy one train image + matching label into val
      3. If train is also empty, try test
      4. If still empty, point data.yaml val: to images/train (last resort)
    """
    dataset_path = os.path.abspath(dataset_path)
    images_val = os.path.join(dataset_path, 'images', 'val')
    images_train = os.path.join(dataset_path, 'images', 'train')
    images_test = os.path.join(dataset_path, 'images', 'test')
    labels_val = os.path.join(dataset_path, 'labels', 'val')
    labels_train = os.path.join(dataset_path, 'labels', 'train')
    labels_test = os.path.join(dataset_path, 'labels', 'test')

    val_images = _list_images(images_val)
    if val_images:
        print(f"✅ Validation set OK ({len(val_images)} image(s) in images/val)")
        sys.stdout.flush()
        return

    print("⚠️ images/val is empty — YOLO needs a validation set. Fixing automatically...")
    sys.stdout.flush()

    source_imgs = _list_images(images_train)
    source_img_dir = images_train
    source_lbl_dir = labels_train
    source_name = 'train'

    if not source_imgs:
        source_imgs = _list_images(images_test)
        source_img_dir = images_test
        source_lbl_dir = labels_test
        source_name = 'test'

    if source_imgs:
        os.makedirs(images_val, exist_ok=True)
        os.makedirs(labels_val, exist_ok=True)

        filename = source_imgs[0]
        stem = Path(filename).stem
        src_img = os.path.join(source_img_dir, filename)
        dst_img = os.path.join(images_val, filename)
        shutil.copy2(src_img, dst_img)

        src_lbl = os.path.join(source_lbl_dir, f'{stem}.txt')
        dst_lbl = os.path.join(labels_val, f'{stem}.txt')
        if os.path.isfile(src_lbl):
            shutil.copy2(src_lbl, dst_lbl)
        else:
            # ✅ Empty label file is valid (background image)
            with open(dst_lbl, 'w', encoding='utf-8') as f:
                f.write('')

        print(f"✅ Copied 1 image from {source_name} → val: {filename}")
        sys.stdout.flush()
        return

    # Last resort: rewrite data.yaml so val points at train
    print("⚠️ No train/test images to copy — pointing data.yaml val: to images/train")
    sys.stdout.flush()
    try:
        with open(data_yaml_path, 'r', encoding='utf-8') as f:
            content = f.read()
        lines = []
        for line in content.split('\n'):
            if line.strip().startswith('val:'):
                lines.append('val: images/train')
            else:
                lines.append(line)
        with open(data_yaml_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))
        print("✅ Updated data.yaml: val: images/train")
        sys.stdout.flush()
    except Exception as e:
        print(f"ERROR: Could not fix empty val set: {e}", file=sys.stderr)
        sys.exit(1)


def load_config(config_path):
    """Load training configuration from JSON file."""
    try:
        with open(config_path, 'r') as f:
            config = json.load(f)
        return config
    except FileNotFoundError:
        print(f"ERROR: Config file not found: {config_path}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON in config file: {e}", file=sys.stderr)
        sys.exit(1)


def update_data_yaml(data_yaml_path, dataset_path, task='detect'):
    """
    Update data.yaml with actual class count and names from dataset.
    
    This function:
    - Scans labels/train/*.txt files to detect all class IDs
    - Validates YOLO format based on task
    - Fails loudly if labels are unreadable or invalid
    - Never defaults to 1 class unless labels are truly single-class
    
    Args:
        data_yaml_path: Full path to data.yaml file
        dataset_path: Full path to dataset directory
        
    Returns:
        tuple: (num_classes, class_names_list)
        
    Raises:
        SystemExit: If labels directory doesn't exist, is unreadable, or contains invalid data
    """
    # ✅ Use absolute paths to handle Windows paths with spaces correctly
    dataset_path = os.path.abspath(dataset_path)
    labels_train_path = os.path.join(dataset_path, 'labels', 'train')
    
    print(f"🔍 Scanning labels directory: {labels_train_path}")
    sys.stdout.flush()
    
    # ✅ Validate labels directory exists and is accessible
    if not os.path.exists(labels_train_path):
        print(f"ERROR: Labels directory does not exist: {labels_train_path}", file=sys.stderr)
        print(f"ERROR: Dataset path: {dataset_path}", file=sys.stderr)
        sys.exit(1)
    
    if not os.path.isdir(labels_train_path):
        print(f"ERROR: Labels path is not a directory: {labels_train_path}", file=sys.stderr)
        sys.exit(1)
    
    # ✅ Collect class IDs with explicit validation
    class_ids = set()
    files_scanned = 0
    files_with_labels = 0
    files_failed = []
    total_annotations = 0
    
    # ✅ Use listdir + filter instead of glob for better error handling on large directories
    try:
        all_files = os.listdir(labels_train_path)
        label_files = [f for f in all_files if f.lower().endswith('.txt')]
    except OSError as e:
        print(f"ERROR: Cannot read labels directory: {labels_train_path}", file=sys.stderr)
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    
    if not label_files:
        print(f"ERROR: No label files (.txt) found in: {labels_train_path}", file=sys.stderr)
        sys.exit(1)
    
    print(f"📊 Found {len(label_files)} label files to scan...")
    sys.stdout.flush()
    
    # ✅ Process each label file with explicit error handling
    for label_filename in label_files:
        files_scanned += 1
        label_file_path = os.path.join(labels_train_path, label_filename)
        
        try:
            # ✅ Read file with explicit encoding (UTF-8)
            with open(label_file_path, 'r', encoding='utf-8') as f:
                file_has_labels = False
                line_num = 0
                
                for line in f:
                    line_num += 1
                    line = line.strip()
                    
                    # Skip empty lines
                    if not line:
                        continue
                    
                    parts = line.split()
                    if task == 'segment':
                        # YOLO segmentation format: class_id x1 y1 x2 y2 ... xn yn
                        # total tokens must be odd and >= 7 (class + >= 3 points)
                        if len(parts) < 7 or len(parts) % 2 == 0:
                            print(f"ERROR: Invalid YOLO segmentation format in {label_filename}:{line_num}", file=sys.stderr)
                            print(f"ERROR: Expected odd number of values >= 7, got {len(parts)}: {line}", file=sys.stderr)
                            print(f"ERROR: Format should be: class_id x1 y1 x2 y2 ... xn yn", file=sys.stderr)
                            sys.exit(1)
                    else:
                        # YOLO detection format: class_id cx cy w h
                        if len(parts) != 5:
                            print(f"ERROR: Invalid YOLO format in {label_filename}:{line_num}", file=sys.stderr)
                            print(f"ERROR: Expected 5 values, got {len(parts)}: {line}", file=sys.stderr)
                            print(f"ERROR: Format should be: class_id center_x center_y width height", file=sys.stderr)
                            sys.exit(1)
                    
                    # ✅ Validate and extract class ID
                    try:
                        class_id = int(parts[0])
                    except ValueError:
                        print(f"ERROR: Invalid class ID in {label_filename}:{line_num}", file=sys.stderr)
                        print(f"ERROR: Class ID must be integer, got: {parts[0]}", file=sys.stderr)
                        sys.exit(1)
                    
                    # ✅ Validate class ID is non-negative
                    if class_id < 0:
                        print(f"ERROR: Negative class ID in {label_filename}:{line_num}: {class_id}", file=sys.stderr)
                        sys.exit(1)
                    
                    # ✅ Validate coordinates are numeric and in valid range [0, 1]
                    try:
                        coords = [float(v) for v in parts[1:]]
                    except ValueError as e:
                        print(f"ERROR: Invalid coordinates in {label_filename}:{line_num}", file=sys.stderr)
                        print(f"ERROR: {e}", file=sys.stderr)
                        sys.exit(1)
                    
                    # ✅ Validate normalized coordinates (YOLO format uses 0-1 range)
                    if not all(0.0 <= v <= 1.0 for v in coords):
                        print(f"WARNING: Coordinates out of [0,1] range in {label_filename}:{line_num}", file=sys.stderr)
                        print(f"WARNING: values={coords}", file=sys.stderr)
                        # Don't exit - YOLO might handle this, but log the warning
                    
                    # ✅ Collect class ID
                    class_ids.add(class_id)
                    file_has_labels = True
                    total_annotations += 1
                
                if file_has_labels:
                    files_with_labels += 1
                    
        except UnicodeDecodeError as e:
            print(f"ERROR: Encoding error reading {label_filename}: {e}", file=sys.stderr)
            print(f"ERROR: File may be corrupted or not UTF-8 encoded", file=sys.stderr)
            files_failed.append(label_filename)
            sys.exit(1)
        except PermissionError as e:
            print(f"ERROR: Permission denied reading {label_filename}: {e}", file=sys.stderr)
            files_failed.append(label_filename)
            sys.exit(1)
        except OSError as e:
            print(f"ERROR: OS error reading {label_filename}: {e}", file=sys.stderr)
            files_failed.append(label_filename)
            sys.exit(1)
        except Exception as e:
            print(f"ERROR: Unexpected error reading {label_filename}: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            files_failed.append(label_filename)
            sys.exit(1)
    
    # ✅ Validate that we found at least some labels
    if files_failed:
        print(f"ERROR: Failed to read {len(files_failed)} label file(s)", file=sys.stderr)
        print(f"ERROR: Failed files: {files_failed[:5]}...", file=sys.stderr)  # Show first 5
        sys.exit(1)
    
    if not class_ids:
        print(f"ERROR: No valid class IDs found in any label files!", file=sys.stderr)
        print(f"ERROR: Scanned {files_scanned} files, found {files_with_labels} files with labels", file=sys.stderr)
        print(f"ERROR: All label files appear to be empty or contain invalid data", file=sys.stderr)
        sys.exit(1)
    
    # ✅ Sort class IDs deterministically
    sorted_class_ids = sorted(class_ids)
    num_classes = len(sorted_class_ids)
    
    # ✅ Log summary
    print(f"✅ Successfully scanned {files_scanned} label files")
    print(f"✅ Found {files_with_labels} files with labels ({total_annotations} total annotations)")
    print(f"✅ Detected {num_classes} classes: {sorted_class_ids}")
    sys.stdout.flush()
    
    # ✅ Read existing data.yaml to preserve original category names
    try:
        with open(data_yaml_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        print(f"ERROR: Cannot read data.yaml: {data_yaml_path}", file=sys.stderr)
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    
    # ✅ Extract existing category names from data.yaml
    existing_names = []
    in_names_section = False
    for line in content.split('\n'):
        if line.strip().startswith('names:'):
            in_names_section = True
            continue
        elif in_names_section:
            if line.strip().startswith('-'):
                # Extract name: "  - Right screw missing" -> "Right screw missing"
                name = line.strip()[1:].strip()
                if name:
                    existing_names.append(name)
            elif line.strip() and not line.strip().startswith('#'):
                # End of names section (next non-comment line)
                in_names_section = False
    
    # ✅ Validate: Check if we have enough names for detected classes
    if len(existing_names) < num_classes:
        print(f"WARNING: data.yaml has {len(existing_names)} names but {num_classes} classes detected", file=sys.stderr)
        print(f"WARNING: Using existing names and padding with generic names if needed", file=sys.stderr)
        # Pad with generic names if needed
        while len(existing_names) < num_classes:
            existing_names.append(f'class_{len(existing_names)}')
    
    # ✅ Map class IDs to names: class_id 0 -> existing_names[0], class_id 1 -> existing_names[1], etc.
    preserved_names = []
    for class_id in sorted_class_ids:
        if class_id < len(existing_names):
            preserved_names.append(existing_names[class_id])
        else:
            # Fallback if class_id is out of range
            preserved_names.append(f'class_{class_id}')
    
    # ✅ Log preserved names
    if existing_names:
        print(f"✅ Preserving original category names: {preserved_names}")
    else:
        print(f"⚠️ No existing names found in data.yaml, using generic names: {preserved_names}")
    sys.stdout.flush()
    
    # ✅ Update nc and names (preserve original names)
    lines = content.split('\n')
    updated_lines = []
    in_names_section_to_skip = False
    for line in lines:
        if line.startswith('nc:'):
            updated_lines.append(f'nc: {num_classes}')
        elif line.startswith('names:'):
            updated_lines.append('names:')
            for name in preserved_names:  # ✅ FIX: Use preserved original names
                updated_lines.append(f'  - {name}')
            in_names_section_to_skip = True  # ✅ Skip old name lines
        elif in_names_section_to_skip:
            # ✅ Skip old name lines (lines starting with '-' or empty lines after names:)
            if line.strip().startswith('-') or (line.strip() == ''):
                continue  # Skip this old name line
            else:
                # ✅ End of names section, process this line normally
                in_names_section_to_skip = False
                updated_lines.append(line)
        else:
            updated_lines.append(line)
    
    # ✅ Write updated data.yaml
    try:
        with open(data_yaml_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(updated_lines))
    except Exception as e:
        print(f"ERROR: Cannot write data.yaml: {data_yaml_path}", file=sys.stderr)
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    
    print(f"✅ Updated data.yaml: {num_classes} classes")
    sys.stdout.flush()
    return num_classes, preserved_names


def train_yolo(config):
    """Train YOLO model with given configuration."""
    try:
        # Extract config values
        epochs = config.get('epochs', 100)
        batch = config.get('batch', 16)
        imgsz = config.get('imgsz', 640)
        lr0 = config.get('lr0', 0.01)
        workers = config.get('workers', 4)
        data_yaml = config.get('data')
        project = config.get('project')
        name = config.get('name', 'train')
        model_path = config.get('model')  # Base model path (optional)
        task = config.get('task', 'detect')
        exist_ok = config.get('exist_ok', True)
        
        # Validate required fields
        if not data_yaml:
            print("ERROR: 'data' field (path to data.yaml) is required in config", file=sys.stderr)
            sys.exit(1)
        
        if not os.path.exists(data_yaml):
            print(f"ERROR: data.yaml not found: {data_yaml}", file=sys.stderr)
            sys.exit(1)
        
        # Update data.yaml with actual class information
        # ✅ This will exit with error code 1 if labels are invalid or unreadable
        dataset_path = os.path.dirname(data_yaml)
        num_classes, class_names = update_data_yaml(data_yaml, dataset_path, task=task)
        
        # ✅ Validate that data.yaml was updated correctly
        if num_classes == 0:
            print("ERROR: data.yaml update returned 0 classes - this should never happen!", file=sys.stderr)
            sys.exit(1)
        
        print(f"✅ Verified data.yaml contains {num_classes} classes: {class_names}")
        sys.stdout.flush()

        # ✅ YOLO crashes if images/val is empty (common on tiny datasets after floor split)
        ensure_nonempty_val(dataset_path, data_yaml)
        
        # Load model
        if model_path and os.path.exists(model_path):
            print(f"Loading base model from: {model_path}")
            sys.stdout.flush()
            model = YOLO(model_path)
            print("✅ Model loaded successfully")
            sys.stdout.flush()
        else:
            # Use default YOLOv8n if no model specified
            default_model = 'yolov8n-seg.pt' if task == 'segment' else 'yolov8n.pt'
            print(f"Using default {default_model} model")
            sys.stdout.flush()
            model = YOLO(default_model)
            print("✅ Model loaded successfully")
            sys.stdout.flush()
        
        # Prepare training arguments
        # ✅ Explicitly set device to use GPU if available, otherwise CPU
        import torch
        device = '0' if torch.cuda.is_available() else 'cpu'
        device_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'
        if device == 'cpu':
            # A small CPU server (2 vCPUs, a few GB for training): fewer loader processes and a
            # smaller batch keep memory low without slowing it down
            batch = min(batch, 8)
            workers = min(workers, 1)

        train_args = {
            'data': data_yaml,
            'epochs': epochs,
            'batch': batch,
            'imgsz': imgsz,
            'lr0': lr0,
            'workers': workers,
            'project': project,
            'name': name,
            'exist_ok': exist_ok,
            'verbose': True,  # Enable verbose output for log parsing
            'device': device,  # ✅ Explicitly set device (GPU if available)
            'hsv_h': config.get('hsv_h', 0.0),
            'hsv_s': config.get('hsv_s', 0.7),
            'hsv_v': config.get('hsv_v', 0.4),
            'fliplr': config.get('fliplr', 0.5),
            'mosaic': config.get('mosaic', 1.0),
            'mixup': config.get('mixup', 0.0),
        }
        
        # Start training
        print(f"Starting YOLO training...")
        print(f"Device: {device_name} (device={device})")
        print(f"Config: epochs={epochs}, batch={batch}, imgsz={imgsz}, lr0={lr0}, workers={workers}")
        print(f"Dataset: {data_yaml}")
        print(f"Output: {project}/{name}")
        print("-" * 80)
        
        # ✅ Progress indicators for data loading phase
        print("📦 Preparing dataset and data loaders...")
        sys.stdout.flush()  # Ensure message appears immediately
        
        # Warn about large image sizes
        if imgsz >= 1024:
            print(f"⏳ Large image size ({imgsz}x{imgsz}) detected. Data loading and augmentation may take several minutes...")
            print(f"💡 Tip: Consider using smaller image size (e.g., 640) for faster training on CPU")
            sys.stdout.flush()
        elif imgsz >= 640:
            print(f"⏳ Medium image size ({imgsz}x{imgsz}) detected. Data loading may take 1-2 minutes...")
            sys.stdout.flush()
        
        print("🔄 Creating data loaders and applying augmentations...")
        sys.stdout.flush()
        
        print("🚀 Starting training (first epoch will begin shortly)...")
        sys.stdout.flush()
        
        # Train the model
        results = model.train(**train_args)
        
        # Training completed successfully
        print("-" * 80)
        print("Training completed successfully!")
        
        # Print final metrics
        if hasattr(results, 'results_dict'):
            metrics = results.results_dict
            print(f"Final metrics:")
            if 'metrics/mAP50(B)' in metrics:
                print(f"  mAP50(B): {metrics['metrics/mAP50(B)']:.4f}")
            if 'metrics/mAP50-95(B)' in metrics:
                print(f"  mAP50-95(B): {metrics['metrics/mAP50-95(B)']:.4f}")
            if 'metrics/precision(B)' in metrics:
                print(f"  Precision(B): {metrics['metrics/precision(B)']:.4f}")
            if 'metrics/recall(B)' in metrics:
                print(f"  Recall(B): {metrics['metrics/recall(B)']:.4f}")
            if 'metrics/mAP50(M)' in metrics:
                print(f"  mAP50(M): {metrics['metrics/mAP50(M)']:.4f}")
            if 'metrics/mAP50-95(M)' in metrics:
                print(f"  mAP50-95(M): {metrics['metrics/mAP50-95(M)']:.4f}")
            if 'metrics/precision(M)' in metrics:
                print(f"  Precision(M): {metrics['metrics/precision(M)']:.4f}")
            if 'metrics/recall(M)' in metrics:
                print(f"  Recall(M): {metrics['metrics/recall(M)']:.4f}")
        
        return 0
        
    except KeyboardInterrupt:
        print("\nTraining interrupted by user", file=sys.stderr)
        sys.exit(130)
    except Exception as e:
        print(f"ERROR: Training failed: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description='Train YOLO model')
    parser.add_argument('--config', required=True, help='Path to training config JSON file')
    
    args = parser.parse_args()
    
    # Load configuration
    config = load_config(args.config)
    
    # Train model
    exit_code = train_yolo(config)
    
    sys.exit(exit_code)


if __name__ == '__main__':
    main()

