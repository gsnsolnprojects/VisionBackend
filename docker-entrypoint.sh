#!/bin/sh
# Prepare the /data volume, then start the server (run from /data).
set -e

mkdir -p /data/datasets /data/models/base /data/results /data/uploads /data/.ultralytics

# Base YOLO weights ship with the image; copy any that the volume doesn't have yet
for weights in /app/models/base/*; do
  [ -e "$weights" ] || continue
  target="/data/models/base/$(basename "$weights")"
  [ -e "$target" ] || cp "$weights" "$target"
done

exec "$@"
