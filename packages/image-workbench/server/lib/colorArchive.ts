import { crc32 } from "node:zlib";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { SaxesParser } from "saxes";

interface WorkbookXmlTag {
  name: string;
  uri: string;
  attributes: Record<string, string>;
}

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** No filesystem extraction. Entry sizes are checked both before and during decompression. */
export async function readColorWorkbookArchive(
  bytes: Buffer,
): Promise<Map<string, string>> {
  if (bytes.length > MAX_ARCHIVE_BYTES)
    throw new Error("Excel 文件不能超过 10 MiB");
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, file) => {
        if (error || !file) reject(new Error("Excel ZIP 文件无效"));
        else resolve(file);
      },
    );
  });
  const files = new Map<string, string>();
  const names = new Set<string>();
  let total = 0;
  return new Promise((resolve, reject) => {
    let failed = false;
    const fail = (error: unknown) => {
      failed = true;
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (!failed) resolve(files);
    });
    zip.on("entry", (entry: Entry) => {
      void (async () => {
        const name = entry.fileName;
        if (
          names.size >= 200 ||
          names.has(name) ||
          name.length > 256 ||
          name.split("/").includes("..") ||
          name.startsWith("/") ||
          name.includes("\\")
        )
          throw new Error("Excel ZIP 条目数量、名称或重复路径无效");
        names.add(name);
        if (
          entry.isEncrypted() ||
          entry.uncompressedSize > MAX_ENTRY_BYTES ||
          total + entry.uncompressedSize > MAX_TOTAL_BYTES
        )
          throw new Error("Excel ZIP 加密或解压体积超出限制");
        if (/vbaProject|externalLinks/i.test(name))
          throw new Error("不支持含宏或外部引用的 Excel");
        const stream = await new Promise<NodeJS.ReadableStream>(
          (resolveStream, rejectStream) =>
            zip.openReadStream(entry, (error, input) => {
              if (error || !input)
                rejectStream(new Error("Excel ZIP 条目损坏"));
              else resolveStream(input);
            }),
        );
        let size = 0;
        let checksum = 0;
        const chunks: Buffer[] = [];
        // yauzl returns a Node Readable; async iteration also destroys it on early failure.
        for await (const raw of stream as import("node:stream").Readable) {
          const chunk = raw as Buffer;
          size += chunk.length;
          total += chunk.length;
          if (size > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES)
            throw new Error("Excel 解压体积超出限制");
          checksum = crc32(chunk, checksum);
          if (/\.(xml|rels)$/.test(name)) chunks.push(chunk);
        }
        if (size !== entry.uncompressedSize || checksum !== entry.crc32)
          throw new Error("Excel ZIP 校验失败");
        if (/\.(xml|rels)$/.test(name)) {
          const xml = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          );
          // Validate every XML part, not just the selected worksheet.
          walkWorkbookXml(xml, {
            open: (tag) => {
              if (
                tag.name.split(":").pop() === "Relationship" &&
                String(tag.attributes.TargetMode).toLowerCase() === "external"
              )
                throw new Error("不支持 Excel 外部引用");
            },
          });
          files.set(name, xml);
        }
        if (!failed) zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

export function walkWorkbookXml(
  xml: string,
  handlers: {
    open?: (tag: WorkbookXmlTag, path: string[]) => void;
    text?: (text: string, path: string[]) => void;
    close?: (name: string, path: string[]) => void;
  },
): void {
  const parser = new SaxesParser({ xmlns: true });
  const path: string[] = [];
  let tags = 0;
  parser.on("error", () => {
    throw new Error("Excel XML 格式无效");
  });
  parser.on("doctype", () => {
    throw new Error("不支持 Excel XML DTD 或实体声明");
  });
  parser.on("opentag", (tag) => {
    path.push(tag.name.split(":").pop()!);
    if (
      ++tags > 100_000 ||
      path.length > 32 ||
      Object.keys(tag.attributes).length > 64
    )
      throw new Error("Excel XML 结构超出限制");
    if (
      Object.values(tag.attributes).some(
        (attribute) => attribute.value.length > 4096,
      )
    )
      throw new Error("Excel XML 属性过长");
    const attributes: Record<string, string> = Object.create(null);
    for (const attribute of Object.values(tag.attributes)) {
      const relationshipId =
        attribute.local === "id" &&
        [
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
          "http://purl.oclc.org/ooxml/officeDocument/relationships",
        ].includes(attribute.uri);
      attributes[relationshipId ? "r:id" : attribute.name] = attribute.value;
    }
    handlers.open?.({ name: tag.local, uri: tag.uri, attributes }, path);
  });
  const text = (value: string) => {
    if (value.length > 4096) throw new Error("Excel 文本超出限制");
    handlers.text?.(value, path);
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", () => {
    handlers.close?.(path[path.length - 1], path);
    path.pop();
  });
  parser.write(xml).close();
}
