import base64
import importlib.util
import io
import json
from pathlib import Path
import threading
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer

import cv2
import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location('pose_service', Path(__file__).resolve().parents[1] / 'scripts/pose/service.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class PoseTests(unittest.TestCase):
    def test_renderer_omits_unreliable_points(self):
        xy = np.zeros((1,133,2), dtype=float)
        confidence = np.zeros((1,133), dtype=float)
        with self.assertRaises(service.NoPersonError):
            service.draw_pose((200,100,3),xy,confidence)
        xy[0,:17] = [[20+i*3,20+i*7] for i in range(17)]
        confidence[0,:17] = 0.9
        png = service.draw_pose((200,100,3),xy,confidence)
        decoded = cv2.imdecode(np.frombuffer(png,np.uint8),cv2.IMREAD_COLOR)
        self.assertEqual(decoded.shape,(200,100,3))
        self.assertTrue(decoded.any())

    def test_http_boundary(self):
        image = Image.new('RGB',(30,50),'white')
        output = io.BytesIO()
        image.save(output,format='PNG')
        png = output.getvalue()
        token = 'test-token-for-local-worker-at-least-32'
        calls = []

        def predict(value):
            calls.append(value.shape)
            return png

        server = ThreadingHTTPServer(('127.0.0.1',0),service.make_handler(predict,token,'a'*64))
        thread = threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        url = f'http://127.0.0.1:{server.server_port}/pose'

        def request(payload, auth=token):
            return urllib.request.urlopen(urllib.request.Request(url,data=json.dumps(payload).encode(),headers={'Authorization':'Bearer '+auth,'Content-Type':'application/json'}),timeout=5)

        try:
            payload = {'image':'data:image/png;base64,'+base64.b64encode(png).decode()}
            with request(payload) as reply:
                self.assertEqual(reply.headers['X-Pose-Model'],'dwpose-wholebody')
                self.assertEqual(reply.read(),png)
            for data,auth,code in [(payload,'invalid',401),({'image':'file:///private.png'},token,400),([],token,400)]:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    request(data,auth)
                self.assertEqual(error.exception.code,code)
            self.assertEqual(calls,[(50,30,3)])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
