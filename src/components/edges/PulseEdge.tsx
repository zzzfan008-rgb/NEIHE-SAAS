import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { selectActiveNodes, useFlowStore } from "@/store/flowStore";
import { isNodeRunActive } from "@/types/workflow";

/**
 * 脉冲光点连线：金色光珠沿贝塞尔路径奔跑，指示数据流向。
 * 源头节点运行中 → 光珠更亮更快；常态 → 低调慢速。
 */
export function PulseEdge({
  id,
  source,
  data,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
}: EdgeProps) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const running = useFlowStore(
    (state) => {
      const status = selectActiveNodes(state).find((node) => node.id === source)?.data.status;
      return status ? isNodeRunActive(status) : false;
    },
  );

  const pathEmphasis = (data as {
    pathEmphasis?: "quiet" | "upstream" | "downstream" | "unrelated";
  } | undefined)?.pathEmphasis ?? "quiet";
  const emphasized = pathEmphasis === "upstream" || pathEmphasis === "downstream";
  const baseStroke = selected
    ? "var(--gc-edge-selected)"
    : running
      ? "var(--gc-edge-active)"
      : emphasized
        ? "var(--gc-edge-emphasis)"
        : "var(--gc-edge-muted)";
  const dur = running ? "1.2s" : "2.8s";
  const opacity = pathEmphasis === "unrelated" ? 0.22 : pathEmphasis === "quiet" ? 0.62 : 1;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={20}
        className={`gc-workflow-edge gc-workflow-edge--${pathEmphasis}`}
        style={{ stroke: baseStroke, strokeWidth: selected || emphasized ? 2.2 : 1.6, opacity }}
      />
      {running && (
        <g className="gc-edge-flow-dots" aria-hidden="true">
          <circle r={4} fill="var(--gc-edge-active)" className="gc-edge-flow-dot">
            <animateMotion dur={dur} repeatCount="indefinite" path={path} />
          </circle>
          <circle r={3} fill="var(--gc-edge-active)" opacity={0.7} className="gc-edge-flow-dot">
            <animateMotion dur={dur} begin="0.4s" repeatCount="indefinite" path={path} />
          </circle>
        </g>
      )}
    </>
  );
}
