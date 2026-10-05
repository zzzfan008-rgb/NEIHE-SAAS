import assert from "node:assert/strict";
import { useAiGatewayStore } from "../src/store/aiGatewayStore";
import type { AiGatewaySettings } from "../src/types/aiGateway";

const originalFetch = globalThis.fetch;
const settings = (activeGateway: "apiyi" | "tuzi", revision: number): AiGatewaySettings => ({
  activeGateway, revision, gateways: [
    { id: "apiyi", label: "APIYI", configured: true, imageModelIds: [] },
    { id: "tuzi", label: "TuziAPI", configured: true, imageModelIds: [] },
  ],
});
let reads = 0;
let writes = 0;
let release!: (response: Response) => void;
try {
  console.log("供应商客户端同步与过期响应回归");
  useAiGatewayStore.getState().bindOwner("admin");
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "PUT") {
      writes++;
      assert.deepEqual(JSON.parse(String(init.body)), { activeGateway: "tuzi", revision: 0 });
      return Response.json(settings("tuzi", 1));
    }
    reads++;
    if (reads === 1) return Response.json(settings("apiyi", 0));
    return new Promise<Response>((resolve) => { release = resolve; });
  }) as typeof fetch;
  await useAiGatewayStore.getState().refresh();
  const stale = useAiGatewayStore.getState().refresh();
  await useAiGatewayStore.getState().switchGateway("tuzi");
  release(Response.json(settings("apiyi", 0)));
  await stale;
  assert.equal(useAiGatewayStore.getState().settings?.activeGateway, "tuzi");
  assert.equal(writes, 1);
  const previousOwner = useAiGatewayStore.getState().refresh();
  useAiGatewayStore.getState().bindOwner("another-user");
  release(Response.json(settings("tuzi", 9)));
  await previousOwner;
  assert.equal(useAiGatewayStore.getState().settings, null);
  globalThis.fetch = (async () => Response.json(settings("tuzi", 2))) as typeof fetch;
  await useAiGatewayStore.getState().refresh();
  globalThis.fetch = (async (_url, init) => init?.method === "PUT"
    ? Response.json({ error: "设置冲突" }, { status: 409 }) : Response.json(settings("tuzi", 3))) as typeof fetch;
  await useAiGatewayStore.getState().switchGateway("apiyi");
  assert.equal(useAiGatewayStore.getState().settings?.activeGateway, "tuzi");
  assert.equal(useAiGatewayStore.getState().settings?.revision, 3);
  assert.equal(useAiGatewayStore.getState().error, "设置冲突");
  assert.equal(useAiGatewayStore.getState().changing, false);
  console.log("  ✓ 旧 GET 不覆盖新切换，退出后响应丢弃，冲突保留服务端真实状态");
  useAiGatewayStore.getState().bindOwner("reconnected-user");
  globalThis.fetch = (async () => Response.json({}, { status: 503 })) as typeof fetch;
  await useAiGatewayStore.getState().refresh();
  assert.ok(useAiGatewayStore.getState().error);
  globalThis.fetch = (async () => Response.json(settings("tuzi", 3))) as typeof fetch;
  await useAiGatewayStore.getState().refresh();
  assert.equal(useAiGatewayStore.getState().settings?.activeGateway, "tuzi");
  assert.equal(useAiGatewayStore.getState().error, null);
  console.log("  ✓ 首次读取失败后恢复时清除失效错误");
} finally {
  globalThis.fetch = originalFetch;
  useAiGatewayStore.getState().bindOwner(null);
}
