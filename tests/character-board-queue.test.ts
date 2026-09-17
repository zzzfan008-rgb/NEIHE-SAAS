import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";
import { ProviderError } from "../server/providers/base";
import { DEFAULT_GENERATION_MODEL_ID } from "../src/types/imageModels";
import type { AIProvider, NodeExecution } from "../src/types/workflow";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "character-board-queue-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "board-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";
await resetPostgresTestDatabase();
const db = await import("../server/lib/database");
const queue = await import("../server/engine/runQueue");
const files = await import("../server/lib/fileStore");
await db.initializeDatabase();
const owner = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE account_id='board-admin'"))!;
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
try {
  const input = await files.persistImageRef(image);
  for (const failure of [undefined, "invalid_request", "outcome_unknown"] as const) {
    const step: NodeExecution = { nodeId: "board", kind: "character-board", inputImages: [input], upstream: [], params: { modelId: DEFAULT_GENERATION_MODEL_ID, batchSize: 1 } };
    const run = await queue.enqueueGenerationRun({ steps: [step] }, owner.id, { userId: owner.id, nodeId: "board", nodeLabel: "人物板生成", kind: "character-board", requestedCount: 1 });
    let calls = 0;
    const provider: AIProvider = {
      id: "apiyi", generate: async () => { throw new Error("人物板必须编辑参考图"); },
      edit: async (request) => {
        calls++;
        assert.equal(request.referenceImages?.length, 1);
        assert.equal(request.aspectRatio, "3:4");
        if (failure) throw new ProviderError("mock failure", 400, "apiyi", failure);
        return { images: [image], model: DEFAULT_GENERATION_MODEL_ID };
      },
    };
    await queue.processNextGenerationJob("board-test", { resolveProvider: () => provider });
    assert.equal(calls, 1);
    const record = await db.queryOne<{ status: string; successful_count: number; provider_requests: number }>("SELECT status, successful_count, provider_requests FROM generation_runs WHERE id=$1", [run.id]);
    assert.equal(record?.status, failure === "outcome_unknown" ? "outcome_unknown" : failure ? "failed" : "succeeded");
    assert.equal(record?.successful_count, failure ? 0 : 1);
    assert.equal(record?.provider_requests, 1);
    const events = await queue.readDurableRunEvents(run.id, owner.id, 0);
    assert.ok(events?.some((event) => event.type === "node-status" && event.status === (failure === "outcome_unknown" ? "outcome_unknown" : failure ? "error" : "success")));
    await queue.processNextGenerationJob("board-test", { resolveProvider: () => provider });
    assert.equal(calls, 1, "已结束或结果未知的任务不可重复付费调用");
  }
  const poseStep: NodeExecution = {
    nodeId: "pose",
    kind: "character-board",
    inputImages: [input],
    upstream: [],
    params: { modelId: DEFAULT_GENERATION_MODEL_ID, batchSize: 8, poseOutfitOnly: true },
  };
  const poseRun = await queue.enqueueGenerationRun({ steps: [poseStep] }, owner.id, {
    userId: owner.id,
    nodeId: "pose",
    nodeLabel: "姿势参考·背心+短裤",
    kind: "pose-reference-outfit",
    requestedCount: 1,
  });
  let poseRequest: ImageGenRequest | undefined;
  const poseProvider: AIProvider = {
    id: "apiyi",
    generate: async () => { throw new Error("背心+短裤参考必须编辑原图"); },
    edit: async (request) => {
      poseRequest = request;
      return { images: [image], model: DEFAULT_GENERATION_MODEL_ID };
    },
  };
  await queue.processNextGenerationJob("board-test", { resolveProvider: () => poseProvider });
  assert.equal(poseRequest?.batchSize, 1);
  assert.equal(poseRequest?.aspectRatio, "1:1", "姿势替换应跟随原图画布比例");
  assert.equal(poseRequest?.referenceImages?.length, 1);
  assert.match(poseRequest?.prompt ?? "", /浅白色.*背心/);
  assert.match(poseRequest?.prompt ?? "", /浅白色.*短裤/);
  assert.doesNotMatch(poseRequest?.prompt ?? "", /严格2×2|左上：|右上：|四格必须|人物身份参考板/);
  const poseRecord = await db.queryOne<{ status: string; successful_count: number }>("SELECT status, successful_count FROM generation_runs WHERE id=$1", [poseRun.id]);
  assert.equal(poseRecord?.status, "succeeded");
  assert.equal(poseRecord?.successful_count, 1);
  console.log("character-board durable queue: uploaded reference, success, failure and unknown result passed");
} finally {
  await db.closeDatabaseForTests();
  fs.rmSync(temp, { recursive: true, force: true });
}
