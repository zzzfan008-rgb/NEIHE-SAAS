import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-video-store-"));
process.env.DATA_DIR = temp;

const fileStore = await import("../server/lib/fileStore");

console.log("视频文件存储大小边界测试");

const buffer = Buffer.alloc(32 * 1024 * 1024 + 1);
buffer.writeUInt32BE(buffer.byteLength, 0);
buffer.write("ftyp", 4, "ascii");
const dataUrl = `data:video/mp4;base64,${buffer.toString("base64")}`;

assert.throws(
  () => fileStore.saveVideoUploadDataUrl(dataUrl),
  /超过 32MB/,
  "用户上传仍必须受 32MB 限制",
);

const receipt = await fileStore.persistMediaRefWithReceipt(dataUrl, "generated-video-over-upload-limit");
try {
  assert.equal(receipt.created, true);
  assert.match(receipt.url, /^\/api\/files\/generated-/);
  assert.equal(fs.statSync(path.join(fileStore.uploadsDir(), receipt.id)).size, buffer.byteLength);
} finally {
  fileStore.deleteStoredImage(receipt.id);
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("  ✓ 用户上传限制为 32MB，Provider 生成视频可持久化到 100MB");
