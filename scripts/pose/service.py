"""Local DWPose ONNX worker. No diffusion model, gateway, or network inference."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np
import onnxruntime as ort

# Reuse the existing bounded, EXIF-aware normalized PNG decoder.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from depth.service import decode_image, MAX_BODY

FILES = {
    'onnxdet.py': '4c82a928ced32883b9a6acf89a2ce90ce9a266ab98c9e01231eb0f8d4a52751d',
    'onnxpose.py': '16fb69ab54f5e1ce8a5ad186e92f357da0162fc2ca2eeec4ccf1db72949291a2',
    'dw-ll_ucoco_384.onnx': '724f4ff2439ed61afb86fb8a1951ec39c6220682803b4a8bd4f598cd913b1843',
    'yolox_l.onnx': '7860ae79de6c89a3c1eb72ae9a2756c0ccfbe04b7791bb5880afabd97855a411',
}
MODEL = 'dwpose-wholebody'


class NoPersonError(ValueError):
    pass


def verify_file(path):
    with path.open('rb') as handle:
        actual = hashlib.file_digest(handle, 'sha256').hexdigest()
    if actual != FILES[path.name]:
        raise ValueError('DWPose source or model checksum mismatch')
    return actual


def draw_pose(shape, points, scores, threshold=0.3):
    """Draw COCO-WholeBody detections using OpenPose body ordering/colors.

    Own renderer: no copied ControlNet visualizer or image-model synthesis.
    Low-confidence/out-of-image keypoints are omitted, not filled in.
    """
    height, width = shape[:2]
    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    radius = max(2, round(min(height, width) / 200))
    colors = [(255,0,0),(255,85,0),(255,170,0),(255,255,0),(170,255,0),(85,255,0),
              (0,255,0),(0,255,85),(0,255,170),(0,255,255),(0,170,255),(0,85,255),
              (0,0,255),(85,0,255),(170,0,255),(255,0,255),(255,0,170),(255,0,85)]
    limbs = [(1,2),(1,5),(2,3),(3,4),(5,6),(6,7),(1,8),(8,9),(9,10),
             (1,11),(11,12),(12,13),(1,0),(0,14),(14,16),(0,15),(15,17)]
    mapping = [0,133,6,8,10,5,7,9,12,14,16,11,13,15,2,1,4,3]
    drawn = 0
    for xy, confidence in zip(points, scores):
        xy = np.concatenate([xy, np.mean(xy[[5,6]], axis=0)[None]])
        confidence = np.append(confidence, min(confidence[5], confidence[6]))
        valid = np.isfinite(xy).all(axis=1) & np.isfinite(confidence) & (confidence > threshold)
        valid &= (xy[:,0] >= 0) & (xy[:,0] < width) & (xy[:,1] >= 0) & (xy[:,1] < height)
        if valid[:17].sum() < 3:
            continue
        drawn += 1

        def dot(index, color, size=radius):
            if valid[index]:
                cv2.circle(canvas, tuple(xy[index].astype(int)), size, color[::-1], -1, cv2.LINE_AA)

        def line(a, b, color, thickness=radius):
            if valid[a] and valid[b]:
                cv2.line(canvas, tuple(xy[a].astype(int)), tuple(xy[b].astype(int)), color[::-1], thickness, cv2.LINE_AA)

        for i, (a,b) in enumerate(limbs):
            line(mapping[a], mapping[b], colors[i], radius * 2)
        for i,index in enumerate(mapping):
            dot(index, colors[i])
        # Native COCO-WholeBody: feet17:23, face23:91, hands91:112/112:133.
        for ankle,toes in [(15,(17,18,19)),(16,(20,21,22))]:
            for toe in toes:
                line(ankle,toe,(255,255,255))
                dot(toe,(255,255,255),max(1,radius//2))
        for i in range(23,91):
            dot(i,(255,255,255),max(1,radius//2))
        for offset in (91,112):
            for finger in range(5):
                chain = [offset] + list(range(offset + 1 + finger*4, offset + 5 + finger*4))
                color = colors[finger*3]
                for a,b in zip(chain,chain[1:]):
                    line(a,b,color,max(1,radius//2))
                for i in chain:
                    dot(i,color,max(1,radius//2))
    if not drawn:
        raise NoPersonError('No reliable person keypoints')
    ok, png = cv2.imencode('.png', canvas)
    if not ok:
        raise ValueError('PNG encoding failed')
    return png.tobytes()


def load_predictor(source, models):
    for name in FILES:
        verify_file((source if name.endswith('.py') else models) / name)
    sys.path.insert(0, str(source))
    from onnxdet import inference_detector
    from onnxpose import inference_pose
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    detector = ort.InferenceSession(str(models / 'yolox_l.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
    pose = ort.InferenceSession(str(models / 'dw-ll_ucoco_384.onnx'), sess_options=options, providers=['CPUExecutionProvider'])

    def predict(image):
        boxes = inference_detector(detector, image)
        if boxes is None or not len(boxes):
            raise NoPersonError('No person detected')
        if len(boxes) > 8:
            raise ValueError('Too many people; crop the reference')
        points, scores = inference_pose(pose, boxes, image)
        return draw_pose(image.shape, points, scores)

    return predict


def make_handler(predict, token, checkpoint):
    slot = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def log_message(self, *_args):
            pass

        def reply(self, status, data, mime='application/json'):
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Pose-Model', MODEL)
            self.send_header('X-Pose-Checkpoint', checkpoint)
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            supplied = self.headers.get('Authorization', '').encode('utf-8')
            if not hmac.compare_digest(supplied, ('Bearer ' + token).encode('ascii')):
                self.reply(401, b'{"error":"Unauthorized"}')
                return
            if self.path != '/pose':
                self.reply(404, b'{"error":"Not found"}')
                return
            if not slot.acquire(blocking=False):
                self.reply(429, b'{"error":"Pose worker busy"}')
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= MAX_BODY or self.headers.get('Transfer-Encoding'):
                    self.reply(413, b'{"error":"Invalid body size"}')
                    return
                payload = json.loads(self.rfile.read(size))
                if not isinstance(payload, dict):
                    raise ValueError('Expected object')
                self.reply(200, predict(decode_image(payload.get('image'))), 'image/png')
            except NoPersonError:
                self.reply(422, b'{"error":"No person detected"}')
            except (ValueError, TypeError, OSError):
                self.reply(400, b'{"error":"Invalid image or parameters"}')
            except Exception:
                self.reply(503, b'{"error":"Pose inference failed"}')
            finally:
                slot.release()

    return Handler


def main():
    token = os.environ.get('POSE_SERVICE_TOKEN', '').strip()
    if len(token) < 32 or not token.isascii():
        raise SystemExit('POSE_SERVICE_TOKEN must contain at least 32 ASCII characters')
    source = Path(os.environ['POSE_SOURCE_DIR']).resolve(strict=True)
    models = Path(os.environ['POSE_MODELS_DIR']).resolve(strict=True)
    predict = load_predictor(source, models)
    checkpoint = hashlib.sha256(''.join(FILES.values()).encode('ascii')).hexdigest()
    port = int(os.environ.get('POSE_SERVICE_PORT', '8767'))
    server = ThreadingHTTPServer(('127.0.0.1', port), make_handler(predict, token, checkpoint))
    print(f'DWPose ready on loopback port {port}; device=cpu; model={MODEL}', flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
