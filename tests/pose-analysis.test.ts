import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-pose-analysis-"));
process.env.DATA_DIR = temp;
process.env.APIYI_BASE_URL = "https://api.apiyi.com";
process.env.APIYI_API_KEY = "test-only-key";
process.env.POSE_ANALYSIS_MODEL = "gemini-3-flash-preview";

const IMAGE = `data:image/png;base64,${(await sharp({
  create: { width: 300, height: 500, channels: 3, background: "white" },
}).png().toBuffer()).toString("base64")}`;
const point = (x: number, y: number) => ({ x, y });
const ANALYSIS = {
  points: {
    head: point(0.5, 0.12), gazeTarget: point(0.62, 0.12), neck: point(0.5, 0.2),
    leftShoulder: point(0.38, 0.23), rightShoulder: point(0.62, 0.23),
    leftElbow: point(0.3, 0.38), rightElbow: point(0.7, 0.4),
    leftWrist: point(0.42, 0.48), rightWrist: point(0.78, 0.52),
    pelvis: point(0.52, 0.52), leftHip: point(0.44, 0.53), rightHip: point(0.6, 0.54),
    leftKnee: point(0.43, 0.72), rightKnee: point(0.66, 0.7),
    leftAnkle: point(0.4, 0.93), rightAnkle: point(0.72, 0.9),
  },
  bodyPose: "肩线向画面右侧略低，躯干微向画面左侧倾斜，重心落在画面左腿",
  torsoPose: "躯干略向画面左侧倾斜",
  legPose: "画面左侧腿支撑，另一侧膝部弯曲",
  handPose: "画面左肘弯曲且腕部靠近腰侧，画面右腕向外",
  headPose: "头部轻微向画面右侧倾斜并保持平视",
  gazeDirection: "视线朝画面右侧",
  facialExpression: "眼睑微收，嘴唇闭合，嘴角轻微上扬",
};

let calls = 0;
let requestBody: Record<string, unknown> | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  calls += 1;
  requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
  const responseAnalysis = calls === 2 ? { ...ANALYSIS, bodyPose: "穿着红色外套站立" } : ANALYSIS;
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(responseAnalysis) }] } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

try {
  const { analyzePoseReference } = await import("../server/lib/poseAnalysis");
  let marked = 0;
  const first = await analyzePoseReference(IMAGE, {
    beforeProviderCall: async (providerRequest) => { marked = providerRequest; },
  });
  const second = await analyzePoseReference(IMAGE);

  assert.equal(calls, 1);
  assert.equal(marked, 1);
  assert.equal(first.providerRequests, 1);
  assert.equal(first.cacheHit, false);
  assert.equal(second.providerRequests, 0);
  assert.equal(second.cacheHit, true);
  assert.match(first.prompt, /重心落在画面左腿/);
  assert.match(first.prompt, /视线朝画面右侧/);
  assert.deepEqual(first.prompt.split('\n').map(line => line.split('：')[0]), ['整体姿态', '躯干姿态', '下肢姿态', '上肢与手部', '头部姿态', '视线方向', '面部神态']);
  assert.match(first.prompt, /面部神态：眼睑微收/);
  assert.ok(first.guideImage.startsWith("data:image/png;base64,"));
  const guide = await sharp(Buffer.from(first.guideImage.split(",")[1], "base64")).metadata();
  assert.equal(guide.width, 300);
  assert.equal(guide.height, 500);

  const body = requestBody as {
    contents?: Array<{ parts?: Array<{ text?: string; inlineData?: { mimeType?: string } }> }>;
    generationConfig?: { responseMimeType?: string; temperature?: number };
  };
  assert.equal(body.contents?.[0]?.parts?.[1]?.inlineData?.mimeType, "image/png");
  assert.match(body.contents?.[0]?.parts?.[0]?.text ?? "", /严禁描述或推断人物身份/);
  assert.equal(body.generationConfig?.responseMimeType, "application/json");
  assert.equal(body.generationConfig?.temperature, 0);

  const cacheFiles = fs.readdirSync(path.join(temp, "pose-analysis-cache"));
  assert.equal(cacheFiles.length, 1);
  const cacheText = fs.readFileSync(path.join(temp, "pose-analysis-cache", cacheFiles[0]), "utf8");
  assert.ok(!cacheText.includes(IMAGE.split(",")[1]));
  await assert.rejects(
    analyzePoseReference("data:image/png;base64,AA=="),
    /包含禁止传入生图模型的人物、服装或场景内容/,
  );
  assert.equal(calls, 2);
  // Old cached analyses must not satisfy the new schema even for the same image.
  const cachePath = path.join(temp, 'pose-analysis-cache', cacheFiles[0]);
  fs.writeFileSync(cachePath, JSON.stringify({ schemaVersion: 1, model: first.model, analysis: ANALYSIS }));
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      ...ANALYSIS,
      points: Object.fromEntries(Object.keys(ANALYSIS.points).map(key => [key, null])),
      gazeDirection: '无法判断：眼部不可辨认',
      facialExpression: '无法判断：面部不可辨认',
    }) }] } }] }), { status: 200 });
  };
  const unknown = await analyzePoseReference(IMAGE);
  assert.equal(calls, 3);
  assert.equal(unknown.cacheHit, false);
  assert.match(unknown.prompt, /面部神态：无法判断/);
  assert.ok(unknown.guideImage.startsWith('data:image/png;base64,'));
  assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).schemaVersion, 2);
  globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{
    text: JSON.stringify({ ...ANALYSIS, facialExpression: undefined }),
  }] } }] }), { status: 200 });
  await assert.rejects(analyzePoseReference('data:image/png;base64,AQ=='), /facialExpression 无效/);
  console.log("姿势分析测试通过：原图隔离、中性引导图、结构过滤与缓存均有效");
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(temp, { recursive: true, force: true });
}
