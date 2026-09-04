import assert from "node:assert/strict";
import {
  VIDEO_CAPABILITY_APPROVAL,
  VIDEO_CAPABILITIES,
  resolveVideoCapability,
  videoCapabilityToolItems,
} from "../src/lib/videoCapabilities";

console.log("视频能力安全门禁测试");

assert.deepEqual(VIDEO_CAPABILITIES.map(({ id, name }) => ({ id, name })), [
  { id: "text-to-video", name: "文生视频" },
  { id: "keyframes-to-video", name: "首尾帧生视频" },
  { id: "multi-image-video", name: "多图参考生视频" },
  { id: "video-to-video", name: "视频生视频" },
]);
assert.equal(new Set(VIDEO_CAPABILITIES.map((item) => item.disabledReason)).size, 4, "每项能力需要具体、可区分的禁用原因");

const current = videoCapabilityToolItems();
for (const item of current) {
  assert.equal(item.availability, "available");
  assert.equal(item.capabilityGate?.approvalState, "approved");
  assert.equal(item.creationIntent?.type, "workflow-template");
  assert.match(item.creationIntent?.templateId ?? "", /^builtin-tool-/);
}
assert.ok(VIDEO_CAPABILITY_APPROVAL.acceptanceRecordId.includes("2026-09-03"));

const descriptor = VIDEO_CAPABILITIES[0];
const implementation = { type: "future-video-node", capabilityId: descriptor.id } as const;
const completeApproval = {
  independentSpecId: "spec-video-001",
  generationContractId: "contract-video-v1",
  acceptanceRecordId: "acceptance-video-001",
  approvedAt: "2026-09-03T00:00:00.000Z",
};
assert.equal(resolveVideoCapability(descriptor, undefined, implementation).availability, "unavailable");
for (const missing of Object.keys(completeApproval) as Array<keyof typeof completeApproval>) {
  assert.equal(resolveVideoCapability(descriptor, { ...completeApproval, [missing]: "" }, implementation).availability, "unavailable");
}
assert.equal(resolveVideoCapability(descriptor, completeApproval).availability, "unavailable", "没有注册实现时即使审批齐全也必须 fail closed");
const { disabledReason: _disabledReason, ...enabledDescriptor } = descriptor;
assert.deepEqual(resolveVideoCapability(descriptor, completeApproval, implementation), {
  ...enabledDescriptor, availability: "available", creationIntent: implementation, approvalState: "approved",
});

console.log("视频能力安全门禁测试通过");
