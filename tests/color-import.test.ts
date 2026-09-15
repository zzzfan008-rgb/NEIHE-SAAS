import assert from "node:assert/strict";
import { readXlsxColorRows } from "../server/lib/xlsxColorRows";
import { parseColorImport } from "../server/lib/colorImport";
import { buildColorCatalog } from "../server/lib/colorCatalog";
import { headerRow, makeAse, makeZip, xlsxEntries } from "./color-import-fixtures";

const codeRow = (row: number, code: string, ratio = "") => `<row r="${row}"><c r="A${row}" t="inlineStr"><is><t>${code}</t></is></c>${ratio ? `<c r="B${row}"><v>${ratio}</v></c>` : ""}</row>`;
const bytes = makeZip(xlsxEntries(headerRow + codeRow(2, "13-1007.TCX", "0.38") + codeRow(3, "11-1111.TCX") + codeRow(4, "13-1007.TCX", "0.3")));
const rows = await readXlsxColorRows(bytes);
assert.equal(rows.length, 3);
assert.equal(rows[0].rawCode, "13-1007.TCX");
assert.equal(rows[0].rawRatio, 0.38);
assert.equal(rows[1].rawRatio, null);
assert.equal(rows[1].rowNumber, 3);
const catalog = buildColorCatalog([{ libraryKey: "tcx", version: "test", fileName: "test.ase", labWhitePoint: "D50", bytes: makeAse([{ name: "13-1007 TCX", space: "LAB ", components: [0.5, 0, 0] }]) }]);
const preview = await parseColorImport(bytes, "xlsx", catalog, "tcx");
assert.deepEqual(preview.rows.map((row) => row.status), ["duplicate", "unmatched", "duplicate"]);
assert.equal(preview.rows[0].ratio, 0.38);
assert.equal(preview.rows[1].ratio, null);
assert.equal(preview.fileHash.length, 64);
const exact = await parseColorImport(makeZip(xlsxEntries(headerRow + codeRow(2, "13-1007.TCX", "0.38"))), "xlsx", catalog, "tcx");
assert.equal(exact.rows[0].matchedCatalogId, catalog[0].id);
assert.equal(exact.rows[0].status, "matched");
assert.deepEqual(exact.rows[0].matchedColor, {
  catalogId: catalog[0].id,
  libraryKey: "tcx",
  code: "13-1007 TCX",
  hex: catalog[0].variants[0]?.display?.hex ?? null,
});
const ase = await parseColorImport(makeAse([{ name: "#ECDBA5", space: "RGB ", components: [236 / 255, 219 / 255, 165 / 255] }]), "ase", catalog, "tcx");
assert.equal(ase.rows[0].status, "missing-code");
assert.equal(ase.rows[0]?.matchedColor, null);
assert.equal(ase.rows[0].matchedCatalogId, null);
assert.equal(ase.rows[0].sourceHex, "#ECDBA5");
assert.equal(ase.rows[0].candidates[0].approximate, true);
assert.ok(ase.rows[0].originalSwatch);

const formula = await readXlsxColorRows(makeZip(xlsxEntries(headerRow + '<row r="2"><c r="A2" t="str"><f>HYPERLINK("http://invalid")</f><v>13-1007.TCX</v></c></row>')));
assert.ok(formula[0].errors.length > 0);
assert.equal(formula[0].rawCode, "");
await assert.rejects(() => readXlsxColorRows(Buffer.from("not zip")));
await assert.rejects(() => readXlsxColorRows(makeZip([["../evil.xml", "x"]])));
await assert.rejects(() => readXlsxColorRows(makeZip([["xl/workbook.xml", "a"], ["xl/workbook.xml", "b"]])));
await assert.rejects(() => readXlsxColorRows(makeZip(xlsxEntries(headerRow).map(([name, text]) => [name, name === "xl/workbook.xml" ? '<!DOCTYPE x [<!ENTITY e "x">]><x>&e;</x>' : text]))));
await assert.rejects(() => readXlsxColorRows(makeZip(xlsxEntries(headerRow).map(([name, text]) => [name, name.endsWith(".rels") ? text.replace('Target="worksheets', 'TargetMode="External" Target="https://invalid/worksheets') : text]))));
await assert.rejects(() => readXlsxColorRows(makeZip(xlsxEntries(headerRow + codeRow(5002, "13-1007 TCX")))));
await assert.rejects(() => readXlsxColorRows(makeZip([["bomb.xml", "x".repeat(8 * 1024 * 1024 + 1)]], true)));
const tiny = await parseColorImport(makeZip(xlsxEntries(headerRow + codeRow(2, "13-1007 TCX", "0.0000001"))), "xlsx", catalog, "tcx");
assert.equal(tiny.rows[0].status, "matched");
assert.equal(tiny.rows[0].ratio, 1e-7);
await assert.rejects(() => readXlsxColorRows(makeZip(xlsxEntries(headerRow + '<row r="2"><c r="A2" t="str"><f t="array" ref="A2:A3">TEST()</f><v>13-1007 TCX</v></c></row>' + codeRow(3, "13-1007 TCX")))));
await assert.rejects(() => readXlsxColorRows(makeZip(xlsxEntries(headerRow + '<row r="2"><c r="A2" t="str"><v>13-1007</v><v> TCX</v></c></row>'))));
await assert.rejects(() => readXlsxColorRows(makeZip(xlsxEntries(headerRow).map(([name, xml]) => [name, name.endsWith("sheet1.xml") ? xml.replace('</worksheet>', '<extLst><ext><x:row xmlns:x="urn:test" r="2"><x:c r="A2" t="inlineStr"><x:is><x:t>13-1007 TCX</x:t></x:is></x:c></x:row></ext></extLst></worksheet>') : xml]))));
await assert.rejects(() => readXlsxColorRows(makeZip(xlsxEntries(headerRow + '<row r="2"><x:c xmlns:x="urn:test" r="A2" t="inlineStr"><x:is><x:t>13-1007 TCX</x:t></x:is></x:c></row>'))));
const manyCandidates = buildColorCatalog([{ libraryKey: "tcx", version: "synthetic", fileName: "many.ase", bytes: makeAse(Array.from({ length: 2000 }, (_, i) => ({ name: `11-${1000 + i} TCX`, space: "RGB " as const, components: [0.5, 0.5, 0.5] }))) }]);
const manyUnmatched = makeAse(Array.from({ length: 1001 }, (_, i) => ({ name: `sample-${i}`, space: "RGB " as const, components: [(i % 256) / 255, Math.floor(i / 256) / 255, 0] })));
await assert.rejects(() => parseColorImport(manyUnmatched, "ase", manyCandidates, "tcx"), /拆分/);
const groupText = Buffer.from("G".repeat(4095) + "\0", "utf16le").swap16();
const groupBlock = Buffer.alloc(8 + groupText.length);
groupBlock.writeUInt16BE(0xc001); groupBlock.writeUInt32BE(groupText.length + 2, 2); groupBlock.writeUInt16BE(4096, 6); groupText.copy(groupBlock, 8);
const endGroup = Buffer.alloc(6); endGroup.writeUInt16BE(0xc002);
const groupedColors = makeAse(Array.from({ length: 500 }, () => ({ name: "13-1007 TCX", space: "RGB " as const, components: [0.5, 0.5, 0.5] })));
const groupedHeader = Buffer.from(groupedColors.subarray(0, 12)); groupedHeader.writeUInt32BE(516, 8);
const expandedGroups = Buffer.concat([groupedHeader, ...Array<Buffer>(8).fill(groupBlock), groupedColors.subarray(12), ...Array<Buffer>(8).fill(endGroup)]);
await assert.rejects(() => parseColorImport(expandedGroups, "ase", catalog, "tcx"), /展开|预览/);
console.log("XLSX/ASE 导入预览、空比例、重复/缺失、公式与恶意文件边界测试通过");
