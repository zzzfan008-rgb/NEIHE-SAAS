import assert from "node:assert/strict";

import {
  buildConversationContext,
  closestImageConversationAspectRatio,
  createConversationRequestSnapshot,
  createEmptyModeDrafts,
  getImageConversationModelCapabilities,
  getImageConversationModelsForMode,
  IMAGE_CONVERSATION_ASPECT_RATIOS,
  mergeEffectiveRequirements,
  validateModelCompatibility,
  validateImageConversationParameters,
  validateConversationDraft,
  validateInputManifest,
  validateOutputCount,
} from "../src/lib/imageConversationRules";
import type {
  ConversationImageInput,
  ImageConversationDraft,
  ImageConversationContext,
  ImageConversationModelCapabilities,
} from "../src/types/imageConversation";

function expectThrows(fn: () => unknown, message: string) {
  let didThrow = false;
  try {
    fn();
  } catch {
    didThrow = true;
  }
  assert.equal(didThrow, true, message);
}

function imageInput(
  role: ConversationImageInput["role"],
  ordinal: number,
  sourceRef = `asset-${ordinal}`,
): ConversationImageInput {
  return { role, ordinal, sourceRef };
}

function draft(
  overrides: Partial<ImageConversationDraft> = {},
): ImageConversationDraft {
  return {
    mode: "single",
    inputs: [imageInput("base", 0)],
    prompt: "把衣服改成黑色",
    parameters: {
      modelId: "gpt-image-2.5",
      quality: "high",
      outputCount: 1,
    },
    ...overrides,
  };
}

assert.equal(validateOutputCount(1), 1);
assert.equal(validateOutputCount(8), 8);
for (const count of [3, 5, 6, 7]) {
  assert.equal(validateOutputCount(count), count);
}
for (const invalid of [0, 9, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null]) {
  expectThrows(() => validateOutputCount(invalid), `invalid output count: ${String(invalid)}`);
}

assert.deepEqual(
  validateInputManifest("single", [imageInput("base", 0)]),
  [imageInput("base", 0)],
);
assert.deepEqual(
  validateInputManifest("fusion", [
    imageInput("base", 0),
    imageInput("reference", 1),
    imageInput("reference", 2),
  ]),
  [imageInput("base", 0), imageInput("reference", 1), imageInput("reference", 2)],
);
assert.deepEqual(
  validateInputManifest("mask", [imageInput("base", 0), imageInput("reference", 1)]),
  [imageInput("base", 0), imageInput("reference", 1)],
);
expectThrows(() => validateInputManifest("single", []), "single requires one input");
expectThrows(
  () => validateInputManifest("single", [imageInput("base", 0), imageInput("reference", 1)]),
  "single rejects multiple inputs",
);
expectThrows(
  () => validateInputManifest("fusion", [imageInput("base", 0)]),
  "fusion requires at least two inputs",
);
expectThrows(
  () =>
    validateInputManifest("fusion", [
      imageInput("base", 0),
      ...Array.from({ length: 8 }, (_, index) => imageInput("reference", index + 1)),
    ]),
  "fusion accepts at most eight inputs",
);
expectThrows(
  () => validateInputManifest("mask", [imageInput("reference", 0), imageInput("base", 1)]),
  "mask requires the first input to be the base",
);
expectThrows(
  () =>
    validateInputManifest("mask", [
      imageInput("base", 0),
      ...Array.from({ length: 7 }, (_, index) => imageInput("reference", index + 1)),
    ]),
  "mask accepts at most six references",
);
expectThrows(
  () => validateInputManifest("fusion", [imageInput("base", 5), imageInput("reference", 1)]),
  "ordinals must match array order",
);

assert.equal(validateConversationDraft(draft()), true);
expectThrows(
  () => validateConversationDraft(draft({ prompt: "   " })),
  "prompt is required",
);
expectThrows(
  () =>
    validateConversationDraft(
      draft({ parameters: { modelId: "", quality: "high", outputCount: 1 } }),
    ),
  "model is required",
);
expectThrows(
  () => validateConversationDraft(draft({ parameters: { modelId: "model", quality: "", outputCount: 1 } })),
  "quality is required",
);
expectThrows(
  () => validateConversationDraft(draft({ parameters: { modelId: "model", quality: "high", outputCount: 9 } })),
  "output count is validated in the draft",
);

const merged = mergeEffectiveRequirements(
  { color: "white", fit: "oversized" },
  { color: "black", material: "wool" },
);
assert.deepEqual(merged, { color: "black", fit: "oversized", material: "wool" });

const baseContext: ImageConversationContext = {
  sourceResultId: "result-a",
  effectiveRequirements: { color: "black", fit: "oversized" },
  appliedRelativeActions: ["remove logo"],
};
const context = buildConversationContext(baseContext, {
  sourceResultId: "result-b",
  effectiveRequirements: { color: "navy" },
  appliedRelativeActions: ["remove logo", "add pocket"],
});
assert.deepEqual(context, {
  sourceResultId: "result-b",
  effectiveRequirements: { color: "navy", fit: "oversized" },
  appliedRelativeActions: ["remove logo", "add pocket"],
});

const branchContext = buildConversationContext(baseContext, {
  sourceResultId: "result-c",
  effectiveRequirements: { neckline: "round" },
  appliedRelativeActions: [],
});
assert.equal(branchContext.effectiveRequirements.color, "black");
assert.equal(branchContext.effectiveRequirements.neckline, "round");

const modeDrafts = createEmptyModeDrafts();
modeDrafts.single.prompt = "single only";
modeDrafts.single.inputs.push(imageInput("base", 0));
assert.equal(modeDrafts.fusion.prompt, "");
assert.equal(modeDrafts.fusion.inputs.length, 0);
assert.equal(modeDrafts.mask.inputs.length, 0);

const capabilities: ImageConversationModelCapabilities = {
  modes: ["single", "fusion"],
  qualities: ["medium", "high"],
  sizes: ["2K", "4K"],
  aspectRatios: ["1:1", "source"],
};
assert.equal(
  validateModelCompatibility(
    "single",
    { modelId: "model", quality: "high", outputCount: 5, size: "4K", aspectRatio: "1:1" },
    capabilities,
  ),
  true,
);
expectThrows(
  () =>
    validateModelCompatibility(
      "mask",
      { modelId: "model", quality: "medium", outputCount: 1, aspectRatio: "1:1" },
      capabilities,
    ),
  "model does not support mask mode",
);
expectThrows(
  () =>
    validateModelCompatibility(
      "single",
      { modelId: "model", quality: "low", outputCount: 1 },
      capabilities,
    ),
  "model does not support the selected quality",
);

const gptImageCapabilities = getImageConversationModelCapabilities("gpt-image-2.5-sunburst");
assert.deepEqual(gptImageCapabilities?.qualities, ["low", "medium", "high", "xhigh", "max"]);
assert.deepEqual(gptImageCapabilities?.sizes, ["2K", "4K"]);
assert.deepEqual(gptImageCapabilities?.aspectRatios, [...IMAGE_CONVERSATION_ASPECT_RATIOS]);
for (const mode of ["single", "fusion", "mask"] as const) {
  assert.deepEqual(
    getImageConversationModelsForMode(mode),
    ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"],
    `model list is capability-filtered for ${mode}`,
  );
}
assert.equal(validateImageConversationParameters("single", {
  modelId: "gpt-image-2.5-sunburst",
  quality: "medium",
  outputCount: 1,
  size: "2K",
  aspectRatio: "1:1",
  aspectRatioMode: "follow",
}), true);
expectThrows(
  () => validateImageConversationParameters("mask", {
    modelId: "gpt-image-2",
    quality: "medium",
    outputCount: 1,
  }),
  "conversation rejects a model that is not enabled for this feature",
);
expectThrows(
  () => validateImageConversationParameters("single", {
    modelId: "gpt-image-2.5-sunburst",
    quality: "medium",
    outputCount: 1,
    size: "8K",
  }),
  "conversation rejects unsupported model sizes",
);
expectThrows(
  () => validateImageConversationParameters("mask", {
    modelId: "gpt-image-2.5-sunburst",
    quality: "medium",
    outputCount: 1,
    aspectRatioMode: "fixed",
  }),
  "mask mode must follow the base image aspect ratio",
);
assert.equal(closestImageConversationAspectRatio(1600, 900), "16:9");
assert.equal(closestImageConversationAspectRatio(900, 1600), "9:16");
assert.equal(closestImageConversationAspectRatio(0, 0), "1:1");

const snapshotDraft = draft({
  parameters: {
    modelId: "model",
    quality: "medium",
    outputCount: 3,
    size: "2K",
    aspectRatio: "source",
  },
});
const snapshot = createConversationRequestSnapshot(snapshotDraft, baseContext);
snapshotDraft.prompt = "changed after submit";
snapshotDraft.inputs[0].sourceRef = "changed-after-submit";
snapshotDraft.parameters.quality = "high";
assert.equal(snapshot.prompt, "把衣服改成黑色");
assert.equal(snapshot.inputs[0].sourceRef, "asset-0");
assert.equal(snapshot.parameters.quality, "medium");
assert.equal(Object.isFrozen(snapshot), true);
assert.equal(Object.isFrozen(snapshot.inputs), true);
assert.equal(Object.isFrozen(snapshot.parameters), true);

console.log("image-conversation-rules: ok");
