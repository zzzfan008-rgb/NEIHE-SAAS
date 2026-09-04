import assert from "node:assert/strict";
import {
  NODE_DISPLAY_META,
  deriveNodeDisplayState,
  type NodeDisplayState,
} from "../src/lib/nodeDisplayState";

console.log("节点十态派生契约测试");

const cases: Array<[NodeDisplayState, Parameters<typeof deriveNodeDisplayState>[0]]> = [
  ["idle", {}],
  ["missing-input", { missingInput: true }],
  ["ready", { executable: true }],
  ["queued", { runStatus: "queued", executable: true }],
  ["running", { runStatus: "running", missingInput: true }],
  ["retrying", { runStatus: "retry_wait", approvalStale: true }],
  ["success", { runStatus: "success", terminalMatchesBasis: true, executable: true }],
  ["failed", { runStatus: "error", terminalMatchesBasis: true, executable: true }],
  ["unknown-outcome", { runStatus: "outcome_unknown", terminalMatchesBasis: true }],
  ["needs-reconfirmation", { approvalStale: true, missingInput: true, executable: true }],
];

for (const [expected, input] of cases) {
  assert.equal(deriveNodeDisplayState(input), expected, expected);
}
console.log("  ✓ 活跃运行、过期确认、缺失输入、当前基准终态、可运行与空闲按固定优先级派生");

assert.equal(deriveNodeDisplayState({ runStatus: "cancel_requested", approvalStale: true }), "running");
assert.equal(deriveNodeDisplayState({ runStatus: "cancelled", executable: true }), "ready");
assert.equal(deriveNodeDisplayState({ runStatus: "success", terminalMatchesBasis: false, executable: true }), "ready");

assert.deepEqual(
  Object.keys(NODE_DISPLAY_META).sort(),
  cases.map(([state]) => state).sort(),
);
assert.deepEqual(
  Object.values(NODE_DISPLAY_META).map(({ label }) => label),
  ["空闲", "缺少输入", "可运行", "排队中", "运行中", "自动重试", "成功", "失败", "结果未知", "需要重新确认"],
);
assert.equal(new Set(Object.values(NODE_DISPLAY_META).map(({ label }) => label)).size, 10);
console.log("  ✓ 十个状态均有唯一中文标签和图标元数据");
