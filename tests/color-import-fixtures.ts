import { crc32, deflateRawSync } from "node:zlib";

export function makeAse(
  colors: { name: string; space: string; components: number[] }[],
): Buffer {
  const header = Buffer.alloc(12);
  header.write("ASEF");
  header.writeUInt16BE(1, 4);
  header.writeUInt32BE(colors.length, 8);
  return Buffer.concat([
    header,
    ...colors.map(({ name, space, components }) => {
      const text = Buffer.from(name + "\0", "utf16le").swap16();
      const block = Buffer.alloc(
        6 + 2 + text.length + 4 + components.length * 4 + 2,
      );
      block.writeUInt16BE(1);
      block.writeUInt32BE(block.length - 6, 2);
      block.writeUInt16BE(name.length + 1, 6);
      text.copy(block, 8);
      block.write(space, 8 + text.length);
      components.forEach((value, i) =>
        block.writeFloatBE(value, 12 + text.length + i * 4),
      );
      block.writeUInt16BE(1, block.length - 2);
      return block;
    }),
  ]);
}

export function makeZip(entries: [string, string][], compress = false): Buffer {
  let offset = 0;
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  for (const [name, text] of entries) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(text);
    const data = compress ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30);
    const index = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(compress ? 8 : 0, 8);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE(20, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt16LE(compress ? 8 : 0, 10);
    index.writeUInt32LE(crc32(bytes), 16);
    index.writeUInt32LE(data.length, 20);
    index.writeUInt32LE(bytes.length, 24);
    index.writeUInt16LE(filename.length, 28);
    index.writeUInt32LE(offset, 42);
    local.push(header, filename, data);
    central.push(index, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export function xlsxEntries(sheet: string): [string, string][] {
  return [
    [
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    ],
    [
      "xl/workbook.xml",
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ],
    [
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ],
    [
      "xl/worksheets/sheet1.xml",
      `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
    ],
  ];
}
export const headerRow =
  '<row r="1"><c r="A1" t="inlineStr"><is><t>色号</t></is></c><c r="B1" t="inlineStr"><is><t>比例</t></is></c></row>';
