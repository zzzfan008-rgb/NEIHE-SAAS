import type { ToolItem } from "@/types/workbench";

export type VideoCapabilityId =
  | "text-to-video"
  | "keyframes-to-video"
  | "multi-image-video"
  | "video-to-video";

export interface VideoCapabilityDescriptor {
  id: VideoCapabilityId;
  name: string;
  icon: string;
  description: string;
  disabledReason: string;
}

export interface VideoCapabilityApproval {
  independentSpecId: string;
  generationContractId: string;
  acceptanceRecordId: string;
  approvedAt: string;
}

export type ResolvedVideoCapability<TIntent> = Omit<VideoCapabilityDescriptor, "disabledReason"> & ({
  availability: "unavailable";
  approvalState: "blocked";
  disabledReason: string;
  creationIntent?: never;
} | {
  availability: "available";
  approvalState: "approved";
  disabledReason?: never;
  creationIntent: TIntent;
});

export const VIDEO_CAPABILITIES: readonly VideoCapabilityDescriptor[] = [
  {
    id: "text-to-video",
    name: "文生视频",
    icon: "message-square-video",
    description: "根据文字描述生成视频。",
    disabledReason: "文生视频的独立规格、模型计费与输出验收尚未全部批准",
  },
  {
    id: "keyframes-to-video",
    name: "首尾帧生视频",
    icon: "between-horizontal-start",
    description: "根据首帧和尾帧生成过渡视频。",
    disabledReason: "首尾帧角色、插帧时长与生成验收尚未全部批准",
  },
  {
    id: "multi-image-video",
    name: "多图参考生视频",
    icon: "images",
    description: "综合多张参考图生成视频。",
    disabledReason: "多图角色、顺序上限与生成验收尚未全部批准",
  },
  {
    id: "video-to-video",
    name: "视频生视频",
    icon: "refresh-ccw",
    description: "基于现有视频完成风格或内容变换。",
    disabledReason: "视频上传、变换计费、播放导出与上线验收尚未全部批准",
  },
] as const;

/**
 * The user explicitly approved the real APIYI video entry points on
 * 2026-09-03. Keep the approval record next to the fail-closed resolver so a
 * future removal or contract change cannot silently bypass the gate.
 */
export const VIDEO_CAPABILITY_APPROVAL: VideoCapabilityApproval = {
  independentSpecId: "spec-001-canvas-workbench-redesign",
  generationContractId: "apiyi-veo-3.1-v1",
  acceptanceRecordId: "chat-confirmation-2026-09-03-video-entry-activation",
  approvedAt: "2026-09-03T18:00:00+08:00",
};

const VIDEO_TEMPLATE_IDS: Record<VideoCapabilityId, string> = {
  "text-to-video": "builtin-tool-text-to-video",
  "keyframes-to-video": "builtin-tool-keyframes-to-video",
  "multi-image-video": "builtin-tool-multi-image-video",
  "video-to-video": "builtin-tool-video-to-video",
};

function validApproval(approval: VideoCapabilityApproval | undefined): boolean {
  if (!approval) return false;
  return [
    approval.independentSpecId,
    approval.generationContractId,
    approval.acceptanceRecordId,
    approval.approvedAt,
  ].every((value) => typeof value === "string" && value.trim().length > 0);
}

/**
 * Fail-closed future enablement seam. A capability needs all three approval
 * artifacts plus an explicitly registered implementation intent. This module
 * deliberately defines no video node kind or implementation today.
 */
export function resolveVideoCapability<TIntent>(
  descriptor: VideoCapabilityDescriptor,
  approval?: VideoCapabilityApproval,
  implementation?: TIntent,
): ResolvedVideoCapability<TIntent> {
  const { disabledReason, ...base } = descriptor;
  if (!validApproval(approval) || implementation === undefined) {
    return { ...base, disabledReason, availability: "unavailable", approvalState: "blocked" };
  }
  return { ...base, availability: "available", approvalState: "approved", creationIntent: implementation };
}

export function videoCapabilityToolItems(): ToolItem[] {
  return VIDEO_CAPABILITIES.map((descriptor) => {
    const implementation = {
      type: "workflow-template",
      templateId: VIDEO_TEMPLATE_IDS[descriptor.id],
    } as const;
    const resolved = resolveVideoCapability(descriptor, VIDEO_CAPABILITY_APPROVAL, implementation);
    if (resolved.availability !== "available") {
      throw new Error(`Video capability ${descriptor.id} is missing its approval or implementation`);
    }
    return {
      id: resolved.id,
      name: resolved.name,
      icon: resolved.icon,
      description: resolved.description,
      availability: resolved.availability,
      creationIntent: resolved.creationIntent,
      capabilityGate: {
        domain: "video",
        capabilityId: resolved.id,
        approvalState: resolved.approvalState,
      },
    };
  });
}
