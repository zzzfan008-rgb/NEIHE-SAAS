import assert from "node:assert/strict";
import fs from "node:fs";

console.log("分步换装紧凑 UI 契约测试");

const read = (path: string) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const roleDialogPath = new URL("../src/components/workbench/ConnectionRoleDialog.tsx", import.meta.url);
const approvalNodePath = new URL("../src/components/nodes/StageApprovalNode.tsx", import.meta.url);

assert.equal(fs.existsSync(roleDialogPath), true, "必须提供独立的连线角色确认对话框");
assert.equal(fs.existsSync(approvalNodePath), true, "必须提供独立的第一轮基准确认节点");

const roleDialog = fs.readFileSync(roleDialogPath, "utf8");
const approvalNode = fs.readFileSync(approvalNodePath, "utf8");
const stagedNode = read("src/components/nodes/VirtualTryOnNode.tsx");
const workflowPorts = read("src/lib/workflowPorts.ts");
const inspector = read("src/components/panels/InspectorPanel.tsx");

for (const contract of ["确认连接角色", "已连接来源", "取消", "确认连接"]) {
  assert.match(roleDialog, new RegExp(contract), `角色确认 UI 缺少“${contract}”`);
}
assert.match(roleDialog, /connectionDraftError/, "角色不匹配、重复或超限错误必须在对话框中用业务名称展示");
assert.match(roleDialog, /compatibleUnused|availableRoles|compatibleRoles/, "对话框只能列出兼容且尚未占用的角色");

for (const stateLabel of ["等待第一轮结果", "待确认", "已确认", "需要重新确认"]) {
  assert.match(approvalNode, new RegExp(stateLabel), `确认节点缺少状态“${stateLabel}”`);
}
assert.match(approvalNode, /baseline-candidate/, "确认节点必须明确消费 baseline-candidate 角色");
assert.match(approvalNode, /approvedBasisRevision/, "确认必须绑定当前 basisRevision");
assert.doesNotMatch(approvalNode, /runNode\(/, "人工确认节点不得调用 Provider 运行入口");

for (const roleLabel of [
  "人物身份图", "场景参考图", "人物姿势参考图", "主穿搭图", "包袋参考图", "鞋履参考图",
  "袜子参考图",
  "帽子参考图", "戒指参考图", "耳环参考图", "手镯参考图", "服装局部结构参考图",
]) {
  assert.match(stagedNode + workflowPorts, new RegExp(roleLabel), `第一轮紧凑角色行缺少“${roleLabel}”`);
}
assert.match(stagedNode, /场景锁环境 · 姿势引导图锁动作/, "第一轮摘要必须明确场景与姿势职责分离");
assert.match(stagedNode, /已连接来源|sourceLabel|connectedSource/, "角色行必须显示已连接来源名称");
assert.match(stagedNode, /必填|可选/, "角色行必须区分必填与可选");
assert.match(stagedNode, /data-port-row=\{port\.id\}/, "分步换装输入端口必须挂载在对应角色行内");
assert.match(stagedNode, /gc-staged-role-handle/, "分步换装输入端口必须使用紧凑样式");
assert.match(stagedNode, /data-connection-state=\{connectedSource\.length \? "connected" : port\.required \? "required" : "optional"\}/, "分步换装端口必须同时呈现确认后的连接状态");
assert.doesNotMatch(stagedNode, /data-port-state=\{port\.id\}/, "角色行不得保留与连线端口分离的第二个状态圆点");
assert.doesNotMatch(stagedNode, /handles\.length \+ 1/, "分步换装输入端口不得再按节点整体高度平均排列");
assert.match(stagedNode, /data\.workflowStage !== "standard"\) return null/, "普通一键换装必须继续使用原有独立输入端口");
assert.match(stagedNode, /className=\{staged \? "gc-staged-output-handle" : undefined\}/, "紧凑输出端口只能应用于两轮分步换装节点");

for (const field of ["garmentCategory", "materialSpec", "constructionSpec", "imageSize", "modelId"]) {
  assert.match(inspector, new RegExp(field), `完整分步设置“${field}”必须位于固定右侧属性面板`);
}
assert.doesNotMatch(stagedNode, /materialEdit|constructionEdit/, "节点卡片不得继续承载完整面料与工艺编辑表单");

console.log("通过分步换装 UI 源码契约测试");
