import base64
import json
import sys
import threading
import types
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from http.server import ThreadingHTTPServer


def install_model_dependency_stubs():
    for name in ('cv2', 'numpy', 'onnxruntime'):
        sys.modules[name] = types.ModuleType(name)
    pil = types.ModuleType('PIL')
    image = types.ModuleType('PIL.Image')
    image.MAX_IMAGE_PIXELS = None
    image.DecompressionBombError = type('DecompressionBombError', (Exception,), {})
    image_ops = types.ModuleType('PIL.ImageOps')
    pil.Image = image
    pil.ImageOps = image_ops
    sys.modules.update({'PIL': pil, 'PIL.Image': image, 'PIL.ImageOps': image_ops})


install_model_dependency_stubs()
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import scripts.pose.service as service  # noqa: E402


class DWPoseServiceProtocolTests(unittest.TestCase):
    def test_normalize_people_preserves_scores_and_marks_zero_as_missing(self):
        points = [[[15, 20] if index == 0 else [0, 0] for index in range(133)]]
        scores = [[0.8] + [0] * 132]
        person = service.normalize_people(points, scores, 30, 50)[0]
        self.assertEqual(person['keypoints'][0], {'x': 0.5, 'y': 0.4, 'confidence': 0.8})
        self.assertEqual(person['keypoints'][1:], [None] * 132)

    def test_normalize_people_rejects_out_of_canvas_keypoints(self):
        points = [[[30, 20]] + [[0, 0]] * 132]
        scores = [[0.8] + [0] * 132]
        with self.assertRaises(service.InvalidPoseOutputError):
            service.normalize_people(points, scores, 30, 50)


    def test_structured_endpoint_and_legacy_png_share_one_inference_contract(self):
        png = b'\x89PNG\r\n\x1a\nprotocol-fixture'
        keypoints = [None] * 133
        keypoints[0] = {'x': 0.25, 'y': 0.4, 'confidence': 0.8}
        inference = SimpleNamespace(image_png=png, width=30, height=50, people=[{'keypoints': keypoints}])
        calls = []
        image = object()

        def predict(value):
            calls.append(value)
            return inference

        service.decode_image = lambda _value: image
        token = 'test-token-for-local-worker-at-least-32'
        checkpoint = 'b' * 64
        server = ThreadingHTTPServer(('127.0.0.1', 0), service.make_handler(predict, token, checkpoint))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        encoded = base64.b64encode(b'input').decode()
        body = json.dumps({'image': 'data:image/png;base64,' + encoded}).encode()

        def post(path):
            request = urllib.request.Request(
                f'http://127.0.0.1:{server.server_port}{path}',
                data=body,
                headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
            )
            try:
                return urllib.request.urlopen(request, timeout=5)
            except urllib.error.HTTPError as error:
                self.fail(f'{path} returned HTTP {error.code}')

        try:
            with post('/pose/v1') as reply:
                payload = json.loads(reply.read())
                self.assertEqual(reply.headers['Content-Type'], 'application/json')
                self.assertEqual(reply.headers['X-Pose-Model'], 'dwpose-wholebody')
                self.assertEqual(reply.headers['X-Pose-Checkpoint'], checkpoint)
                self.assertEqual(payload['schemaVersion'], 1)
                self.assertEqual(payload['model'], 'dwpose-wholebody')
                self.assertEqual(payload['checkpoint'], checkpoint)
                self.assertEqual((payload['width'], payload['height']), (30, 50))
                self.assertEqual(base64.b64decode(payload['imagePngBase64'], validate=True), png)
                self.assertEqual(payload['people'], [{'keypoints': keypoints}])
            self.assertEqual(calls, [image], 'the rendered PNG and keypoints must come from one inference')

            with post('/pose') as reply:
                self.assertEqual(reply.headers['Content-Type'], 'image/png')
                self.assertEqual(reply.read(), png)
            self.assertEqual(calls, [image, image])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
