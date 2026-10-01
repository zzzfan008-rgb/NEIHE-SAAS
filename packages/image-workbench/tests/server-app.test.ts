import assert from "node:assert/strict";
import { once } from "node:events";
import { createImageWorkbenchApp } from "../server/app";

const server = createImageWorkbenchApp().listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
try {
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, status: "alive" });
  assert.equal(health.headers.has("x-powered-by"), false);
  for (const route of ["generate", "run-plan", "pose-references", "image-conversations", "files", "projects", "assets", "colors", "history", "usage", "prompt-optimize", "material-analyses", "drawing-boards", "outfit-analysis"]) {
    for (const method of ["GET", "POST"]) {
      const response = await fetch(`${base}/api/${route}`, { method });
      assert.equal(response.status, 401, `${method} ${route} must remain authenticated`);
    }
  }
  // Constructing an API does not launch a worker or call a real provider.
  console.log("server-app: health and 28 unauthenticated route checks passed");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
