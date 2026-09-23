import assert from "node:assert/strict";
import sharp from "sharp";
import { apiyiProviders } from "../server/providers/apiyi";

const originalFetch = globalThis.fetch;
const originalBase = process.env.APIYI_BASE_URL;
const originalKey = process.env.APIYI_API_KEY;
process.env.APIYI_BASE_URL = "https://gateway.example";
process.env.APIYI_API_KEY = "test-only-key";

try {
  const opaque = await sharp({
    create: { width: 12, height: 8, channels: 3, background: "#ffffff" },
  })
    .withMetadata({ exif: { IFD0: { Copyright: "private-metadata" } } })
    .png()
    .toBuffer();
  const transparent = await sharp({
    create: {
      width: 12,
      height: 8,
      channels: 4,
      background: { r: 30, g: 80, b: 130, alpha: 0.3 },
    },
  })
    .png()
    .toBuffer();
  const references = [opaque, transparent].map(
    (buffer) => `data:image/png;base64,${buffer.toString("base64")}`,
  );
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    const parts = body.contents[0].parts.slice(1) as Array<{
      inline_data: { mime_type: string; data: string };
    }>;
    assert.deepEqual(
      parts.map((part) => part.inline_data.mime_type),
      ["image/jpeg", "image/png"],
    );
    const [opaqueSent, transparentSent] = parts.map((part) =>
      Buffer.from(part.inline_data.data, "base64"),
    );
    assert.notDeepEqual(
      opaqueSent,
      opaque,
      "small opaque references must be re-encoded",
    );
    const opaqueMetadata = await sharp(opaqueSent).metadata();
    const transparentMetadata = await sharp(transparentSent).metadata();
    assert.equal(opaqueMetadata.space, "srgb");
    assert.equal(opaqueMetadata.exif, undefined);
    assert.equal(
      transparentMetadata.hasAlpha,
      true,
      "transparency must not be flattened",
    );
    assert.deepEqual(
      [transparentMetadata.width, transparentMetadata.height],
      [12, 8],
    );
    return Response.json({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: "image/png",
                  data: references[0].split(",")[1],
                },
              },
            ],
          },
        },
      ],
    });
  };
  await apiyiProviders["gemini-3-pro-image-preview"].edit({
    prompt: "test",
    referenceImages: references,
    modelOptions: { imageSize: "2K", aspectRatio: "1:1" },
  });
  assert.equal(calls, 1);
} finally {
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.APIYI_BASE_URL;
  else process.env.APIYI_BASE_URL = originalBase;
  if (originalKey === undefined) delete process.env.APIYI_API_KEY;
  else process.env.APIYI_API_KEY = originalKey;
}
console.log("Gemini reference normalization passed");
