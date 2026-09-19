import sharp from 'sharp';
import { validateImageDataUrl } from './imageValidation';

export interface DepthAnalysisResult {
  image: string;
  model: 'depth-anything-v2-vitl';
  checkpoint: string;
  convention: 'near-white';
  inputSize: number;
  width: number;
  height: number;
}

/** Server-only adapter. No provider fallback, automatic retry, or user-supplied URL. */
export async function analyzeDepthReference(image: string): Promise<DepthAnalysisResult> {
  const { buffer } = validateImageDataUrl(image);
  const normalized = await sharp(buffer, { limitInputPixels: 40_000_000 })
    .rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .png().toBuffer({ resolveWithObject: true });
  const token = process.env.DEPTH_SERVICE_TOKEN?.trim();
  const base = process.env.DEPTH_SERVICE_URL?.trim();
  if (!base || !token || token.length < 32) throw new Error('深度服务尚未配置');
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('深度服务地址配置无效');
  }
  // Non-loopback hosts require encrypted transport; Mac services can use an SSH tunnel.
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('远程深度服务必须配置 HTTPS 或本机隧道');
  }
  const inputSize = Number(process.env.DEPTH_INPUT_SIZE || 518);
  if (!Number.isInteger(inputSize) || inputSize < 518 || inputSize > 1036) throw new Error('深度分辨率配置无效');
  url.pathname = '/depth';
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ image: `data:image/png;base64,${normalized.data.toString('base64')}`, inputSize }),
    });
  } catch {
    throw new Error('深度服务连接失败或超时，请检查本地服务后重试');
  }
  if (!response.ok) throw new Error(`深度服务暂不可用（HTTP ${response.status}）`);
  const checkpoint = response.headers.get('x-depth-checkpoint') ?? '';
  if (response.headers.get('x-depth-model') !== 'depth-anything-v2-vitl' || !/^[a-f0-9]{64}$/.test(checkpoint)) {
    throw new Error('深度服务返回的模型标识无效');
  }
  if (response.headers.get('content-type') !== 'image/png') throw new Error('深度服务返回的图像格式无效');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('深度服务返回空结果');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 20 * 1024 * 1024) {
      await reader.cancel();
      throw new Error('深度服务结果超过大小限制');
    }
    chunks.push(value);
  }
  const output = Buffer.concat(chunks);
  const metadata = await sharp(output, { limitInputPixels: 40_000_000 }).metadata();
  if (metadata.format !== 'png' || metadata.width !== normalized.info.width || metadata.height !== normalized.info.height) {
    throw new Error('深度服务结果尺寸与参考图不一致');
  }
  // Decode completely rather than trusting only a PNG header.
  const verified = await sharp(output).png().toBuffer();
  return {
    image: `data:image/png;base64,${verified.toString('base64')}`,
    model: 'depth-anything-v2-vitl', checkpoint, convention: 'near-white', inputSize,
    width: metadata.width!, height: metadata.height!,
  };
}
