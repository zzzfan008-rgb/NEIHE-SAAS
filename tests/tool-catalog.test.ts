import assert from "node:assert/strict";
import { TOOL_GROUPS } from "../src/lib/toolCatalog";

console.log("五组工具目录契约测试");

assert.deepEqual(
  TOOL_GROUPS.map(({ id, label }) => ({ id, label })),
  [
    { id: "add", label: "添加节点" },
    { id: "apparel", label: "服装设计" },
    { id: "try-on", label: "模特换装" },
    { id: "video", label: "视频制作" },
    { id: "create", label: "创作工具" },
  ],
  "一级入口必须恰好是确认过的五组且顺序稳定",
);

assert.deepEqual(
  TOOL_GROUPS.map((group) => group.items.map((item) => item.name)),
  [
    ["文本节点", "本地上传图片", "本地上传视频", "从资产库中选择"],
    ["草图到效果图", "AI 改款", "面料替换", "配色替换", "印花提取", "印花裂变"],
    ["白底图制作", "一键换装", "风格迁移"],
    ["文生视频", "首尾帧生视频", "多图参考生视频", "视频生视频"],
    ["绘画工具", "色彩工具"],
  ],
);
assert.equal(TOOL_GROUPS.flatMap((group) => group.items).length, 19);

const ids = TOOL_GROUPS.flatMap((group) => group.items.map((item) => item.id));
assert.equal(new Set(ids).size, ids.length, "工具项目 id 必须全局稳定且唯一");

for (const group of TOOL_GROUPS) {
  assert.ok(group.icon, `${group.label} 缺少图标`);
  for (const item of group.items) {
    assert.ok(item.description.trim(), `${item.name} 缺少用途说明`);
    if (item.availability === "available") {
      assert.ok(item.creationIntent, `${item.name} 可用但没有创建意图`);
      assert.equal(item.disabledReason, undefined, `${item.name} 可用时不得显示禁用原因`);
    } else {
      assert.ok(item.disabledReason?.trim(), `${item.name} 不可用时必须给出原因`);
      assert.equal(item.creationIntent, undefined, `${item.name} 不可用时不得携带创建意图`);
    }
  }
}

const item = (name: string) => TOOL_GROUPS.flatMap((group) => group.items).find((candidate) => candidate.name === name);
for (const name of ["草图到效果图", "AI 改款", "面料替换", "配色替换", "印花提取", "印花裂变", "白底图制作", "一键换装", "风格迁移"]) {
  assert.equal(item(name)?.creationIntent?.type, "workflow-template", `${name} 必须创建已连线工作流`);
}
assert.equal(item("本地上传视频")?.availability, "available");
for (const name of ["文生视频", "首尾帧生视频", "多图参考生视频", "视频生视频"]) {
  assert.equal(item(name)?.availability, "available");
  assert.equal(item(name)?.creationIntent?.type, "workflow-template");
}

console.log("通过 1 项工具目录测试（5 组、19 项）");
