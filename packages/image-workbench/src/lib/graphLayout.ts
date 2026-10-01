export interface GraphLayoutNode {
  id: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
  width?: number | null;
  height?: number | null;
}
export interface GraphLayoutEdge {
  source: string;
  target: string;
}

export interface DirectedPathNodeIds {
  upstream: Set<string>;
  downstream: Set<string>;
}

function walk(
  seed: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const visited = new Set<string>();
  const queue = [seed];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return visited;
}

function adjacencyFor(
  nodes: readonly GraphLayoutNode[],
  edges: readonly GraphLayoutEdge[],
  direction: "undirected" | "incoming" | "outgoing",
): Map<string, string[]> {
  const known = new Set(nodes.map((node) => node.id));
  const adjacency = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    if (direction !== "incoming") adjacency.get(edge.source)!.push(edge.target);
    if (direction !== "outgoing") adjacency.get(edge.target)!.push(edge.source);
  }
  for (const neighbors of adjacency.values()) neighbors.sort();
  return adjacency;
}

export function connectedComponentNodeIds(
  selectedNodeId: string,
  nodes: readonly GraphLayoutNode[],
  edges: readonly GraphLayoutEdge[],
): Set<string> {
  if (!nodes.some((node) => node.id === selectedNodeId)) return new Set();
  return walk(selectedNodeId, adjacencyFor(nodes, edges, "undirected"));
}

export function directedPathNodeIds(
  selectedNodeId: string,
  nodes: readonly GraphLayoutNode[],
  edges: readonly GraphLayoutEdge[],
): DirectedPathNodeIds {
  if (!nodes.some((node) => node.id === selectedNodeId)) {
    return { upstream: new Set(), downstream: new Set() };
  }
  return {
    upstream: walk(selectedNodeId, adjacencyFor(nodes, edges, "incoming")),
    downstream: walk(selectedNodeId, adjacencyFor(nodes, edges, "outgoing")),
  };
}

function dimensions(node: GraphLayoutNode): { width: number; height: number } {
  const width = node.measured?.width ?? node.width;
  const height = node.measured?.height ?? node.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || Number(width) <= 0 || Number(height) <= 0) {
    throw new Error(`节点 ${node.id} 的尺寸尚未完成测量`);
  }
  return { width: Number(width), height: Number(height) };
}

function centerOf(nodes: readonly GraphLayoutNode[]): { x: number; y: number } {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const node of nodes) {
    const size = dimensions(node);
    left = Math.min(left, node.position.x);
    top = Math.min(top, node.position.y);
    right = Math.max(right, node.position.x + size.width);
    bottom = Math.max(bottom, node.position.y + size.height);
  }
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

export function layoutConnectedComponent<T extends GraphLayoutNode>(
  selectedNodeId: string,
  nodes: readonly T[],
  edges: readonly GraphLayoutEdge[],
  options: { rankGap?: number; rowGap?: number } = {},
): T[] {
  const componentIds = connectedComponentNodeIds(selectedNodeId, nodes, edges);
  if (componentIds.size === 0) throw new Error("请先选择需要整理的工作流节点");
  const component = nodes.filter((node) => componentIds.has(node.id));
  component.forEach(dimensions);

  const componentEdges = edges.filter(
    (edge) => componentIds.has(edge.source) && componentIds.has(edge.target),
  );
  const incomingCount = new Map(component.map((node) => [node.id, 0]));
  const outgoing = new Map(component.map((node) => [node.id, [] as string[]]));
  for (const edge of componentEdges) {
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  for (const targets of outgoing.values()) targets.sort();

  const queue = component
    .filter((node) => incomingCount.get(node.id) === 0)
    .map((node) => node.id)
    .sort();
  const rank = new Map<string, number>(component.map((node) => [node.id, 0]));
  const ordered: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    ordered.push(current);
    for (const target of outgoing.get(current) ?? []) {
      rank.set(target, Math.max(rank.get(target) ?? 0, (rank.get(current) ?? 0) + 1));
      const remaining = (incomingCount.get(target) ?? 0) - 1;
      incomingCount.set(target, remaining);
      if (remaining === 0) {
        queue.push(target);
        queue.sort();
      }
    }
  }
  if (ordered.length !== component.length) {
    throw new Error("所选工作流包含循环连接，无法自动整理");
  }

  const byId = new Map(component.map((node) => [node.id, node]));
  const byRank = new Map<number, string[]>();
  for (const id of ordered) {
    const level = rank.get(id) ?? 0;
    const ids = byRank.get(level) ?? [];
    ids.push(id);
    ids.sort();
    byRank.set(level, ids);
  }

  const rankGap = options.rankGap ?? 120;
  const rowGap = options.rowGap ?? 48;
  const levels = [...byRank.keys()].sort((a, b) => a - b);
  const rankWidths = new Map(levels.map((level) => [
    level,
    Math.max(...byRank.get(level)!.map((id) => dimensions(byId.get(id)!).width)),
  ]));
  const rankHeights = new Map(levels.map((level) => [
    level,
    byRank.get(level)!.reduce(
      (total, id, index) => total + dimensions(byId.get(id)!).height + (index === 0 ? 0 : rowGap),
      0,
    ),
  ]));
  const maxRankHeight = Math.max(...rankHeights.values());

  const provisional = new Map<string, { x: number; y: number }>();
  let x = 0;
  for (const level of levels) {
    const ids = byRank.get(level)!;
    let y = (maxRankHeight - (rankHeights.get(level) ?? 0)) / 2;
    for (const id of ids) {
      provisional.set(id, { x, y });
      y += dimensions(byId.get(id)!).height + rowGap;
    }
    x += (rankWidths.get(level) ?? 0) + rankGap;
  }

  const provisionalNodes = component.map((node) => ({
    ...node,
    position: provisional.get(node.id)!,
  }));
  const beforeCenter = centerOf(component);
  const afterCenter = centerOf(provisionalNodes);
  const offset = { x: beforeCenter.x - afterCenter.x, y: beforeCenter.y - afterCenter.y };

  return nodes.map((node) => {
    const position = provisional.get(node.id);
    if (!position) return node;
    return {
      ...node,
      position: { x: position.x + offset.x, y: position.y + offset.y },
    };
  });
}
