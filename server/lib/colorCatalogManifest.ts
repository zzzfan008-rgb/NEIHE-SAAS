import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { CatalogSourceInput } from "./colorCatalog";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("主库清单对象无效");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("主库清单包含未知字段");
}
function boundedFile(file: string, maxBytes: number): Buffer {
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("主库输入必须是限制大小内的普通文件");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) throw new Error("主库文件在读取时发生变化");
    return bytes.subarray(0, length);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Operator-only manifest; never accepts paths from an HTTP request. No extraction or writes. */
export function readColorCatalogManifest(
  manifestPath: string,
): CatalogSourceInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        boundedFile(manifestPath, 1024 * 1024),
      ),
    );
  } catch {
    throw new Error("无法读取主库清单，或其 UTF-8 / JSON 格式无效");
  }
  const manifest = record(parsed);
  keys(manifest, ["version", "usageRightsConfirmed", "sources"]);
  if (manifest.version !== 1 || manifest.usageRightsConfirmed !== true)
    throw new Error("主库清单版本必须为 1，并由操作员确认数据使用权");
  if (
    !Array.isArray(manifest.sources) ||
    manifest.sources.length < 1 ||
    manifest.sources.length > 64
  )
    throw new Error("主库清单需要 1–64 个来源");
  const root = fs.realpathSync(path.dirname(path.resolve(manifestPath)));
  const seen = new Set<string>();
  let total = 0;
  return manifest.sources.map((input) => {
    const source = record(input);
    keys(source, ["path", "libraryKey", "version", "sha256", "labWhitePoint"]);
    if (
      typeof source.path !== "string" ||
      source.path.length > 256 ||
      !/\.(acb|ase)$/i.test(source.path) ||
      /[\\:\0]/.test(source.path) ||
      source.path.split("/").some((part) => ["", ".", ".."].includes(part))
    )
      throw new Error("主库来源必须是清单目录内的相对 ACB/ASE 路径");
    if (
      typeof source.libraryKey !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source.libraryKey)
    )
      throw new Error("主库 libraryKey 无效");
    if (
      typeof source.version !== "string" ||
      !source.version.trim() ||
      source.version.length > 128
    )
      throw new Error("主库来源版本无效");
    if (
      typeof source.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(source.sha256)
    )
      throw new Error("主库 SHA-256 无效");
    if (source.labWhitePoint !== undefined && source.labWhitePoint !== "D50")
      throw new Error("不支持此 Lab 白点声明");
    if (seen.has(source.path)) throw new Error("主库清单来源路径重复");
    seen.add(source.path);
    let file = root;
    for (const part of source.path.split("/")) {
      file = path.join(file, part);
      if (fs.lstatSync(file).isSymbolicLink())
        throw new Error("主库来源不允许符号链接");
    }
    const bytes = boundedFile(file, 16 * 1024 * 1024);
    total += bytes.length;
    if (total > 64 * 1024 * 1024) throw new Error("主库来源合计超过 64 MiB");
    if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
      throw new Error("主库来源 SHA-256 不匹配");
    return {
      libraryKey: source.libraryKey,
      fileName: source.path,
      version: source.version,
      bytes,
      ...(source.labWhitePoint === "D50"
        ? { labWhitePoint: "D50" as const }
        : {}),
    };
  });
}
