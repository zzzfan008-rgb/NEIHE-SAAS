import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  compositeMaskedEdit,
  maskGenerationDimensions,
  prepareMaskForGeneration,
} from "../server/lib/maskProcessing";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

async function solidImage(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Promise<string> {
  const buffer = await sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function rectangularMask(
  width: number,
  height: number,
  rectangle: { left: number; top: number; width: number; height: number },
): Promise<string> {
  const pixels = Buffer.alloc(width * height * 4, 255);
  for (let y = rectangle.top; y < rectangle.top + rectangle.height; y += 1) {
    for (let x = rectangle.left; x < rectangle.left + rectangle.width; x += 1) {
      pixels[(y * width + x) * 4 + 3] = 0;
    }
  }
  const buffer = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function rawImage(dataUrl: string) {
  return sharp(Buffer.from(dataUrl.split(",")[1], "base64"))
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function pixel(
  image: Awaited<ReturnType<typeof rawImage>>,
  x: number,
  y: number,
): { r: number; g: number; b: number; a?: number } {
  const offset = (y * image.info.width + x) * image.info.channels;
  return {
    r: image.data[offset],
    g: image.data[offset + 1],
    b: image.data[offset + 2],
    ...(image.info.channels === 4 ? { a: image.data[offset + 3] } : {}),
  };
}

function assertRgbNear(
  actual: ReturnType<typeof pixel>,
  expected: { r: number; g: number; b: number; a?: number },
  tolerance = 4,
): void {
  assert.ok(Math.abs(actual.r - expected.r) <= tolerance, `red ${actual.r} != ${expected.r}`);
  assert.ok(Math.abs(actual.g - expected.g) <= tolerance, `green ${actual.g} != ${expected.g}`);
  assert.ok(Math.abs(actual.b - expected.b) <= tolerance, `blue ${actual.b} != ${expected.b}`);
  if (expected.a !== undefined) assert.equal(actual.a, expected.a);
}

console.log("蒙版合成回归测试");

const width = 128;
const height = 128;
const source = await solidImage(width, height, { r: 35, g: 92, b: 165 });
const mask = await rectangularMask(width, height, { left: 40, top: 40, width: 48, height: 48 });

await test("统一局部修改采用完整画面，核心连续替换且轮廓可越过用户选区", async () => {
  const generatedPixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 3;
    generatedPixels[offset] = 42;
    generatedPixels[offset + 1] = 98;
    generatedPixels[offset + 2] = 170;
  }
  for (let y = 52; y < 76; y += 1) {
    for (let x = 32; x < 76; x += 1) {
      const offset = (y * width + x) * 3;
      generatedPixels[offset] = 225;
      generatedPixels[offset + 1] = 42;
      generatedPixels[offset + 2] = 48;
    }
  }
  const generated = await sharp(generatedPixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const generatedUrl = `data:image/png;base64,${generated.toString("base64")}`;
  const output = await compositeMaskedEdit(source, mask, generatedUrl);
  const decoded = await rawImage(output);
  assertRgbNear(pixel(decoded, 64, 64), { r: 225, g: 42, b: 48, a: 255 }, 12);
  assertRgbNear(pixel(decoded, 36, 64), { r: 225, g: 42, b: 48, a: 255 }, 12);
  assert.deepEqual(pixel(decoded, 24, 64), { r: 35, g: 92, b: 165, a: 255 });
  assert.deepEqual(pixel(decoded, 8, 8), { r: 35, g: 92, b: 165, a: 255 });
});

await test("统一局部修改拒绝透明缺口，避免旧内容从最终画面透出", async () => {
  const transparentPixels = Buffer.alloc(width * height * 4);
  for (let y = 52; y < 76; y += 1) {
    for (let x = 52; x < 76; x += 1) {
      const offset = (y * width + x) * 4;
      transparentPixels[offset] = 225;
      transparentPixels[offset + 1] = 42;
      transparentPixels[offset + 2] = 48;
      transparentPixels[offset + 3] = 255;
    }
  }
  const transparent = await sharp(transparentPixels, {
    raw: { width, height, channels: 4 },
  }).png().toBuffer();
  await assert.rejects(
    compositeMaskedEdit(source, mask, `data:image/png;base64,${transparent.toString("base64")}`),
    /完整修改区仍有透明缺口/,
  );
});

await test("模型蒙版把用户涂抹区当作修改核心，纯色遮蔽旧内容并动态增加延展和融合区", async () => {
  const prepared = await prepareMaskForGeneration(source, mask);
  const decoded = await rawImage(prepared.mask);
  const guide = await rawImage(prepared.guide);
  const contrastingSource = await solidImage(width, height, { r: 210, g: 38, b: 72 });
  const contrastingGuide = await rawImage((await prepareMaskForGeneration(contrastingSource, mask)).guide);
  assert.equal(pixel(decoded, 40, 64).a, 0, "核心选区必须继续可编辑");
  assert.equal(pixel(decoded, 32, 64).a, 0, "动态延展区应明显超出固定小安全边，避免新图案被截断");
  assert.equal(pixel(decoded, 20, 64).a, 255, "融合区之外必须继续受保护");
  assert.ok(prepared.expansionRadius >= 6 && prepared.expansionRadius <= 12, "延展区必须足够容纳轮廓，同时不能吞入远处元素");
  assert.ok(prepared.featherRadius > 0, "最外圈必须有独立羽化融合带");
  assert.deepEqual(
    pixel(guide, 64, 64),
    { r: 239, g: 68, b: 68, a: 255 },
    "引导图核心必须用不透明纯红遮住旧对象和旧阴影",
  );
  assert.deepEqual(
    pixel(contrastingGuide, 64, 64),
    pixel(guide, 64, 64),
    "核心引导颜色不得随原图内容变化，避免继续暗示旧轮廓",
  );
  assert.ok(pixel(guide, 34, 64).r > 35 && pixel(guide, 34, 64).g > 92, "引导图必须把缓冲区标金");
  assert.equal(prepared.size, "816x816");
});

await test("蒙版输出尺寸固定为最接近原图比例的合法 16 像素网格", () => {
  assert.deepEqual(maskGenerationDimensions(1024, 1536), { width: 1024, height: 1536 });
  assert.deepEqual(maskGenerationDimensions(1000, 1000), { width: 1008, height: 1008 });
  assert.throws(() => maskGenerationDimensions(4000, 1000), /宽高比超过/);
});

await test("模型实际返回尺寸与请求不同时仍按整幅画面对齐，不再因尺寸不一致拒绝合成", async () => {
  const generatedWidth = 160;
  const generatedHeight = 160;
  const generatedPixels = Buffer.alloc(generatedWidth * generatedHeight * 3);
  for (let y = 0; y < generatedHeight; y += 1) {
    for (let x = 0; x < generatedWidth; x += 1) {
      const offset = (y * generatedWidth + x) * 3;
      const inMappedCore = y >= 50 && y < 110 && x >= 50 && x < 110;
      const color = !inMappedCore
        ? { r: 35, g: 92, b: 165 }
        : x < generatedWidth / 2
          ? { r: 225, g: 42, b: 48 }
          : { r: 28, g: 196, b: 92 };
      generatedPixels[offset] = color.r;
      generatedPixels[offset + 1] = color.g;
      generatedPixels[offset + 2] = color.b;
    }
  }
  const generatedBuffer = await sharp(generatedPixels, {
    raw: { width: generatedWidth, height: generatedHeight, channels: 3 },
  }).png().toBuffer();
  const generated = `data:image/png;base64,${generatedBuffer.toString("base64")}`;
  const output = await compositeMaskedEdit(source, mask, generated);
  const decoded = await rawImage(output);
  assert.equal(decoded.info.width, width);
  assert.equal(decoded.info.height, height);
  assertRgbNear(pixel(decoded, 52, 64), { r: 225, g: 42, b: 48, a: 255 }, 8);
  assertRgbNear(pixel(decoded, 76, 64), { r: 28, g: 196, b: 92, a: 255 }, 8);
  assert.deepEqual(pixel(decoded, 8, 8), { r: 35, g: 92, b: 165, a: 255 });
});

await test("统一局部修改保留核心外必要的新轮廓，最外圈逐渐融合且范围外像素精确不变", async () => {
  const generatedPixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const isNewContour = y >= 30 && y < 98 && x >= 18 && x < 110;
      const color = isNewContour
        ? { r: 225, g: 42, b: 48 }
        : { r: 35, g: 92, b: 165 };
      generatedPixels[offset] = color.r;
      generatedPixels[offset + 1] = color.g;
      generatedPixels[offset + 2] = color.b;
    }
  }
  const generatedBuffer = await sharp(generatedPixels, {
    raw: { width, height, channels: 3 },
  }).png().toBuffer();
  const generated = `data:image/png;base64,${generatedBuffer.toString("base64")}`;
  const output = await compositeMaskedEdit(source, mask, generated);
  const decoded = await rawImage(output);
  assertRgbNear(pixel(decoded, 64, 64), { r: 225, g: 42, b: 48, a: 255 });
  const transitionPixels = Array.from({ length: 40 }, (_value, x) => pixel(decoded, x, 64));
  assert.ok(
    transitionPixels.some((value) => value.r > 80),
    "新轮廓必须能越过用户核心边界，不得沿原选区硬截断",
  );
  assert.ok(
    transitionPixels.some((value) => value.r > 35 && value.r < 225),
    "外圈必须存在从生成结果到原图的中间融合像素",
  );
  assert.deepEqual(pixel(decoded, 8, 64), { r: 35, g: 92, b: 165, a: 255 });
  assert.deepEqual(pixel(decoded, 8, 8), { r: 35, g: 92, b: 165, a: 255 });
});

await test("完整延展区作为连续局部画面，不再按颜色差异切碎新主体", async () => {
  const generatedPixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const connectedTarget = y >= 52 && y < 76 && x >= 34 && x < 76;
      const lowContrastDetail = y >= 52 && y < 58 && x >= 92 && x < 96;
      const outsideChange = y >= 52 && y < 58 && x >= 116 && x < 120;
      const color = connectedTarget
        ? { r: 225, g: 42, b: 48 }
        : lowContrastDetail
          ? { r: 28, g: 196, b: 92 }
          : outsideChange
            ? { r: 240, g: 30, b: 210 }
          : { r: 35, g: 92, b: 165 };
      generatedPixels[offset] = color.r;
      generatedPixels[offset + 1] = color.g;
      generatedPixels[offset + 2] = color.b;
    }
  }
  const generatedBuffer = await sharp(generatedPixels, {
    raw: { width, height, channels: 3 },
  }).png().toBuffer();
  const output = await compositeMaskedEdit(
    source,
    mask,
    `data:image/png;base64,${generatedBuffer.toString("base64")}`,
  );
  const decoded = await rawImage(output);
  assertRgbNear(pixel(decoded, 36, 64), { r: 225, g: 42, b: 48, a: 255 }, 12);
  assertRgbNear(pixel(decoded, 93, 54), { r: 28, g: 196, b: 92, a: 255 }, 5);
  assert.deepEqual(pixel(decoded, 117, 54), { r: 35, g: 92, b: 165, a: 255 });
});

await test("统一局部修改完整保留延展区内的低对比纹理，不把浅色编织和细流苏切碎", async () => {
  const generatedPixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const strongBody = y >= 52 && y < 76 && x >= 40 && x < 76;
      const subtleConnectedTexture = y >= 56 && y < 72 && x >= 30 && x < 40;
      const secondSubtleDetail = y >= 54 && y < 60 && x >= 94 && x < 98;
      const color = strongBody
        ? { r: 225, g: 42, b: 48 }
        : subtleConnectedTexture
          ? { r: 70, g: 110, b: 180 }
          : secondSubtleDetail
            ? { r: 70, g: 110, b: 180 }
            : { r: 35, g: 92, b: 165 };
      generatedPixels[offset] = color.r;
      generatedPixels[offset + 1] = color.g;
      generatedPixels[offset + 2] = color.b;
    }
  }
  const generatedBuffer = await sharp(generatedPixels, {
    raw: { width, height, channels: 3 },
  }).png().toBuffer();
  const output = await compositeMaskedEdit(
    source,
    mask,
    `data:image/png;base64,${generatedBuffer.toString("base64")}`,
  );
  const decoded = await rawImage(output);
  assertRgbNear(pixel(decoded, 34, 64), { r: 70, g: 110, b: 180, a: 255 }, 5);
  assertRgbNear(pixel(decoded, 95, 56), { r: 70, g: 110, b: 180, a: 255 }, 5);
});

await test("节点只展示统一局部修改说明，不再暴露技术处理模式", () => {
  const sourceCode = fs.readFileSync(path.join(REPO_ROOT, "src/components/nodes/MaskRedrawNode.tsx"), "utf8");
  const processingCode = fs.readFileSync(path.join(REPO_ROOT, "server/lib/maskProcessing.ts"), "utf8");
  assert.doesNotMatch(
    sourceCode,
    /useFlowStore\(selectActiveDocumentTarget\)/,
    "返回新对象的文档目标 selector 不能直接用于渲染期订阅",
  );
  assert.match(sourceCode, /添加、替换或调整/);
  assert.match(sourceCode, /涂抹区不是裁切框/);
  assert.match(sourceCode, /整幅服装自动延展并融合/);
  assert.doesNotMatch(sourceCode, /保持原图|替换选区|maskMode|蒙版处理方式/);
  assert.doesNotMatch(processingCode, /preserveGeneratedLayer|opaqueGeneratedLayer|MaskCompositeMode/);
});

console.log(`\n${passed} 项蒙版合成测试全部通过`);
