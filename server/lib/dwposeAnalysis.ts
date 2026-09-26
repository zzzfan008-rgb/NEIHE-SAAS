import sharp from 'sharp';
import { validateImageDataUrl } from './imageValidation';
import type { DWPoseKeypointV1, DWPosePoseV1 } from '../../src/types/poseReference';

export interface DWPoseAnalysisResult {
  image: string;
  model: 'dwpose-wholebody';
  checkpoint: string;
  width: number;
  height: number;
  pose: DWPosePoseV1 | null;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 28 * 1024 * 1024;

interface DWPoseServiceV1 {
  schemaVersion: 1;
  model: 'dwpose-wholebody';
  checkpoint: string;
  width: number;
  height: number;
  imagePngBase64: string;
  people: Array<{ keypoints: Array<DWPoseKeypointV1 | null> }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readResponse(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('骨骼服务返回空结果');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error('骨骼服务结果超过大小限制');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, bytes);
}

function parsePose(value: unknown, width: number, height: number): DWPosePoseV1 {
  if (!isRecord(value) || !Array.isArray(value.people) || value.people.length < 1 || value.people.length > 8) {
    throw new Error('骨骼服务返回的人物结构无效');
  }
  const people = value.people.map((person) => {
    if (!isRecord(person) || !Array.isArray(person.keypoints) || person.keypoints.length !== 133) {
      throw new Error('骨骼服务返回的关键点数量无效');
    }
    const keypoints = person.keypoints.map((point): DWPoseKeypointV1 | null => {
      if (point === null) return null;
      if (!isRecord(point) || ![point.x, point.y, point.confidence].every((number) => typeof number === 'number' && Number.isFinite(number))) {
        throw new Error('骨骼服务返回的关键点无效');
      }
      const { x, y, confidence } = point as unknown as DWPoseKeypointV1;
      if (x < 0 || x >= 1 || y < 0 || y >= 1 || confidence <= 0 || confidence > 1) {
        throw new Error('骨骼服务返回的关键点坐标或置信度无效');
      }
      return { x, y, confidence };
    });
    return { keypoints };
  });
  return { schemaVersion: 1, canvas: { width, height }, people };
}

function parseStructuredResponse(value: unknown, model: string, checkpoint: string, width: number, height: number): {
  imagePng: Buffer;
  pose: DWPosePoseV1;
} {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('骨骼服务结构化协议版本无效');
  if (value.model !== model || value.checkpoint !== checkpoint) throw new Error('骨骼服务返回的模型标识无效');
  if (value.width !== width || value.height !== height) throw new Error('骨骼服务返回的图像尺寸与参考图不一致');
  if (typeof value.imagePngBase64 !== 'string' || value.imagePngBase64.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.imagePngBase64)) {
    throw new Error('骨骼服务返回的 PNG 数据无效');
  }
  const imagePng = Buffer.from(value.imagePngBase64, 'base64');
  if (!imagePng.length || imagePng.length > MAX_IMAGE_BYTES || imagePng.toString('base64') !== value.imagePngBase64) {
    throw new Error('骨骼服务返回的 PNG 数据无效');
  }
  return { imagePng, pose: parsePose(value, width, height) };
}

async function verifyOutput(output: Buffer, width: number, height: number): Promise<Buffer> {
  const metadata = await sharp(output, { limitInputPixels: 40_000_000 }).metadata();
  if (metadata.format !== 'png' || metadata.width !== width || metadata.height !== height) {
    throw new Error('骨骼服务返回的图像尺寸与参考图不一致');
  }
  return sharp(output).png().toBuffer();
}

async function callPoseService(base: URL, token: string, path: '/pose/v1' | '/pose', body: string): Promise<Response> {
  const url = new URL(base);
  url.pathname = path;
  try {
    return await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body,
    });
  } catch {
    throw new Error('骨骼服务连接失败或超时，请检查本地服务后重试');
  }
}

function validateIdentity(response: Response): string {
  const checkpoint = response.headers.get('x-pose-checkpoint') ?? '';
  if (response.headers.get('x-pose-model') !== 'dwpose-wholebody' || !/^[a-f0-9]{64}$/.test(checkpoint)) {
    throw new Error('骨骼服务返回的模型标识无效');
  }
  return checkpoint;
}


/** Server-only adapter. No provider fallback, automatic retry, or user-supplied URL. */
export async function analyzeDWPoseReference(image: string): Promise<DWPoseAnalysisResult> {
  const { buffer } = validateImageDataUrl(image);
  const normalized = await sharp(buffer, { limitInputPixels: 40_000_000 })
    .rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .png().toBuffer({ resolveWithObject: true });
  const token = process.env.POSE_SERVICE_TOKEN?.trim();
  const base = process.env.POSE_SERVICE_URL?.trim();
  if (!base || !token || token.length < 32) throw new Error('骨骼服务尚未配置');
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('骨骼服务地址配置无效');
  }
  // Non-loopback hosts require encrypted transport; Mac services can use an SSH tunnel.
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('远程骨骼服务必须配置 HTTPS 或本机隧道');
  }
  const body = JSON.stringify({ image: `data:image/png;base64,${normalized.data.toString('base64')}` });
  let response = await callPoseService(url, token, '/pose/v1', body);
  let legacy = false;
  if (response.status === 404) {
    legacy = true;
    await response.body?.cancel().catch(() => undefined);
    response = await callPoseService(url, token, '/pose', body);
  }
  if (!response.ok) throw new Error(`骨骼服务暂不可用（HTTP ${response.status}）`);
  const checkpoint = validateIdentity(response);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  let output: Buffer;
  let pose: DWPosePoseV1 | null;
  if (legacy) {
    if (contentType !== 'image/png') throw new Error('骨骼服务返回的图像格式无效');
    output = await readResponse(response, MAX_IMAGE_BYTES);
    pose = null;
  } else {
    if (contentType !== 'application/json') throw new Error('骨骼服务返回的结构化格式无效');
    const responseBytes = await readResponse(response, MAX_RESPONSE_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(responseBytes.toString('utf8'));
    } catch {
      throw new Error('骨骼服务结构化结果无效');
    }
    const parsed = parseStructuredResponse(value, 'dwpose-wholebody', checkpoint, normalized.info.width, normalized.info.height);
    output = parsed.imagePng;
    pose = parsed.pose;
  }
  const verified = await verifyOutput(output, normalized.info.width, normalized.info.height);
  return {
    image: `data:image/png;base64,${verified.toString('base64')}`,
    model: 'dwpose-wholebody', checkpoint,
    width: normalized.info.width, height: normalized.info.height, pose,
  };
}
