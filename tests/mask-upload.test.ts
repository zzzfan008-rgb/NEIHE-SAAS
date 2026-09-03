import assert from "node:assert/strict";
import { createLatestMaskLoadGuard, saveMaskDraft, uploadMaskDraft } from "../src/lib/maskUpload";

console.log("蒙版保真上传协调测试");

const request = {
  dataUrl: "data:image/png;base64,cG5n",
  sourceRef: "/api/files/source.png",
  projectId: "project-a",
  nodeId: "mask-node",
};

let submittedBody: unknown;
const successfulFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  submittedBody = JSON.parse(String(init?.body));
  return Response.json({
    id: "mask-file.png",
    url: "/api/files/mask-file.png",
    mimeType: "image/png",
    width: 1024,
    height: 1024,
    byteLength: 1234,
    preserved: true,
  });
}) as typeof fetch;

const calls: string[] = [];
const uploaded = await saveMaskDraft(request, {
  commit: (url) => calls.push(`commit:${url}`),
  close: () => calls.push("close"),
}, successfulFetch);
assert.deepEqual(submittedBody, request);
assert.equal(uploaded.url, "/api/files/mask-file.png");
assert.deepEqual(calls, ["commit:/api/files/mask-file.png", "close"]);
console.log("  ✓ 仅在保真上传成功后提交短 URL 并关闭编辑器");

let failedCommits = 0;
let failedCloses = 0;
await assert.rejects(
  () => saveMaskDraft(request, {
    commit: () => { failedCommits += 1; },
    close: () => { failedCloses += 1; },
  }, (async () => Response.json({ error: "蒙版尺寸不一致" }, { status: 400 })) as typeof fetch),
  /蒙版尺寸不一致/,
);
assert.equal(failedCommits, 0);
assert.equal(failedCloses, 0);
console.log("  ✓ 上传失败时不覆盖旧蒙版也不关闭编辑器");

let closeAfterCommitFailure = 0;
await assert.rejects(
  () => saveMaskDraft(request, {
    commit: () => { throw new Error("原图已变化"); },
    close: () => { closeAfterCommitFailure += 1; },
  }, successfulFetch),
  /原图已变化/,
);
assert.equal(closeAfterCommitFailure, 0);
console.log("  ✓ 上传后提交校验失败时仍保持编辑器打开");

await assert.rejects(
  () => uploadMaskDraft(request, (async () => Response.json({
    url: "data:image/png;base64,cG5n",
    mimeType: "image/png",
    width: 1,
    height: 1,
    byteLength: 3,
    preserved: true,
  })) as typeof fetch),
  /未原样保存 PNG 蒙版/,
);
console.log("  ✓ 拒绝缺少本地 PNG 文件凭据的伪成功响应");

const loadGuard = createLatestMaskLoadGuard();
const firstLoad = loadGuard.begin();
assert.equal(firstLoad(), true);
loadGuard.invalidate();
assert.equal(firstLoad(), false, "输入变化后旧蒙版 Image 回调必须失效");
const latestLoad = loadGuard.begin();
assert.equal(latestLoad(), true);
loadGuard.begin();
assert.equal(latestLoad(), false, "后发加载必须取代先发加载");

const historyGuard = createLatestMaskLoadGuard();
let renderedSnapshot = "current-canvas";
const delayedUndo = historyGuard.begin();
const fastRedo = historyGuard.begin();
if (fastRedo()) renderedSnapshot = "redo";
if (delayedUndo()) renderedSnapshot = "undo";
assert.equal(renderedSnapshot, "redo", "后完成的旧 undo 不得覆盖先完成的新 redo");

const delayedHistory = historyGuard.begin();
historyGuard.invalidate();
renderedSnapshot = "direct-drawing";
if (delayedHistory()) renderedSnapshot = "stale-history";
assert.equal(renderedSnapshot, "direct-drawing", "继续绘制后旧历史回调不得覆盖画布");
console.log("  ✓ source 切换、后发历史加载与直接绘制都会废弃旧回调");

console.log("\n通过 5 项");
