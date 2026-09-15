import assert from "node:assert/strict";
import {
  parseAdobeSwatches,
  SwatchParseError,
} from "../server/lib/adobeSwatches";

function u16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}
function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}
function utf16(value: string, terminated = false): Buffer {
  return Buffer.from(value + (terminated ? "\0" : ""), "utf16le").swap16();
}
function acbText(value: string): Buffer {
  return Buffer.concat([u32(value.length), utf16(value)]);
}
function aseText(value: string): Buffer {
  return Buffer.concat([u16(value.length + 1), utf16(value, true)]);
}
function block(type: number, data: Buffer): Buffer {
  return Buffer.concat([u16(type), u32(data.length), data]);
}
function aseColor(
  name: string,
  space: string,
  components: number[],
  type = 1,
): Buffer {
  const bytes = Buffer.alloc(components.length * 4);
  components.forEach((value, index) => bytes.writeFloatBE(value, index * 4));
  return block(
    1,
    Buffer.concat([aseText(name), Buffer.from(space), bytes, u16(type)]),
  );
}
function ase(blocks: Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from("ASEF"),
    u16(1),
    u16(0),
    u32(blocks.length),
    ...blocks,
  ]);
}
function acb(
  entries = [{ name: "11-0001 TCX", bytes: [255, 128, 128] }],
  space = 7,
  trailer = "spflspot",
): Buffer {
  return Buffer.concat([
    Buffer.from("8BCB"),
    u16(1),
    u16(42),
    ...[
      "$$$/colorbook/test/title=Test",
      "$$$/colorbook/test/prefix=PANTONE ",
      "",
      "Description",
    ].map(acbText),
    u16(entries.length),
    u16(7),
    u16(1),
    u16(space),
    ...entries.map((entry, index) =>
      Buffer.concat([
        acbText(entry.name),
        Buffer.from(String(index).padStart(6, "0")),
        Buffer.from(entry.bytes),
      ]),
    ),
    Buffer.from(trailer),
  ]);
}
let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
function rejects(bytes: Buffer): void {
  assert.throws(() => parseAdobeSwatches(bytes), SwatchParseError);
}

test("ASE retains RGB values, name and normal color type without inventing Pantone identity", () => {
  const result = parseAdobeSwatches(
    ase([aseColor("#ECDBA5", "RGB ", [236 / 255, 219 / 255, 165 / 255], 2)]),
  );
  assert.equal(result.format, "ase");
  assert.equal(result.colors.length, 1);
  const color = result.colors[0];
  assert.equal(color.name, "#ECDBA5");
  assert.equal(color.colorType, "normal");
  assert.equal(color.space, "RGB");
  assert.deepEqual(
    color.components.map((value) => Math.round(value * 255)),
    [236, 219, 165],
  );
  assert.deepEqual(color.encodedComponents, color.components);
  assert.equal(color.encoding, "ase-float32");
  assert.deepEqual(color.groupPath, []);
});

test("ASE groups and duplicate names retain ordered entries without HEX deduplication", () => {
  const result = parseAdobeSwatches(
    ase([
      block(0xc001, aseText("Season")),
      aseColor("A", "RGB ", [1, 0, 0]),
      aseColor("A", "RGB ", [1, 0, 0]),
      block(0xc002, Buffer.alloc(0)),
      aseColor("B", "Gray", [0.5], 0),
    ]),
  );
  assert.equal(result.colors.length, 3);
  assert.deepEqual(result.colors[0].groupPath, ["Season"]);
  assert.deepEqual(result.colors[2].groupPath, []);
  assert.equal(result.colors[2].colorType, "global");
});

test("ASE Lab scales L only and preserves original float components", () => {
  const color = parseAdobeSwatches(
    ase([aseColor("Sample", "LAB ", [0.5, -20, 40])]),
  ).colors[0];
  assert.equal(color.space, "Lab");
  assert.deepEqual(color.components, [50, -20, 40]);
  assert.deepEqual(color.encodedComponents, [0.5, -20, 40]);
});

test("ASE supports CMYK without an unprofiled HEX conversion", () => {
  const color = parseAdobeSwatches(
    ase([aseColor("CMYK", "CMYK", [0, 0.25, 0.5, 1])]),
  ).colors[0];
  assert.equal(color.space, "CMYK");
  assert.deepEqual(color.components, [0, 0.25, 0.5, 1]);
  assert.ok(!("hex" in color));
});

test("ACB retains metadata and catalog code, decodes Lab and recognizes spot trailer", () => {
  const result = parseAdobeSwatches(acb());
  assert.equal(result.book?.title, "Test");
  assert.equal(result.book?.prefix, "PANTONE ");
  assert.equal(result.book?.rawTitle, "$$$/colorbook/test/title=Test");
  assert.equal(result.book?.id, 42);
  assert.equal(result.book?.pageSize, 7);
  assert.equal(result.book?.pageOffset, 1);
  assert.equal(result.colors[0].name, "PANTONE 11-0001 TCX");
  assert.equal(result.colors[0].rawName, "11-0001 TCX");
  assert.equal(result.colors[0].catalogCode, "000000");
  assert.equal(result.colors[0].colorType, "spot");
  assert.deepEqual(result.colors[0].components, [100, 0, 0]);
  assert.deepEqual(result.colors[0].encodedComponents, [255, 128, 128]);
});

test("ACB allows older books without trailer and accounts for padding records", () => {
  const result = parseAdobeSwatches(
    acb(
      [
        { name: "", bytes: [0, 0, 0] },
        { name: "A", bytes: [127, 128, 128] },
      ],
      7,
      "",
    ),
  );
  assert.equal(result.recordCount, 2);
  assert.equal(result.paddingCount, 1);
  assert.equal(result.colors.length, 1);
  assert.equal(result.colors[0].recordIndex, 1);
  assert.equal(result.colors[0].colorType, "unspecified");
  assert.equal(result.colors[0].components[0], (127 * 100) / 255);
});

test("ACB CMYK bytes are inverted; RGB bytes are normalized", () => {
  const cmyk = parseAdobeSwatches(
    acb([{ name: "A", bytes: [255, 0, 255, 0] }], 2, "spflproc"),
  );
  assert.deepEqual(cmyk.colors[0].components, [0, 1, 0, 1]);
  assert.equal(cmyk.colors[0].colorType, "normal");
  assert.deepEqual(
    parseAdobeSwatches(acb([{ name: "A", bytes: [255, 0, 128] }], 0)).colors[0]
      .components,
    [1, 0, 128 / 255],
  );
});

test("Every truncated prefix of valid files is rejected", () => {
  for (const bytes of [
    ase([aseColor("A", "RGB ", [1, 0, 0])]),
    acb([], 7, ""),
  ]) {
    for (let end = 0; end < bytes.length; end += 1)
      rejects(bytes.subarray(0, end));
  }
});

test("Unsupported versions, signatures, spaces and color types fail explicitly", () => {
  rejects(Buffer.from("not a palette"));
  const bytes = ase([]);
  bytes.writeUInt16BE(2, 4);
  rejects(bytes);
  rejects(ase([aseColor("A", "HSB ", [0, 0, 0])]));
  rejects(ase([aseColor("A", "RGB ", [0, 0, 0], 3)]));
  rejects(acb([], 5));
});

test("Invalid floats, ranges and nonterminated strings are rejected", () => {
  for (const value of [NaN, Infinity, -0.1, 1.1])
    rejects(ase([aseColor("A", "RGB ", [value, 0, 0])]));
  rejects(ase([aseColor("A", "LAB ", [0.5, -129, 0])]));
  const bytes = aseColor("A", "RGB ", [0, 0, 0]);
  bytes.writeUInt16BE(65, 10);
  rejects(ase([bytes]));
  rejects(ase([aseColor("A\0B", "RGB ", [0, 0, 0])]));
});

test("Unbalanced groups, unknown blocks and trailing bytes cannot be silently ignored", () => {
  rejects(ase([block(0xc001, aseText("Group"))]));
  rejects(ase([block(0xc002, Buffer.alloc(0))]));
  rejects(ase([block(0xff, Buffer.alloc(0))]));
  rejects(Buffer.concat([ase([]), Buffer.from([0])]));
  rejects(acb([], 7, "anything"));
});

test("Count, string length and input size limits reject before allocation", () => {
  const count = ase([]);
  count.writeUInt32BE(0xffffffff, 8);
  rejects(count);
  const length = acb([]);
  length.writeUInt32BE(0xffffffff, 8);
  rejects(length);
  rejects(Buffer.alloc(16 * 1024 * 1024 + 1));
});

test("UTF-16 rejects lone surrogates and preserves valid Unicode and BOM characters", () => {
  rejects(ase([aseColor("\uD800", "RGB ", [0, 0, 0])]));
  rejects(acb([{ name: "\uDC00", bytes: [255, 128, 128] }]));
  for (const name of ["中😀", "\uFEFFA"]) {
    assert.equal(
      parseAdobeSwatches(ase([aseColor(name, "RGB ", [0, 0, 0])])).colors[0]
        .rawName,
      name,
    );
    assert.equal(
      parseAdobeSwatches(acb([{ name, bytes: [255, 128, 128] }])).colors[0]
        .rawName,
      name,
    );
  }
});

test("ASE block lengths isolate neighboring records and reject partial or extra fields", () => {
  for (const delta of [-1, 1, 0xffffffff]) {
    const first = aseColor("A", "RGB ", [0, 0, 0]);
    first.writeUInt32BE(
      delta === 0xffffffff ? delta : first.readUInt32BE(2) + delta,
      2,
    );
    rejects(ase([first, aseColor("B", "RGB ", [1, 1, 1])]));
  }
  rejects(ase([block(0xc001, aseText("A")), block(0xc002, Buffer.from([0]))]));
});

test("ASE nesting limit accepts eight levels and rejects nine", () => {
  const nested = (depth: number) =>
    ase([
      ...Array.from({ length: depth }, () => block(0xc001, aseText("Group"))),
      aseColor("A", "RGB ", [0, 0, 0]),
      ...Array.from({ length: depth }, () => block(0xc002, Buffer.alloc(0))),
    ]);
  assert.equal(parseAdobeSwatches(nested(8)).colors[0].groupPath.length, 8);
  rejects(nested(9));
});

test("ACB record and trailer truncations fail except complete removal of the optional trailer", () => {
  const full = acb();
  const bare = full.subarray(0, full.length - 8);
  assert.equal(parseAdobeSwatches(bare).colors.length, 1);
  for (let end = 0; end < bare.length; end += 1) rejects(bare.subarray(0, end));
  for (let extra = 1; extra < 8; extra += 1)
    rejects(full.subarray(0, bare.length + extra));
  rejects(Buffer.concat([full, Buffer.from([0])]));
});
console.log(`${passed} Adobe 色板解析测试通过`);
