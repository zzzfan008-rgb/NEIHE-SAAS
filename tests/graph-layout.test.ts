import assert from "node:assert/strict";
import {
  connectedComponentNodeIds,
  directedPathNodeIds,
  layoutConnectedComponent,
} from "../src/lib/graphLayout";

type FixtureNode = {
  id: string;
  position: { x: number; y: number };
  measured?: { width: number; height: number };
};

const nodes: FixtureNode[] = [
  { id: "a", position: { x: 20, y: 40 }, measured: { width: 160, height: 100 } },
  { id: "b", position: { x: 40, y: 50 }, measured: { width: 180, height: 120 } },
  { id: "c", position: { x: 60, y: 60 }, measured: { width: 140, height: 90 } },
  { id: "other", position: { x: 900, y: 700 }, measured: { width: 200, height: 110 } },
];

const edges = [
  { id: "ab", source: "a", target: "b" },
  { id: "bc", source: "b", target: "c" },
];

function bounds(input: FixtureNode[]) {
  return input.reduce(
    (box, node) => ({
      left: Math.min(box.left, node.position.x),
      top: Math.min(box.top, node.position.y),
      right: Math.max(box.right, node.position.x + (node.measured?.width ?? 0)),
      bottom: Math.max(box.bottom, node.position.y + (node.measured?.height ?? 0)),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );
}

console.log("画布局部自动整理契约测试");

assert.deepEqual([...connectedComponentNodeIds("b", nodes, edges)].sort(), ["a", "b", "c"]);
assert.deepEqual([...connectedComponentNodeIds("other", nodes, edges)], ["other"]);
console.log("  ✓ 只识别主选节点所在的无向连通分量");

const paths = directedPathNodeIds("b", nodes, edges);
assert.deepEqual([...paths.upstream].sort(), ["a", "b"]);
assert.deepEqual([...paths.downstream].sort(), ["b", "c"]);
console.log("  ✓ 上游与下游路径集合以主选节点为边界");

const first = layoutConnectedComponent("b", nodes, edges);
const second = layoutConnectedComponent("b", nodes, edges);
assert.deepEqual(first, second, "相同输入必须得到完全一致的排序和坐标");
assert.deepEqual(first.find((node) => node.id === "other")?.position, { x: 900, y: 700 });

const laidOut = first.filter((node) => node.id !== "other") as FixtureNode[];
assert.ok(
  (laidOut.find((node) => node.id === "a")?.position.x ?? 0)
    < (laidOut.find((node) => node.id === "b")?.position.x ?? 0),
);
assert.ok(
  (laidOut.find((node) => node.id === "b")?.position.x ?? 0)
    < (laidOut.find((node) => node.id === "c")?.position.x ?? 0),
);

for (let i = 0; i < laidOut.length; i += 1) {
  for (let j = i + 1; j < laidOut.length; j += 1) {
    const a = laidOut[i];
    const b = laidOut[j];
    const separated =
      a.position.x + (a.measured?.width ?? 0) <= b.position.x
      || b.position.x + (b.measured?.width ?? 0) <= a.position.x
      || a.position.y + (a.measured?.height ?? 0) <= b.position.y
      || b.position.y + (b.measured?.height ?? 0) <= a.position.y;
    assert.equal(separated, true, `${a.id} 与 ${b.id} 不得重叠`);
  }
}

const before = bounds(nodes.filter((node) => node.id !== "other"));
const after = bounds(laidOut);
assert.equal((before.left + before.right) / 2, (after.left + after.right) / 2);
assert.equal((before.top + before.bottom) / 2, (after.top + after.bottom) / 2);
console.log("  ✓ 按有向层级确定性排列、不重叠、保持分量中心且不移动其他分量");

assert.throws(
  () => layoutConnectedComponent("a", nodes, [...edges, { id: "ca", source: "c", target: "a" }]),
  /循环/,
);
assert.throws(
  () => layoutConnectedComponent("a", nodes.map((node) => node.id === "b" ? { ...node, measured: undefined } : node), edges),
  /尺寸/,
);
console.log("  ✓ 存在循环或节点尚未测量时整次拒绝，不做部分移动");
