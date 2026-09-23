import assert from "node:assert/strict";
import sharp from "sharp";
import { executeStep } from "../server/engine/runner";
import { ProviderError } from "../server/providers/base";
import type { AIProvider, ImageGenRequest } from "../src/types/workflow";

const images = await Promise.all(
  Array.from({ length: 4 }, async (_, index) => {
    const buffer = await sharp({
      create: {
        width: 40,
        height: 60,
        channels: 3,
        background: { r: index * 40, g: 80, b: 160 },
      },
    })
      .png()
      .toBuffer();
    return `data:image/png;base64,${buffer.toString("base64")}`;
  }),
);
const model = "gemini-3-pro-image-preview";
const step = {
  nodeId: "multi",
  kind: "virtual-try-on" as const,
  inputImages: images,
  params: {
    modelId: model,
    workflowStage: "scene-stabilize",
    sceneInputMode: "multi-reference-edit",
    candidateReviewMode: "disabled",
    qualityMode: "fast",
    sceneFraming: "custom",
    aspectRatio: "3:4",
    imageSize: "2K",
    modelOptions: { aspectRatio: "3:4", imageSize: "2K" },
  },
};
const roles = ["pose", "person", "scene", "outfit"];

async function run(
  responses: Array<"OTHER" | "SAFETY" | "NO_IMAGE" | "success">,
) {
  const requests: ImageGenRequest[] = [];
  const ordinals: number[] = [];
  const provider: AIProvider = {
    id: model,
    generate: async () => {
      throw new Error("must edit, not generate");
    },
    edit: async (request) => {
      requests.push(request);
      const response = responses[requests.length - 1];
      if (response !== "success") {
        const error = new ProviderError(
          "blocked",
          422,
          model,
          response === "NO_IMAGE" ? "invalid_response" : "content_refused",
        );
        error.blockReason = response === "NO_IMAGE" ? undefined : response;
        error.finishReason = response === "NO_IMAGE" ? response : undefined;
        throw error;
      }
      return { images: [images[0]], model };
    },
  };
  try {
    const result = await executeStep(step, images, () => provider, {
      referenceRoles: roles,
      beforeProviderCall: (ordinal) => {
        ordinals.push(ordinal);
      },
    });
    return { requests, ordinals, result };
  } catch (error) {
    return { requests, ordinals, error };
  }
}

const recovered = await run(["OTHER", "success"]);
assert.equal(recovered.requests.length, 2);
assert.deepEqual(
  recovered.ordinals,
  [1, 2],
  "each possible paid request must be recorded",
);
assert.deepEqual(recovered.requests[1].referenceEncoding, {
  quality: 88,
  longEdge: 2027,
});
assert.equal(recovered.result?.providerRequests, 2);
const refused = await run(["OTHER", "OTHER"]);
assert.equal(refused.requests.length, 2);
assert.match((refused.error as Error).message, /手动切换.*Flash|重新导出/);
assert.equal(
  (await run(["SAFETY", "success"])).requests.length,
  1,
  "safety must never retry",
);
const noImage = await run(["NO_IMAGE", "success"]);
assert.equal(noImage.requests.length, 2);
assert.match(noImage.requests[1].prompt, /只输出最终图片，不要输出文字/);
assert.deepEqual(noImage.ordinals, [1, 2]);
assert.equal(
  (await run(["NO_IMAGE", "NO_IMAGE"])).requests.length,
  2,
  "NO_IMAGE only retries once",
);
console.log("Multi-image provider recovery passed");
