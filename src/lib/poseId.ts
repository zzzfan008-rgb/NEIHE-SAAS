/** Secure UUID v4 for pose people and editor sessions, including LAN HTTP. */
export function createPoseId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  // Unlike randomUUID, getRandomValues is available in non-secure contexts.
  if (typeof crypto?.getRandomValues !== 'function') {
    throw new Error('当前环境无法生成姿势人物标识');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
