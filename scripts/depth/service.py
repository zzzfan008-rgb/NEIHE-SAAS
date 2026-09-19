"""Authenticated loopback-only Depth Anything V2 Large worker (noncommercial).

Weights and upstream source stay outside git. Only the Node server calls this worker.
"""
import base64
import hashlib
import hmac
import io
import json
import os
import pathlib
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np
from PIL import Image, ImageOps

MAX_BODY = 28 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 40_000_000


def validate_size(size):
    if type(size) is not int or not 518 <= size <= 1036:
        raise ValueError("Invalid inference size")
    return size


def encode_depth(depth):
    if depth.ndim != 2 or depth.size == 0 or not np.isfinite(depth).all():
        raise ValueError("Invalid depth prediction")
    low, high = float(depth.min()), float(depth.max())
    # DA V2 relative inverse depth: higher values are nearer. No aesthetic gamma.
    gray = np.zeros(depth.shape, dtype=np.uint8) if high <= low else np.round(
        (depth - low) / (high - low) * 255
    ).astype(np.uint8)
    ok, encoded = cv2.imencode('.png', gray)
    if not ok:
        raise ValueError("PNG encoding failed")
    return encoded.tobytes()


def decode_image(value):
    if not isinstance(value, str) or not value.startswith('data:image/png;base64,'):
        raise ValueError("Expected normalized PNG")
    raw = base64.b64decode(value.split(',', 1)[1], validate=True)
    if len(raw) > 20 * 1024 * 1024:
        raise ValueError("Image too large")
    with Image.open(io.BytesIO(raw)) as image:
        if image.format != 'PNG' or image.width * image.height > 40_000_000:
            raise ValueError("Invalid image")
        rgb = np.array(ImageOps.exif_transpose(image).convert('RGB'))
    if max(rgb.shape[:2]) > 2048:
        raise ValueError("Expected normalized image size")
    # Upstream resizes the short edge to input_size. Bound elongated inputs
    # before that resize to prevent excessive MPS allocation.
    if max(rgb.shape[:2]) > min(rgb.shape[:2]) * 4:
        raise ValueError("Unsupported image aspect ratio")
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def make_handler(predict, token, checkpoint):
    slot = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def log_message(self, *_args):
            pass  # Never log tokens, request bodies, source images or local paths.

        def reply(self, code, body, mime='application/json'):
            self.send_response(code)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Depth-Model', 'depth-anything-v2-vitl')
            self.send_header('X-Depth-Checkpoint', checkpoint)
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                self.reply(401, b'{"error":"Unauthorized"}')
                return
            if self.path != '/depth':
                self.reply(404, b'{"error":"Not found"}')
                return
            if not slot.acquire(blocking=False):
                self.reply(429, b'{"error":"Depth worker busy"}')
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if size <= 0 or size > MAX_BODY or self.headers.get('Transfer-Encoding'):
                    self.reply(413, b'{"error":"Invalid body size"}')
                    return
                payload = json.loads(self.rfile.read(size))
                if not isinstance(payload, dict):
                    raise ValueError('Expected object')
                resolution = validate_size(payload.get('inputSize', 518))
                image = decode_image(payload.get('image'))
                result = encode_depth(predict(image, resolution))
                self.reply(200, result, 'image/png')
            except (ValueError, TypeError, OSError, Image.DecompressionBombError):
                self.reply(400, b'{"error":"Invalid image or parameters"}')
            except Exception:
                self.reply(503, b'{"error":"Depth inference failed"}')
            finally:
                slot.release()

    return Handler


def main():
    if os.environ.get('DEPTH_NONCOMMERCIAL_ACK') != 'true':
        raise SystemExit('V2 Large is CC-BY-NC-4.0. Set DEPTH_NONCOMMERCIAL_ACK=true only for permitted noncommercial use.')
    token = os.environ.get('DEPTH_SERVICE_TOKEN', '').strip()
    if len(token) < 32 or not token.isascii():
        raise SystemExit('DEPTH_SERVICE_TOKEN must contain at least 32 ASCII characters')
    source = pathlib.Path(os.environ['DEPTH_SOURCE_DIR']).resolve(strict=True)
    weights = pathlib.Path(os.environ['DEPTH_CHECKPOINT']).resolve(strict=True)
    sys.path.insert(0, str(source))
    import torch
    from depth_anything_v2.dpt import DepthAnythingV2

    if not torch.backends.mps.is_available():
        raise SystemExit('MPS unavailable; CPU fallback is intentionally disabled')
    with weights.open('rb') as handle:
        checkpoint = hashlib.file_digest(handle, 'sha256').hexdigest()
    model = DepthAnythingV2(encoder='vitl', features=256, out_channels=[256, 512, 1024, 1024])
    model.load_state_dict(torch.load(weights, map_location='cpu', weights_only=True))
    model = model.to('mps').eval()

    def predict(image, resolution):
        with torch.inference_mode():
            return model.infer_image(image, input_size=resolution)

    port = int(os.environ.get('DEPTH_SERVICE_PORT', '8766'))
    server = ThreadingHTTPServer(('127.0.0.1', port), make_handler(predict, token, checkpoint))
    print(f'Depth worker ready on loopback port {port}; device=mps; model=vitl', flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
