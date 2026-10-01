import { posix } from "node:path";
import type { RawColorImportRow } from "../../src/types/colorImport";
import { readColorWorkbookArchive, walkWorkbookXml } from "./colorArchive";

type Cell = { value: string | number | null; error?: string };
function required(files: Map<string, string>, name: string): string {
  const value = files.get(name);
  if (!value) throw new Error(`Excel 缺少 ${name}`);
  return value;
}

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  let current = "";
  walkWorkbookXml(xml, {
    open: (_tag, path) => {
      if (path.at(-1) === "si") current = "";
    },
    text: (value, path) => {
      if (path.at(-1) === "t" && !path.includes("rPh")) current += value;
      if (current.length > 4096) throw new Error("Excel 单元格文本过长");
    },
    close: (name) => {
      if (name === "si") {
        strings.push(current);
        if (strings.length > 20_000) throw new Error("Excel 共享字符串过多");
      }
    },
  });
  return strings;
}

function decodeCell(
  type: string,
  text: string,
  formula: boolean,
  strings: string[],
): Cell {
  if (formula) return { value: null, error: "公式单元格必须改为静态值" };
  if (type === "s") {
    const index = Number(text);
    if (
      !/^\d+$/.test(text) ||
      !Number.isSafeInteger(index) ||
      strings[index] === undefined
    )
      throw new Error("Excel 共享字符串索引无效");
    return { value: strings[index] };
  }
  if (type === "inlineStr" || type === "str") return { value: text };
  if (type === "n" || type === "") {
    if (!text.trim()) return { value: null };
    const value = Number(text);
    if (!Number.isFinite(value))
      return { value: null, error: "数值单元格无效" };
    return { value };
  }
  return { value: null, error: "仅支持文本和数值单元格" };
}

function worksheetRows(
  xml: string,
  sheetName: string,
  strings: string[],
): RawColorImportRow[] {
  const output: RawColorImportRow[] = [];
  let rowNumber = 0;
  let previousRow = 0;
  let cells = new Map<number, Cell>();
  let column = 0;
  let totalCells = 0;
  let inCell = false;
  let type = "";
  let text = "";
  let formula = false;
  let valueSeen = false;
  let codeColumn = 0;
  let ratioColumn = 0;
  let headerFound = false;
  walkWorkbookXml(xml, {
    open: (tag, path) => {
      const name = path.at(-1);
      if (
        [
          "worksheet",
          "sheetData",
          "row",
          "c",
          "v",
          "f",
          "is",
          "t",
          "r",
        ].includes(name!)
      ) {
        if (
          ![
            "",
            "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
            "http://purl.oclc.org/ooxml/spreadsheetml/main",
          ].includes(tag.uri)
        )
          throw new Error("Excel 数据节点命名空间无效");
      }
      if (name === "row" && path.join("/") !== "worksheet/sheetData/row")
        throw new Error("Excel 数据行位置无效");
      if (name === "c" && path.join("/") !== "worksheet/sheetData/row/c")
        throw new Error("Excel 单元格位置无效");
      if (name === "v") {
        if (!inCell || path.at(-2) !== "c" || valueSeen || type === "inlineStr")
          throw new Error("Excel 单元格值重复或位置无效");
        valueSeen = true;
      }
      if (name === "f" && (tag.attributes.t === "array" || tag.attributes.ref))
        throw new Error("请将 Excel 数组或范围公式转换为静态值后导入");
      if (name === "mergeCell")
        throw new Error("请取消 Excel 合并单元格后导入");
      if (name === "row") {
        rowNumber =
          tag.attributes.r === undefined
            ? previousRow + 1
            : Number(tag.attributes.r);
        if (
          !Number.isSafeInteger(rowNumber) ||
          rowNumber <= previousRow ||
          rowNumber > 5001
        )
          throw new Error("Excel 行号无效或超过 5000 条数据限制");
        previousRow = rowNumber;
        cells = new Map();
        column = 0;
      }
      if (name === "c") {
        if (inCell || !path.includes("row") || ++totalCells > 20_000)
          throw new Error("Excel 单元格结构或数量无效");
        const ref = tag.attributes.r;
        if (ref === undefined) column += 1;
        else {
          const match = /^([A-Z]{1,2})(\d+)$/.exec(ref);
          if (!match || Number(match[2]) !== rowNumber)
            throw new Error("Excel 单元格坐标无效");
          column = [...match[1]].reduce(
            (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
            0,
          );
        }
        if (column < 1 || column > 32 || cells.has(column))
          throw new Error("Excel 列数超过 32 或单元格重复");
        inCell = true;
        type = tag.attributes.t ?? "";
        text = "";
        formula = false;
        valueSeen = false;
      }
      if (name === "f" && inCell) formula = true;
    },
    text: (value, path) => {
      if (inCell && ["v", "t"].includes(path.at(-1)!) && !path.includes("rPh"))
        text += value;
      if (text.length > 4096) throw new Error("Excel 单元格文本过长");
    },
    close: (name) => {
      if (name === "c") {
        cells.set(column, decodeCell(type, text, formula, strings));
        inCell = false;
      }
      if (name !== "row" || !cells.size) return;
      if (!headerFound) {
        for (const [col, cell] of cells) {
          if (cell.error) throw new Error("Excel 表头必须是静态文本");
          const header = String(cell.value ?? "").trim();
          if (header === "色号") {
            if (codeColumn) throw new Error("Excel 色号列重复");
            codeColumn = col;
          }
          if (header === "比例") {
            if (ratioColumn) throw new Error("Excel 比例列重复");
            ratioColumn = col;
          }
        }
        if (!codeColumn)
          throw new Error(`工作表 ${sheetName} 第一行需要“色号”列`);
        headerFound = true;
        return;
      }
      if (
        [...cells.values()].every((cell) => cell.value === null && !cell.error)
      )
        return;
      const code = cells.get(codeColumn);
      const ratio = cells.get(ratioColumn);
      const errors = [...cells.values()].flatMap((cell) =>
        cell.error ? [cell.error] : [],
      );
      output.push({
        rowNumber,
        sheetName,
        rawCode: String(code?.value ?? ""),
        rawRatio: ratio?.value ?? null,
        errors,
      });
    },
  });
  if (!headerFound) throw new Error(`工作表 ${sheetName} 没有色号表头`);
  return output;
}

/** Supports static 色号 / 比例 sheets; never evaluates formulas, macros or relationships. */
export async function readXlsxColorRows(
  bytes: Buffer,
): Promise<RawColorImportRow[]> {
  const files = await readColorWorkbookArchive(bytes);
  if (
    !required(files, "[Content_Types].xml").includes(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    )
  )
    throw new Error("仅支持标准 .xlsx 工作簿");
  const relations = new Map<string, string>();
  walkWorkbookXml(required(files, "xl/_rels/workbook.xml.rels"), {
    open: (tag) => {
      if (
        tag.name.split(":").pop() !== "Relationship" ||
        !tag.attributes.Type?.endsWith("/worksheet")
      )
        return;
      const { Id: id, Target: target } = tag.attributes;
      if (
        !id ||
        !target ||
        relations.has(id) ||
        target.includes("\\") ||
        target.includes(":") ||
        target.includes("%")
      )
        throw new Error("Excel 工作表引用无效");
      const path = posix.normalize(
        target.startsWith("/") ? target.slice(1) : posix.join("xl", target),
      );
      if (!path.startsWith("xl/worksheets/") || !path.endsWith(".xml"))
        throw new Error("Excel 工作表引用越界");
      relations.set(id, path);
    },
  });
  const strings = sharedStrings(files.get("xl/sharedStrings.xml"));
  const sheets: { name: string; path: string }[] = [];
  walkWorkbookXml(required(files, "xl/workbook.xml"), {
    open: (tag, path) => {
      if (path.at(-1) !== "sheet") return;
      const name = tag.attributes.name;
      const reference = tag.attributes["r:id"];
      const target = relations.get(reference);
      if (
        !name ||
        !target ||
        sheets.length >= 8 ||
        sheets.some((sheet) => sheet.name === name || sheet.path === target)
      )
        throw new Error("Excel 工作表无效、重复或超过 8 个");
      sheets.push({ name, path: target });
    },
  });
  if (!sheets.length) throw new Error("Excel 没有可导入工作表");
  const rows = sheets.flatMap((sheet) =>
    worksheetRows(required(files, sheet.path), sheet.name, strings),
  );
  if (rows.length > 5000) throw new Error("Excel 合计最多 5000 条数据");
  return rows;
}
