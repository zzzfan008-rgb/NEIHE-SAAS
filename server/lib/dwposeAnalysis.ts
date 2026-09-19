import sharp from 'sharp';
import { validateImageDataUrl } from './imageValidation';

export interface DWPoseAnalysisResult {
  image: string;
  model: 'dwpose-wholebody';
  checkpoint: string;
  width: number;
  height: number;
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
  url.pathname = '/pose';
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ image: `data:image/png;base64,${normalized.data.toString('base64')}` }),
    });
  } catch {
    throw new Error('骨骼服务连接失败或超时，请检查本地服务后重试');
  }
  if (!response.ok) throw new Error(`骨骼服务暂不可用（HTTP ${response.status}）`);
  const checkpoint = response.headers.get('x-pose-checkpoint') ?? '';
  if (response.headers.get('x-pose-model') !== 'dwpose-wholebody' || !/^[a-f0-9]{64}$/.test(checkpoint)) {
    throw new Error('骨骼服务返回的模型标识无效');
  }
  if (response.headers.get('content-type') !== 'image/png') throw new Error('骨骼服务返回的图像格式无效');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('骨骼服务返回空结果');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 20 * 1024 * 1024) {
      await reader.cancel();
      throw new Error('骨骼服务结果超过大小限制');
    }
    chunks.push(value);
  }
  const output = Buffer.concat(chunks);
  const metadata = await sharp(output, { limitInputPixels: 40_000_000 }).metadata();
  if (metadata.format !== 'png' || metadata.width !== normalized.info.width || metadata.height !== normalized.info.height) {
    throw new Error('骨骼服务结果尺寸与参考图不一致');
  }
  // Decode completely rather than trusting only a PNG header.
  const verified = await sharp(output).png().toBuffer();
  return {
    image: `data:image/png;base64,${verified.toString('base64')}`,
    model: 'dwpose-wholebody', checkpoint,
    width: metadata.width!, height: metadata.height!,
  };
}
