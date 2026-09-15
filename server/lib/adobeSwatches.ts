import type {
  AdobeColorBookMetadata,
  AdobeSwatch,
  ParsedAdobeSwatches,
  SwatchColorSpace,
  SwatchColorType,
} from "../../src/types/colorCatalog";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 50_000;
const MAX_STRING_UNITS = 4_096;
const MAX_GROUP_DEPTH = 8;
const utf16Decoder = new TextDecoder("utf-16be", {
  fatal: true,
  ignoreBOM: true,
});

export class SwatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwatchParseError";
  }
}

class SwatchReader {
  private position = 0;
  constructor(private readonly buffer: Buffer) {}

  get remaining(): number {
    return this.buffer.length - this.position;
  }

  bytes(length: number): Buffer {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > this.remaining
    ) {
      throw new SwatchParseError(`色板数据在字节 ${this.position} 处被截断`);
    }
    const result = this.buffer.subarray(this.position, this.position + length);
    this.position += length;
    return result;
  }

  u16(): number {
    return this.bytes(2).readUInt16BE();
  }
  u32(): number {
    return this.bytes(4).readUInt32BE();
  }
  float(): number {
    return this.bytes(4).readFloatBE();
  }
  ascii(length: number): string {
    return this.bytes(length).toString("latin1");
  }

  text(terminated: boolean): string {
    const length = terminated ? this.u16() : this.u32();
    if (length > MAX_STRING_UNITS || (terminated && length === 0)) {
      throw new SwatchParseError("色板字符串长度无效或超出限制");
    }
    let value: string;
    try {
      value = utf16Decoder.decode(this.bytes(length * 2));
    } catch (error) {
      if (error instanceof SwatchParseError) throw error;
      throw new SwatchParseError("色板字符串不是有效 UTF-16BE");
    }
    if (terminated) {
      if (!value.endsWith("\0"))
        throw new SwatchParseError("ASE 字符串缺少结束标记");
      value = value.slice(0, -1);
    }
    if (value.includes("\0"))
      throw new SwatchParseError("色板字符串包含无效空字符");
    return value;
  }

  end(): void {
    if (this.remaining !== 0)
      throw new SwatchParseError("色板包含未识别的剩余数据");
  }
}

function boundedCount(count: number): number {
  if (count > MAX_RECORDS)
    throw new SwatchParseError(`色板最多包含 ${MAX_RECORDS} 条记录`);
  return count;
}

function named(value: string): string {
  if (!value.trim()) throw new SwatchParseError("色板颜色或分组名称不能为空");
  return value;
}

function channelCount(space: SwatchColorSpace): number {
  return space === "CMYK" ? 4 : space === "Gray" ? 1 : 3;
}

function aseSpace(value: string): SwatchColorSpace {
  switch (value) {
    case "RGB ":
      return "RGB";
    case "CMYK":
      return "CMYK";
    case "LAB ":
      return "Lab";
    case "Gray":
      return "Gray";
    default:
      throw new SwatchParseError("不支持的 ASE 颜色空间");
  }
}

function aseColorType(value: number): SwatchColorType {
  switch (value) {
    case 0:
      return "global";
    case 1:
      return "spot";
    case 2:
      return "normal";
    default:
      throw new SwatchParseError("不支持的 ASE 颜色类型");
  }
}

function parseAseColor(
  reader: SwatchReader,
  recordIndex: number,
  groups: string[],
): AdobeSwatch {
  const rawName = named(reader.text(true));
  const space = aseSpace(reader.ascii(4));
  const encodedComponents = Array.from({ length: channelCount(space) }, () =>
    reader.float(),
  );
  encodedComponents.forEach((value, index) => {
    const chroma = space === "Lab" && index > 0;
    if (
      !Number.isFinite(value) ||
      value < (chroma ? -128 : 0) ||
      value > (chroma ? 127 : 1)
    ) {
      throw new SwatchParseError("ASE 颜色分量无效或超出范围");
    }
  });
  const components = encodedComponents.map((value, index) =>
    space === "Lab" && index === 0 ? value * 100 : value,
  );
  const colorType = aseColorType(reader.u16());
  reader.end();
  return {
    recordIndex,
    rawName,
    name: rawName,
    groupPath: [...groups],
    space,
    components,
    encodedComponents,
    encoding: "ase-float32",
    colorType,
  };
}

function parseAse(reader: SwatchReader): ParsedAdobeSwatches {
  if (reader.u16() !== 1 || reader.u16() !== 0)
    throw new SwatchParseError("仅支持 ASE 1.0");
  const recordCount = boundedCount(reader.u32());
  const colors: AdobeSwatch[] = [];
  const groups: string[] = [];
  for (let index = 0; index < recordCount; index += 1) {
    const type = reader.u16();
    const block = new SwatchReader(reader.bytes(reader.u32()));
    if (type === 1) {
      colors.push(parseAseColor(block, index, groups));
    } else if (type === 0xc001) {
      if (groups.length >= MAX_GROUP_DEPTH)
        throw new SwatchParseError("ASE 分组嵌套超出限制");
      groups.push(named(block.text(true)));
      block.end();
    } else if (type === 0xc002) {
      if (!groups.pop()) throw new SwatchParseError("ASE 分组结束标记不匹配");
      block.end();
    } else {
      throw new SwatchParseError(`不支持的 ASE 数据块类型 ${type}`);
    }
  }
  if (groups.length) throw new SwatchParseError("ASE 分组没有结束标记");
  reader.end();
  return {
    format: "ase",
    version: "1.0",
    recordCount,
    paddingCount: 0,
    colors,
  };
}

function localizedValue(value: string): string {
  const separator = value.indexOf("=");
  return value.startsWith("$$$/") && separator >= 0
    ? value.slice(separator + 1)
    : value;
}

function readBookHeader(
  reader: SwatchReader,
): Omit<AdobeColorBookMetadata, "pageSize" | "pageOffset"> {
  const id = reader.u16();
  const [rawTitle, rawPrefix, rawSuffix, rawDescription] = Array.from(
    { length: 4 },
    () => reader.text(false),
  );
  return {
    id,
    rawTitle,
    rawPrefix,
    rawSuffix,
    rawDescription,
    title: localizedValue(rawTitle),
    prefix: localizedValue(rawPrefix),
    suffix: localizedValue(rawSuffix),
    description: localizedValue(rawDescription),
  };
}

function acbSpace(value: number): SwatchColorSpace {
  switch (value) {
    case 0:
      return "RGB";
    case 2:
      return "CMYK";
    case 7:
      return "Lab";
    default:
      throw new SwatchParseError("不支持的 ACB 颜色空间");
  }
}

// ACB byte encoding and optional trailer: https://ates.dev/pages/acb-spec/ (unofficial specification).
function decodeAcbComponents(
  space: SwatchColorSpace,
  bytes: number[],
): number[] {
  if (space === "Lab")
    return [(bytes[0] * 100) / 255, bytes[1] - 128, bytes[2] - 128];
  return bytes.map((value) =>
    space === "CMYK" ? (255 - value) / 255 : value / 255,
  );
}

function acbColorType(reader: SwatchReader): SwatchColorType {
  if (reader.remaining === 0) return "unspecified";
  const trailer = reader.ascii(8);
  reader.end();
  if (trailer === "spflspot") return "spot";
  if (trailer === "spflproc") return "normal";
  throw new SwatchParseError("不支持的 ACB 尾部标记");
}

function parseAcb(reader: SwatchReader): ParsedAdobeSwatches {
  if (reader.u16() !== 1) throw new SwatchParseError("仅支持 ACB 版本 1");
  const header = readBookHeader(reader);
  const recordCount = boundedCount(reader.u16());
  const book = { ...header, pageSize: reader.u16(), pageOffset: reader.u16() };
  const space = acbSpace(reader.u16());
  const colors: AdobeSwatch[] = [];
  let paddingCount = 0;
  for (let index = 0; index < recordCount; index += 1) {
    const rawName = reader.text(false);
    const catalogCode = reader.ascii(6);
    const encodedComponents = [...reader.bytes(channelCount(space))];
    // ACB uses empty-name records as page padding, not selectable colors.
    if (!rawName) {
      paddingCount += 1;
      continue;
    }
    named(rawName);
    colors.push({
      recordIndex: index,
      rawName,
      name: book.prefix + rawName + book.suffix,
      groupPath: [],
      space,
      components: decodeAcbComponents(space, encodedComponents),
      encodedComponents,
      encoding: "acb-byte",
      colorType: "unspecified",
      catalogCode,
    });
  }
  const colorType = acbColorType(reader);
  colors.forEach((color) => {
    color.colorType = colorType;
  });
  return {
    format: "acb",
    version: "1",
    recordCount,
    paddingCount,
    colors,
    book,
  };
}

/** Bounded, in-memory parsing only: no file access, HEX matching, deduplication or database writes. */
export function parseAdobeSwatches(bytes: Buffer): ParsedAdobeSwatches {
  if (bytes.length > MAX_FILE_BYTES)
    throw new SwatchParseError("色板文件不能超过 16 MiB");
  const reader = new SwatchReader(bytes);
  const signature = reader.ascii(4);
  if (signature === "ASEF") return parseAse(reader);
  if (signature === "8BCB") return parseAcb(reader);
  throw new SwatchParseError("文件不是受支持的 ACB 或 ASE 色板");
}
