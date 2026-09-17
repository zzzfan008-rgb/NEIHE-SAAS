"""Local-only service tests. Never loads weights or calls a paid provider."""
import importlib.util
import pathlib
import unittest
import json
import threading
import urllib.error
import urllib.request
import base64
from http.server import ThreadingHTTPServer

import cv2
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("depth_service", ROOT / "scripts/depth/service.py")


class DepthServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(cls.service)

    def test_depth_is_near_white_and_keeps_geometry(self):
        depth = np.array([[0., 1., 2.], [2., 1., 0.]], dtype=np.float32)
        result = self.service.encode_depth(depth)
        decoded = cv2.imdecode(np.frombuffer(result, np.uint8), cv2.IMREAD_GRAYSCALE)
        self.assertEqual(decoded.shape, (2, 3))
        self.assertEqual(int(decoded[0, 0]), 0)
        self.assertEqual(int(decoded[0, 2]), 255)

    def test_flat_depth_is_finite(self):
        result = self.service.encode_depth(np.ones((2, 3), dtype=np.float32))
        decoded = cv2.imdecode(np.frombuffer(result, np.uint8), cv2.IMREAD_GRAYSCALE)
        self.assertTrue(np.all(decoded == 0))

    def test_invalid_predictions_rejected(self):
        for depth in [np.array([[np.nan]]), np.array([[np.inf]]), np.zeros((2, 2, 3))]:
            with self.assertRaises(ValueError):
                self.service.encode_depth(depth)

    def test_size_is_bounded(self):
        for size in [0, 20000, "518", True]:
            with self.assertRaises(ValueError):
                self.service.validate_size(size)
        self.assertEqual(self.service.validate_size(518), 518)

    def test_extreme_aspect_ratio_rejected_before_model(self):
        raw = cv2.imencode('.png', np.zeros((1, 2048, 3), dtype=np.uint8))[1].tobytes()
        with self.assertRaises(ValueError):
            self.service.decode_image('data:image/png;base64,' + base64.b64encode(raw).decode())

    def test_http_auth_and_inference_contract(self):
        calls = []
        def predict(image, size):
            calls.append((image.shape, size))
            return np.arange(image.shape[0] * image.shape[1], dtype=np.float32).reshape(image.shape[:2])
        token = 'test-only-token-at-least-32-characters'
        server = ThreadingHTTPServer(('127.0.0.1', 0), self.service.make_handler(predict, token, 'a' * 64))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f'http://127.0.0.1:{server.server_port}/depth'
            png = cv2.imencode('.png', np.zeros((10, 20, 3), dtype=np.uint8))[1].tobytes()
            body = json.dumps({'image': 'data:image/png;base64,' + base64.b64encode(png).decode(), 'inputSize': 518}).encode()
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(urllib.request.Request(url, body))
            self.assertEqual(error.exception.code, 401)
            self.assertEqual(calls, [])
            req = urllib.request.Request(url, body, {'Authorization': 'Bearer ' + token})
            with urllib.request.urlopen(req) as response:
                self.assertEqual(response.headers['X-Depth-Checkpoint'], 'a' * 64)
                decoded = cv2.imdecode(np.frombuffer(response.read(), np.uint8), cv2.IMREAD_GRAYSCALE)
                self.assertEqual(decoded.shape, (10, 20))
            self.assertEqual(calls, [((10, 20, 3), 518)])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
