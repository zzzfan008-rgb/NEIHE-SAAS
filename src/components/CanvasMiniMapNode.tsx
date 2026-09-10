import type { MiniMapNodeProps } from "@xyflow/react";
import { selectActiveNodes, useFlowStore } from "@/store/flowStore";
import type { WorkflowNodeData } from "@/types/workflow";

const VIDEO_REFERENCE = /(?:data:video\/|\.(?:mp4|webm|mov)(?:[?#]|$))/i;

function firstRenderableImage(
      references: readonly string[] | undefined,
): string | undefined {
      return references?.find(
            (reference) =>
                  typeof reference === "string" &&
                  reference.length > 0 &&
                  !reference.startsWith("asset://") &&
                  !VIDEO_REFERENCE.test(reference),
      );
}

export function minimapNodeThumbnail(
      data: WorkflowNodeData,
): string | undefined {
      if (data.kind === "image-input")
            return firstRenderableImage(
                  data.imageUrl ? [data.imageUrl] : undefined,
            );
      if (data.kind === "drawing-board")
            return firstRenderableImage(
                  data.previewImageRef ? [data.previewImageRef] : undefined,
            );
      if (data.kind === "result") return firstRenderableImage(data.images);
      if ("outputImages" in data && Array.isArray(data.outputImages))
            return firstRenderableImage(data.outputImages);
      return undefined;
}

export function minimapNodeColor(data: WorkflowNodeData): string {
      if (
            data.kind === "image-input" ||
            data.kind === "video-input" ||
            data.kind === "audio-input"
      )
            return "#718399";
      if (data.kind === "drawing-board") return "#b27c45";
      if (data.kind === "color-palette") return "#a26479";
      if (data.kind === "result" || "outputImages" in data) return "#5f8575";
      return "#8a8a8a";
}

export function CanvasMiniMapNode({
      id,
      x,
      y,
      width,
      height,
      borderRadius,
      className,
      color,
      shapeRendering,
      strokeColor,
      strokeWidth,
      style,
      selected,
      onClick,
}: MiniMapNodeProps) {
      const thumbnail = useFlowStore((state) => {
            const node = selectActiveNodes(state).find(
                  (candidate) => candidate.id === id,
            );
            return node ? minimapNodeThumbnail(node.data) : undefined;
      });
      const clipId = `gc-minimap-node-${id}`;
      const radius = Math.min(borderRadius, width / 2, height / 2);

      return (
            <g
                  className={className}
                  onClick={onClick ? (event) => onClick(event, id) : undefined}
                  role={onClick ? "button" : undefined}
                  aria-label={onClick ? `定位节点 ${id}` : undefined}
            >
                  <rect
                        x={x}
                        y={y}
                        width={width}
                        height={height}
                        rx={radius}
                        ry={radius}
                        fill={color ?? "#8a8a8a"}
                        shapeRendering={shapeRendering}
                        style={style}
                  />
                  {thumbnail && (
                        <>
                              <defs>
                                    <clipPath id={clipId}>
                                          <rect
                                                x={x}
                                                y={y}
                                                width={width}
                                                height={height}
                                                rx={radius}
                                                ry={radius}
                                          />
                                    </clipPath>
                              </defs>
                              <image
                                    className="gc-minimap-node-thumbnail"
                                    href={thumbnail}
                                    x={x}
                                    y={y}
                                    width={width}
                                    height={height}
                                    preserveAspectRatio="xMidYMid slice"
                                    clipPath={`url(#${clipId})`}
                              />
                        </>
                  )}
                  <rect
                        x={x}
                        y={y}
                        width={width}
                        height={height}
                        rx={radius}
                        ry={radius}
                        fill="none"
                        stroke={
                              selected ? "var(--gc-edge-selected)" : strokeColor
                        }
                        strokeWidth={
                              selected
                                    ? Math.max(2, strokeWidth ?? 0)
                                    : strokeWidth
                        }
                        vectorEffect="non-scaling-stroke"
                        pointerEvents="none"
                  />
            </g>
      );
}
