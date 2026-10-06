import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { DWPoseKeypointV1, DWPosePoseV1 } from "../src/types/poseReference";

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
const calibrationKeypoints = Array.from({ length: 133 }, () => null as DWPoseKeypointV1 | null);
for (const [index, x, y] of [
  [5, 0.38, 0.23], [6, 0.62, 0.23], [7, 0.3, 0.38], [8, 0.7, 0.4],
  [9, 0.42, 0.48], [10, 0.78, 0.52], [11, 0.44, 0.53], [12, 0.6, 0.54],
  [13, 0.43, 0.72], [14, 0.66, 0.7], [15, 0.4, 0.93], [16, 0.72, 0.9],
] as const) calibrationKeypoints[index] = { x, y, confidence: 0.9 };
const CALIBRATION_POSE: DWPosePoseV1 = {
  schemaVersion: 1,
  canvas: { width: 300, height: 500 },
  people: [{ keypoints: calibrationKeypoints }],
};
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
    depthEvidence: "深度图显示画面左膝比画面右膝更靠近镜头",
    skeletonEvidence: "DWPose显示画面左膝x小于画面右膝，点位置信度较高",
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
  const { analyzePoseReference, calibratedPoseSupplement, optimizeCalibratedPrompt, validateEditedPosePrompt, DEEPSEEK_POSE_MODEL } = await import("../server/lib/poseAnalysis");
  const optimized = optimizeCalibratedPrompt({ ...CALIBRATED_ANALYSIS,
    handPose: '画面右肘弯曲，画面右腕靠近髋部，手指状态无法判断',
    gazeDirection: '无法识别',
    facialExpression: '嘴唇闭合，嘴角方向无法判断',
  }, CALIBRATION_POSE);
  assert.match(optimized, /^三图校准补充（仅补充图1不可见关系）/);
  assert.match(optimized, /嘴唇闭合/);
  assert.doesNotMatch(optimized, /整体姿态|躯干姿态|下肢姿态|画面右肘|无法判断|无法识别|原图证据|跨图冲突|视线方向/);
  assert.match(CALIBRATED_ANALYSIS.calibration.unknowns, /无法判断/, '优化不能修改原始校准证据');
  const crossingConflict = calibratedPoseSupplement({
    ...CALIBRATED_ANALYSIS,
    legPose: '画面左腿越过中线并交叉于画面右腿前侧',
  }, CALIBRATION_POSE);
  assert.match(crossingConflict.notes.join('；'), /交叉/, '非交叉骨骼的文字交叉结论只作为提示');
  assert.match(crossingConflict.prompt, /^三图校准补充/, '交叉提示不阻断优化稿');
  const lowConfidencePose: DWPosePoseV1 = structuredClone(CALIBRATION_POSE);
  for (const index of [11, 12, 13, 14, 15, 16]) lowConfidencePose.people[0].keypoints[index] = null;
  const noPointSupport = calibratedPoseSupplement({
    ...CALIBRATED_ANALYSIS,
    legPose: '画面左腿与画面右腿不交叉',
  }, lowConfidencePose);
  assert.match(noPointSupport.notes.join('；'), /交叉/, 'DWPose腿部点缺失时交叉结论只作为提示，不阻断优化稿');
  const weightMismatch = calibratedPoseSupplement({
    ...CALIBRATED_ANALYSIS,
    bodyPose: '人物站立，重心落在画面右腿',
  }, CALIBRATION_POSE);
  assert.match(weightMismatch.notes.join('；'), /承重|重心/, '与原图证据冲突的承重结论只作为提示');
  assert.match(weightMismatch.prompt, /^三图校准补充/, '承重提示不阻断优化稿');
  assert.throws(() => optimizeCalibratedPrompt({
    ...CALIBRATED_ANALYSIS,
    handPose: '画面右手贴在身体侧面',
  }, CALIBRATION_POSE), /手部接触/, '手部接触必须得到原图证据支持');
  const frontMismatch = calibratedPoseSupplement({
    ...CALIBRATED_ANALYSIS,
    legPose: '画面右膝位于画面左膝前侧',
  }, CALIBRATION_POSE);
  assert.match(frontMismatch.notes.join('；'), /前后关系|深度图/, '与深度图证据不一致的前后关系只作为提示');
  assert.match(frontMismatch.prompt, /^三图校准补充/, '前后关系提示不阻断优化稿');
  assert.throws(() => optimizeCalibratedPrompt({
    ...CALIBRATED_ANALYSIS,
    handPose: '右手贴在身体侧面',
    calibration: { ...CALIBRATED_ANALYSIS.calibration, originalEvidence: '原图可见右手贴在身体侧面' },
  }, CALIBRATION_POSE), /画面左|画面右/, '校准输出必须统一使用画面坐标');
  const outsideEmitted = calibratedPoseSupplement({
    ...CALIBRATED_ANALYSIS,
    torsoPose: '躯干向右侧倾斜',
    headPose: '头部略向右倾',
  }, CALIBRATION_POSE);
  assert.match(outsideEmitted.prompt, /^三图校准补充/, '未进入优化稿的字段使用相对左右时不阻断优化稿');
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
  assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).schemaVersion, 6);
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
    assert.deepEqual(request.messages[0].content.find((part: { type: string }) => part.type === 'image_url'), { type: 'image_url', image_url: { url: IMAGE, detail: 'original' } });
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
  {
  const baseline = {
    overall: { observation: '站立，重心落在画面左腿', plane: '躯干略向画面左侧倾斜', depth: '' },
    head: { observation: '头部略低', plane: '头部向画面右侧倾斜', depth: '' },
    gaze: { observation: '视线朝画面右侧', plane: '', depth: '' },
    face: { observation: '嘴角轻微上扬', plane: '', depth: '' },
    upperLimbs: { observation: '双手交握', plane: '画面左手位于腰部下方', depth: '画面左手位于躯干后方' },
    shoulders: { observation: '肩部放松', plane: '画面右侧肩部略低', depth: '' },
    waist: { observation: '腰部轻微弯曲', plane: '', depth: '' },
    hips: { observation: '胯部轻微转动', plane: '', depth: '' },
    lowerLimbs: { observation: '膝部自然弯曲', plane: '双腿交叉', depth: '画面右腿位于画面左腿后方' },
  };
  const depthPatch = { depth: { overall: null, head: null, upperLimbs: '画面左手位于躯干前方', shoulders: null, waist: null, hips: null, lowerLimbs: null } };
  const planePatch = { plane: { head: '头部向画面左侧倾斜', upperLimbs: '画面左手位于腰部上方', lowerLimbs: '画面右脚越过画面左脚，双腿交叉' } };
  const stageValue = (instruction: string) => instruction.startsWith('第一步') ? baseline : instruction.startsWith('第二步') ? depthPatch : planePatch;
  let calibrationCalls = 0;
  const calibrationBodies: Array<Record<string, any>> = [];
  globalThis.fetch = async (_input, init) => {
    calibrationCalls++;
    const request = JSON.parse(String(init?.body));
    calibrationBodies.push(request);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(stageValue(request.contents[0].parts[0].text)) }] } }] });
  };
  const calibration = { depthImageDataUrl: ALT_IMAGE, skeletonImageDataUrl: IMAGE, pose: CALIBRATION_POSE };
  const calibrated = await analyzePoseReference(IMAGE, { calibration });
  assert.equal(calibrationCalls, 3, '三图校准必须串行执行三次请求');
  assert.equal(calibrated.providerRequests, 3);
  assert.equal(calibrated.calibrationMode, 'three-view');
  assert.equal(calibrated.optimizedPromptVerified, true);
  const parts = calibrationBodies.map(body => body.contents[0].parts);
  assert.deepEqual(parts.map(p => p.filter((v: any) => v.inlineData).length), [1, 1, 1]);
  assert.deepEqual(parts.map(p => p.find((part: any) => part.inlineData).inlineData.data), [IMAGE, ALT_IMAGE, IMAGE].map(image => image.split(',')[1]));
  assert.match(parts[0][0].text, /第一步.*原始姿势图/);
  assert.match(parts[1][0].text, /近亮远暗/);
  assert.ok(parts[1][0].text.includes(JSON.stringify(baseline)), '深度请求继承完整基线');
  const afterDepth = structuredClone(baseline);
  afterDepth.upperLimbs.depth = depthPatch.depth.upperLimbs;
  assert.ok(parts[2][0].text.includes(JSON.stringify(afterDepth)), 'DWPose请求继承深度修正稿而非原始稿');
  assert.match(parts[2][0].text, /coco-wholebody-133/);
  assert.ok(parts[2][0].text.includes(JSON.stringify(CALIBRATION_POSE.people[0].keypoints[0])));
  assert.deepEqual(calibrationBodies[0].generationConfig.responseSchema.required, Object.keys(baseline));
  assert.deepEqual(calibrationBodies[1].generationConfig.responseSchema.required, ['depth']);
  assert.deepEqual(calibrationBodies[2].generationConfig.responseSchema.properties.plane.required, ['head', 'upperLimbs', 'lowerLimbs']);
  assert.match(calibrated.calibrationStages?.original ?? '', /左手位于躯干后方/);
  assert.match(calibrated.calibrationStages?.depth ?? '', /左手位于腰部下方；画面左手位于躯干前方/);
  assert.match(calibrated.calibrationStages?.skeleton ?? '', /左手位于腰部上方；画面左手位于躯干前方/);
  const optimized = calibrated.optimizedPrompt ?? '';
  assert.equal(optimized.split('\n').length, 10, '优化稿保留九类信息');
  assert.match(optimized, /下肢：膝部自然弯曲；画面右脚越过画面左脚，双腿交叉；画面右腿位于画面左腿后方/);
  for (const observation of ['重心落在画面左腿', '头部略低', '视线朝画面右侧', '嘴角轻微上扬', '双手交握', '肩部放松', '腰部轻微弯曲', '胯部轻微转动']) assert.ok(optimized.includes(observation));
  assert.match(optimized, /肩部：肩部放松；画面右侧肩部略低/, '第三步不改肩部平面位置');
  const edited = optimized.replace('三图校准姿势', '三图校准姿势（用户编辑）').replace('视线朝画面右侧', '视线朝画面左侧');
  assert.deepEqual(await validateEditedPosePrompt(IMAGE, edited, { calibration }), { verified: true });
  assert.equal((await validateEditedPosePrompt(IMAGE, edited + '\n背景：白色房间', { calibration })).verified, false);
  assert.equal((await validateEditedPosePrompt(IMAGE, edited.replace('肩部放松', '红色外套'), { calibration })).verified, false);
  assert.equal((await validateEditedPosePrompt(IMAGE, edited.replace('视线朝画面左侧', '无法判断'), { calibration })).verified, false);
  assert.equal(calibrationCalls, 3, '手动保存校验不能调用模型');
  const cached = await analyzePoseReference(IMAGE, { calibration });
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.providerRequests, 0);
  assert.deepEqual(cached.calibrationStages, calibrated.calibrationStages);
  await analyzePoseReference(IMAGE, { calibration: { ...calibration, depthImageDataUrl: IMAGE } });
  await analyzePoseReference(IMAGE, { calibration: { ...calibration, skeletonImageDataUrl: ALT_IMAGE } });
  await analyzePoseReference(ALT_IMAGE, { calibration });
  assert.equal(calibrationCalls, 12, '任一图片变化都必须使校准缓存失效');
  let deepseekCalls = 0;
  globalThis.fetch = async (_input, init) => {
    deepseekCalls++;
    const request = JSON.parse(String(init?.body));
    assert.equal(request.messages[0].content.filter((part: { type: string }) => part.type === 'image_url').length, 1);
    return Response.json({ choices: [{ message: { content: [
      { type: 'reasoning', text: '内部推理不参与解析' },
      { type: 'text', text: `\`\`\`json\n${JSON.stringify(stageValue(request.messages[0].content[0].text))}\n\`\`\`` },
    ] } }] });
  };
  const deepseekCalibration = await analyzePoseReference(IMAGE, { ...deepseekOptions, ownerId: 'calibrated-owner', calibration });
  assert.equal(deepseekCalls, 3);
  assert.equal(deepseekCalibration.optimizedPrompt, optimized);
  assert.deepEqual(deepseekCalibration.calibrationStages, calibrated.calibrationStages);
  const baselineJson = JSON.stringify(baseline);
  const implicitDirectionsJson = baselineJson.replaceAll('画面左', '左').replaceAll('画面右', '右');
  const cases = [
    { name: 'split-json', parts: [{ text: baselineJson.slice(0, 150) }, { text: baselineJson.slice(150) }] },
    { name: 'implicit-screen-directions', parts: [{ text: implicitDirectionsJson }] },
    { name: 'thought-before-json', parts: [{ thought: true, text: '内部推理' }, { text: baselineJson }] },
    { name: 'truncated-json', parts: [{ text: baselineJson }], finishReason: 'MAX_TOKENS', error: /第一步.*输出未完整结束/ },
    { name: 'blocked-json', parts: [{ text: baselineJson }], finishReason: 'SAFETY', error: /第一步.*安全限制/ },
    { name: 'thought-only', parts: [{ thought: true, text: baselineJson }], error: /第一步.*未返回可用文字/ },
    { name: 'wrong-schema', parts: [{ text: JSON.stringify(ANALYSIS) }], error: /第一步.*字段/ },
    { name: 'secret-echo', parts: [{ text: baselineJson.replace('站立', process.env.APIYI_API_KEY!) }], error: /第一步.*格式无效/ },
    { name: 'forbidden-content', parts: [{ text: baselineJson.replace('站立', '红色外套') }], error: /第一步.*非姿势内容/ },
  ];
  for (const sample of cases) {
    process.env.POSE_ANALYSIS_MODEL = `gemini-regression-${sample.name}`;
    let attempts = 0;
    globalThis.fetch = async (_input, init) => {
      attempts++;
      const instruction = JSON.parse(String(init?.body)).contents[0].parts[0].text;
      return Response.json({ candidates: [
        { finishReason: instruction.startsWith('第一步') ? sample.finishReason ?? 'STOP' : 'STOP', content: { parts: instruction.startsWith('第一步') ? sample.parts : [{ text: JSON.stringify(stageValue(instruction)) }] } },
        { content: { parts: [{ text: '其他候选不得参与解析' }] } },
      ] });
    };
    if (sample.error) await assert.rejects(analyzePoseReference(IMAGE, { calibration }), sample.error);
    else {
      const result = await analyzePoseReference(IMAGE, { calibration });
      assert.equal(result.optimizedPrompt, optimized);
      assert.equal((await analyzePoseReference(IMAGE, { calibration })).cacheHit, true);
    }
    assert.equal(attempts, sample.error ? 1 : 3, '格式失败停止后续步骤，不自动付费重试');
  }
  for (const stage of ['第二步', '第三步']) {
    process.env.POSE_ANALYSIS_MODEL = `gemini-scope-${stage === '第二步' ? 'depth' : 'skeleton'}`;
    let attempts = 0;
    globalThis.fetch = async (_input, init) => {
      attempts++;
      const instruction = JSON.parse(String(init?.body)).contents[0].parts[0].text;
      const value = stageValue(instruction);
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(instruction.startsWith(stage) ? { ...value, observation: '越权覆盖' } : value) }] } }] });
    };
    await assert.rejects(analyzePoseReference(IMAGE, { calibration }), /越权字段/);
    assert.equal(attempts, stage === '第二步' ? 2 : 3);
  }
  globalThis.fetch = async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] });
  await assert.rejects(analyzePoseReference(IMAGE, { ...deepseekOptions, ownerId: 'truncated-calibrated-owner', calibration }), /第一步.*DeepSeek 输出未完整结束/);
  globalThis.fetch = async () => new Response('invalid key', { status: 401 });
  await assert.rejects(analyzePoseReference(IMAGE, { ...deepseekOptions, ownerId: 'unauthorized-calibrated-owner', calibration }),
    (error: unknown) => error instanceof Error && 'providerId' in error && error.providerId === DEEPSEEK_POSE_MODEL && /第一步.*API Key/.test(error.message),
    '串行校准必须保留脱敏后的BYOK提供商错误');
  globalThis.fetch = async () => { throw new Error(`transport failed ${deepseekOptions.apiKey}`); };
  await assert.rejects(analyzePoseReference(IMAGE, { ...deepseekOptions, ownerId: 'interrupted-calibrated-owner', calibration }),
    (error: unknown) => error instanceof Error && 'category' in error && error.category === 'outcome_unknown' && !error.message.includes(deepseekOptions.apiKey),
    '串行校准必须保留请求结果未知分类且不得泄露密钥');
  }
  console.log("姿势分析测试通过：Gemini/DeepSeek、Base64、账户缓存隔离、密钥脱敏与结构验证");
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(temp, { recursive: true, force: true });
}
