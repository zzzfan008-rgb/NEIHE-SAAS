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
const ALT_IMAGE = `data:image/png;base64,${(await sharp({
  create: { width: 300, height: 500, channels: 3, background: "#777777" },
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
const CALIBRATED_ANALYSIS = {
  ...ANALYSIS,
  calibration: {
    originalEvidence: "原图可见人物站立，重心落在画面左腿",
    depthEvidence: "深度图显示画面左膝比右膝更靠近镜头",
    skeletonEvidence: "DWPose左膝坐标位于右膝左侧，置信度较高",
    conflicts: "无",
    unknowns: "无法判断被遮挡的脚踝",
  },
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
  const { analyzePoseReference, optimizeCalibratedPrompt, swapPosePromptLeftRight } = await import("../server/lib/poseAnalysis");
  const optimized = optimizeCalibratedPrompt({ ...CALIBRATED_ANALYSIS,
    handPose: '右肘弯曲，右腕靠近髋部，手指状态无法判断',
    gazeDirection: '无法识别',
    facialExpression: '嘴唇闭合，嘴角方向无法判断',
  });
  assert.match(optimized, /肩线向画面左侧略低，躯干微向画面右侧倾斜，重心落在画面右腿/);
  assert.match(optimized, /左肘弯曲，左腕靠近髋部/);
  const leftRight = '左臂在左侧、右腿在右侧，左右错位';
  assert.equal(swapPosePromptLeftRight(leftRight), '右臂在右侧、左腿在左侧，左右错位');
  assert.equal(swapPosePromptLeftRight(swapPosePromptLeftRight(leftRight)), leftRight, '左右互换应可逆');
  assert.match(optimized, /嘴唇闭合/);
  assert.doesNotMatch(optimized, /无法判断|无法识别|原图证据|跨图冲突|视线方向/);
  assert.match(CALIBRATED_ANALYSIS.calibration.unknowns, /无法判断/, '优化不能修改原始校准证据');
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
  assert.equal(body.contents?.[0]?.parts?.[2]?.inlineData?.mimeType, "image/png");
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
  assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).schemaVersion, 5);
  globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{
    text: JSON.stringify({ ...ANALYSIS, facialExpression: undefined }),
  }] } }] }), { status: 200 });
  await assert.rejects(analyzePoseReference('data:image/png;base64,AQ=='), /facialExpression 无效/);
  let deepseekCalls = 0;
  const deepseekOptions = { provider: 'deepseek' as const, ownerId: 'owner-a', apiKey: 'test-only-deepseek-key' };
  globalThis.fetch = async (url, init) => {
    deepseekCalls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${deepseekOptions.apiKey}`);
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, 'deepseek-v4-flash-vision-exp');
    assert.deepEqual(request.messages[0].content[2], { type: 'image_url', image_url: { url: IMAGE, detail: 'original' } });
    assert.equal(request.response_format.type, 'json_object');
    return Response.json({ choices: [{ message: { content: JSON.stringify(ANALYSIS) } }] });
  };
  const deepseek = await analyzePoseReference(IMAGE, deepseekOptions);
  assert.equal(deepseek.cacheHit, false, 'Gemini cache must not satisfy DeepSeek');
  assert.equal(deepseek.model, 'deepseek-v4-flash-vision-exp');
  assert.equal((await analyzePoseReference(IMAGE, deepseekOptions)).cacheHit, true);
  assert.equal(deepseekCalls, 1);
  await analyzePoseReference(IMAGE, { ...deepseekOptions, ownerId: 'owner-b' });
  assert.equal(deepseekCalls, 2, 'Accounts must not share BYOK results');
  await assert.rejects(analyzePoseReference(IMAGE, { ...deepseekOptions, apiKey: '' }), /API Key/);
  globalThis.fetch = async () => new Response(deepseekOptions.apiKey, { status: 401 });
  await assert.rejects(analyzePoseReference(IMAGE, { ...deepseekOptions, ownerId: 'invalid-key' }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /API Key 无效/);
    assert.ok(!JSON.stringify(error).includes(deepseekOptions.apiKey));
    return true;
  });
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ ...ANALYSIS, bodyPose: deepseekOptions.apiKey }) } }] });
  await assert.rejects(analyzePoseReference(IMAGE, { ...deepseekOptions, ownerId: 'echo-secret' }), /格式无效/);
  for (const name of fs.readdirSync(path.join(temp, 'pose-analysis-cache'))) {
    assert.ok(!fs.readFileSync(path.join(temp, 'pose-analysis-cache', name), 'utf8').includes(deepseekOptions.apiKey));
  }
  let calibrationCalls = 0;
  const calibrationBodies: Array<Record<string, any>> = [];
  globalThis.fetch = async (_input, init) => {
    calibrationCalls++;
    const request = JSON.parse(String(init?.body)) as Record<string, any>;
    calibrationBodies.push(request);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(CALIBRATED_ANALYSIS) }] } }] });
  };
  const pose = { schemaVersion: 1, canvas: { width: 300, height: 500 }, people: [{
    keypoints: Array.from({ length: 133 }, (_, index) => ({ x: index / 133, y: (132 - index) / 133, confidence: 0.9 })),
  }] };
  const calibration = { depthImageDataUrl: ALT_IMAGE, skeletonImageDataUrl: IMAGE, pose };
  const calibrated = await analyzePoseReference(IMAGE, { calibration });
  const calibratedParts = calibrationBodies[0].contents[0].parts;
  assert.equal(calibrationCalls, 1);
  assert.ok(calibratedParts[0].text.includes("原始姿势图"));
  assert.equal(calibrated.calibrationMode, 'three-view');
  assert.ok(calibrated.prompt.includes('三图校准结果'));
  assert.match(calibrated.prompt, /肩线向画面右侧略低，躯干微向画面左侧倾斜，重心落在画面左腿/, '原始校准稿应保持原方向');
  assert.match(calibrated.optimizedPrompt ?? '', /肩线向画面左侧略低，躯干微向画面右侧倾斜，重心落在画面右腿/, '优化稿应交换左右方向');
  assert.match(calibratedParts[0].text, /原始姿势图/);
  assert.equal(calibratedParts[2].inlineData.data, IMAGE.split(",")[1]);
  assert.match(calibratedParts[3].text, /深度图/);
  assert.equal(calibratedParts[4].inlineData.data, ALT_IMAGE.split(",")[1]);
  assert.match(calibratedParts[5].text, /DWPose/);
  assert.equal(calibratedParts[6].inlineData.data, IMAGE.split(",")[1]);
  assert.ok(calibratedParts[7].text.includes(JSON.stringify(pose.people[0].keypoints[0])));
  assert.equal((await analyzePoseReference(IMAGE, { calibration })).cacheHit, true);
  await analyzePoseReference(IMAGE, { calibration: { ...calibration, depthImageDataUrl: IMAGE } });
  await analyzePoseReference(IMAGE, { calibration: { ...calibration, skeletonImageDataUrl: ALT_IMAGE } });
  await analyzePoseReference(ALT_IMAGE, { calibration });
  assert.equal(calibrationCalls, 4, "原图、深度图、骨骼图任一变化都必须使校准缓存失效");
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.messages[0].content[0].text.split('\n').filter((line: string) => line.startsWith('{"points"')).length, 1);
    assert.equal(request.messages[0].content.filter((part: { type: string }) => part.type === 'image_url').length, 3);
    assert.match(request.messages[0].content[7].text, /coco-wholebody-133/);
    return Response.json({ choices: [{ message: { content: [
      { type: 'reasoning', text: '内部推理不参与解析' },
      { type: 'text', text: `\`\`\`json\n${JSON.stringify(CALIBRATED_ANALYSIS)}\n\`\`\`` },
    ] } }] });
  };
  const deepseekCalibration = await analyzePoseReference(IMAGE, { ...deepseekOptions, ownerId: 'calibrated-owner', calibration });
  assert.equal(deepseekCalibration.calibrationMode, 'three-view', 'DeepSeek content blocks containing fenced JSON should parse');
  assert.match(deepseekCalibration.prompt, /三图校准结果/);
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ ...CALIBRATED_ANALYSIS, bodyPose: '' }) } }] });
  await assert.rejects(
    analyzePoseReference(IMAGE, { ...deepseekOptions, ownerId: 'invalid-calibrated-owner', calibration }),
    /姿势分析字段 bodyPose 无效/,
    'DeepSeek schema errors should remain actionable without exposing model output',
  );
  globalThis.fetch = async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{"points":' } }] });
  await assert.rejects(
    analyzePoseReference(IMAGE, { ...deepseekOptions, ownerId: 'truncated-calibrated-owner', calibration }),
    /DeepSeek 输出未完整结束/,
  );
  const responseFailures: string[] = [];
  const calibratedJson = JSON.stringify(CALIBRATED_ANALYSIS);
  const cases = [
    { name: 'split-json', parts: [{ text: calibratedJson.slice(0, 150) }, { text: calibratedJson.slice(150) }] },
    { name: 'thought-before-json', parts: [{ thought: true, text: '仅用于内部推理，不是最终结果' }, { text: calibratedJson }] },
    { name: 'truncated-json', parts: [{ text: calibratedJson }], finishReason: 'MAX_TOKENS', error: /输出未完整结束/ },
    { name: 'blocked-json', parts: [{ text: calibratedJson }], finishReason: 'SAFETY', error: /安全限制/ },
    { name: 'thought-only', parts: [{ thought: true, text: calibratedJson }], error: /未返回可用文字/ },
    { name: 'missing-evidence', parts: [{ text: JSON.stringify(ANALYSIS) }], error: /缺少来源证据/ },
    { name: 'secret-echo', parts: [{ text: JSON.stringify({ ...CALIBRATED_ANALYSIS, bodyPose: process.env.APIYI_API_KEY }) }], error: /返回格式无效/ },
    { name: 'invalid-coordinate', parts: [{ text: JSON.stringify({ ...CALIBRATED_ANALYSIS, points: { ...ANALYSIS.points, head: { x: 2, y: 0 } } }) }], error: /坐标 head 越界/ },
    { name: 'forbidden-evidence', parts: [{ text: JSON.stringify({ ...CALIBRATED_ANALYSIS, calibration: { ...CALIBRATED_ANALYSIS.calibration, originalEvidence: '红色外套' } }) }], error: /包含禁止/ },
  ];
  for (const sample of cases) {
    process.env.POSE_ANALYSIS_MODEL = `gemini-regression-${sample.name}`;
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      return Response.json({ candidates: [
        { finishReason: sample.finishReason ?? 'STOP', content: { parts: sample.parts } },
        { content: { parts: [{ text: JSON.stringify({ ...CALIBRATED_ANALYSIS, bodyPose: '另一个候选不应被拼接' }) }] } },
      ] });
    };
    try {
      if (sample.error) {
        await assert.rejects(analyzePoseReference(IMAGE, { calibration }), sample.error);
      } else {
        const result = await analyzePoseReference(IMAGE, { calibration });
        assert.match(result.prompt, /三图校准结果/);
        assert.ok(!result.prompt.includes('内部推理'));
        assert.equal((await analyzePoseReference(IMAGE, { calibration })).cacheHit, true);
      }
      assert.equal(attempts, 1, '解析失败不得自动再次调用付费模型');
    } catch (error) {
      responseFailures.push(`${sample.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    assert.equal(calibratedParts[0].text.split('\n').filter((line: string) => line.startsWith('{"points"')).length, 1, '三图模式只能有一份完整输出示例');
    const schema = calibrationBodies[0].generationConfig.responseSchema;
    assert.ok(schema, 'Gemini 必须发送结构化响应 schema，而不仅是 JSON MIME');
    assert.ok(schema.required.includes('calibration'));
    assert.equal(schema.properties.points.required.length, 16);
    assert.equal(schema.properties.points.properties.head.nullable, true);
    assert.equal(schema.properties.calibration.required.length, 5);
    assert.match(calibratedParts[7].text, /coco-wholebody-133/);
    assert.match(calibratedParts[7].text, /leftShoulder/);
  } catch (error) {
    responseFailures.push(`request-contract: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert.deepEqual(responseFailures, [], '三图校准响应与请求契约回归');
  console.log("姿势分析测试通过：Gemini/DeepSeek、Base64、账户缓存隔离、密钥脱敏与结构验证");
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(temp, { recursive: true, force: true });
}
