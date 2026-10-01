#!/bin/sh
set -eu
# Runtime files are intentionally ignored by Git. HTTPS_PROXY may be set if needed.
cd "$(dirname "$0")/../.."
mkdir -p tmp/dwpose-source tmp/dwpose-models
source_revision=3dca5db79d9f9ffdd378753ddf6ec66535aace88
model_revision=1a7144101628d69ee7a3768d1ee3a094070dc388
for file in onnxdet.py onnxpose.py; do
  curl -fL --retry 2 --connect-timeout 20 --max-time 300 "https://raw.githubusercontent.com/IDEA-Research/DWPose/$source_revision/ControlNet-v1-1-nightly/annotator/dwpose/$file" -o "tmp/dwpose-source/$file"
done
curl -fL --max-time 60 "https://raw.githubusercontent.com/IDEA-Research/DWPose/$source_revision/LICENSE" -o tmp/dwpose-source/LICENSE
for file in dw-ll_ucoco_384.onnx yolox_l.onnx; do
  curl -fL --retry 2 --connect-timeout 20 --max-time 600 "https://huggingface.co/yzd-v/DWPose/resolve/$model_revision/$file" -o "tmp/dwpose-models/$file"
done
uv venv --python 3.11 tmp/dwpose-venv
uv pip install --python tmp/dwpose-venv/bin/python -r scripts/pose/requirements.txt
# Worker startup verifies the four pinned SHA-256 hashes before importing code.
