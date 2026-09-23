# 解除 Pro 禁用与 OTHER 工程化自动处理方案

> 依据 `关于 Pro 输入图被拦（blockReason=OTHER）的处理建议.md` 的「二、代码（工程化自动处理）」制定。
> 状态：待评审 / 待实现。评审决策见「决策记录」。

## 1. 背景与目标

- apiyi 供应商已确认：多图模式撞 `OTHER` 是原厂在生成前对输入图做的像素检查，拦的是**人物板原图的像素**，与提示词、图片数量、请求结构无关；把图重新保存（重编码）一次后 Pro 上 2/2 出图。
- 目标：
  1. 解除 `gemini-3-pro-image` 在多图编辑换装中的禁用。
  2. 用工程化手段自动规避 `OTHER` 拦截，替代人工"另存一次"。

## 2. 决策记录（已确认）

| # | 决策点 | 结论 |
| --- | --- | --- |
| 1 | 预处理作用域 | **统一生效**：所有 Gemini 编辑参考图统一预处理，不单张针对 |
| 2 | OTHER 后的兜底 | **改为提示**：不自动切 Flash，仍失败时提示用户手动切换模型或重导参考图 |
| 3 | 透明 PNG | **不允许 flatten 白底**：保留 alpha 语义，透明图走 PNG 分支 |
| 4 | 排查信息落库 | **是**：responseId + 每图 hash/尺寸写入执行元数据 |

## 3. 现状盘点

### 3.1 Pro 禁用点（`51065ba7` 引入，共 3 处）

| 位置 | 现状 | 解除方式 |
| --- | --- | --- |
| `server/engine/dag.ts:304-305` | `if (modelId !== "gemini-3.1-flash-image") throw new DagError("多图编辑换装已改用 Gemini 3.1 Flash Image…")` | 删除该限制 |
| `src/components/nodes/SceneStabilizeControls.tsx` 模型选择器 | `.filter(id => data.sceneInputMode !== 'multi-reference-edit' \|\| id === 'gemini-3.1-flash-image')` | 移除 filter |
| `src/components/nodes/SceneStabilizeControls.tsx` 文案 | "多图编辑换装固定使用 Gemini 3.1 Flash Image…" | 改为 Pro / Flash 可选说明 |

> 说明：`dag.ts:258`、`runner.ts:1712` 仍保留 `multiImageEdit && modelId === "gemini-3-pro-image-preview"` 时放宽到 `MULTI_IMAGE_TRY_ON_MAX_SOURCES(20)` 的逻辑，Pro 多图能力在数据层早已建模，只需解除上游一刀切。

### 3.2 已具备、可复用的能力

- 图片归一化 pipeline：`server/lib/uploadImageNormalization.ts` 已实现 `rotate() → toColourspace("srgb") → resize → jpeg({ mozjpeg })`，且有 `hasMeaningfulAlpha` 透明检测与 PNG/JPEG 双分支。
- 返回分类：`server/providers/apiyi.ts:processGeminiResponse` 已解析 `promptFeedback.blockReason`（OTHER/SAFETY/PROHIBITED_CONTENT）与 `finishReason`（OTHER/SAFETY/NO_IMAGE/IMAGE_SAFETY…），映射到 `category`。
- 排查信息（半成品）：`apiyi.ts:edit` 已记录 `x-request-id` + 每图 `sha256/width/height/bytes` + 诊断，但只 `console.info`，未落库、未随结果返回。
- 自动重试框架：`server/engine/runQueue.ts:isRetryableProviderError` + `scheduleAutomaticRetry`（现仅 image_safety / 429 / 503）。

### 3.3 缺口（相对文档二）

1. `apiyi.ts:geminiInlineData` 只在 `buffer > 1.5MB` 才重编码，**小图原样返回**（不转 sRGB、不重编码、不去元数据）。这是 OTHER 根因的工程化落点。
2. OTHER（`content_refused`）不在自动重试范围，直接失败。
3. NO_IMAGE 无"追加提示词重发"。
4. `providerRequestId` 未随 `ImageGenResult` 返回、未落库。

## 4. 方案设计

### 4.1 解除 Pro 禁用

改动 3.1 的三处，恢复多图模式可选 Pro。此步不含行为风险（仅放开入口），可先行。

### 4.2 发送前统一预处理（命中 OTHER 根因）

**位置**：`server/providers/apiyi.ts:geminiInlineData`。

**改动**：去掉"小图原样返回"分支，对所有 Gemini 编辑参考图（不分大小、不分来源）统一重编码：

- 无 alpha：`rotate() → toColorspace("srgb") → resize({ width:2048, height:2048, fit:"inside", withoutEnlargement:true }) → jpeg({ quality:92, mozjpeg:true })`
- 有 alpha：`rotate() → toColorspace("srgb") → resize(同上) → png()`（保留透明，不 flatten）

保留现有体积兜底循环（超阈值再逐级降长边 / 降质量）。

**为何命中根因**：生成结果（`source_type === "generation"`）在 `resolveImageRefs` 中不归一化、原样进入多图拼接；上传图虽经 `normalizeProviderImageDataUrl` 归一化，但长边上限是 4096 而非 2048，且拼接后又输出 1024 cell 的 PNG。统一在"发送前最后一步"强制重编码为 sRGB + JPEG q92 + 去元数据，等价于供应商建议的"另存一次"。

**决策落实**：透明图走 PNG 分支，不做 flatten（决策 3）；对所有 Gemini 编辑参考图生效（决策 1）。

### 4.3 按返回类型分别处理

前置：`ProviderError` 增加可选 `blockReason?` / `finishReason?` 字段，由 `parseGeminiImages` 从诊断透传，供上层精准判断（当前埋在 `diagnostic` JSON 字符串里）。

**4.3.1 OTHER —— 换编码参数重发 1 次 → 仍失败提示**

- 插入点：`runner.ts` 多图模式（`multiImageEdit`）生图调用 catch 分支（约 2106–2165）。
- 命中 `category === "content_refused" && blockReason === "OTHER"`：
  1. 用降级编码参数（`quality: 88` + `longEdge: 2048 * 0.99`）重发 1 次；
  2. 仍 OTHER → **不自动切模型**，抛出一个明确提示，引导用户手动把模型切到 `gemini-3.1-flash-image`、或重新导出被拦的参考图（决策 2）。
- 参数传递：在 `ImageGenRequest` 增加可选 `referenceEncoding?: { quality?: number; longEdge?: number }`，由 `geminiInlineData` 消费。

**4.3.2 SAFETY / PROHIBITED_CONTENT —— 不重试**

现状已正确（`content_refused` 但非 OTHER，直接失败），无需改动。

**4.3.3 NO_IMAGE —— 追加提示词重发 1 次**

- 命中 `finishReason === "NO_IMAGE"`：提示词末尾追加「只输出最终图片，不要输出文字」后重发 1 次，仍失败按原错误报出。

### 4.4 排查信息落库

- `apiyi.ts:edit` 的 Gemini 分支把 `response.headers.get("x-request-id")` 写入返回结果的 `providerRequestId`（现未写入）。
- `runner.ts` 把 `providerRequestId` + 每图 `sha256/width/height/bytes` 装入 `executionMeta`（沿用现有 `executionMeta` 通道）。
- `runQueue` 持久化到 `generation_run_steps.execution_meta_json`（该字段已支持）。

## 5. 实施顺序与验收

实施顺序（由小到大、可独立验证）：

1. 解除 Pro 禁用（4.1）。
2. 统一预处理（4.2）—— 命中根因。
3. 返回类型透传（4.3 前置：`ProviderError` 增加 blockReason/finishReason）。
4. OTHER 换参重发 + 提示（4.3.1）。
5. NO_IMAGE 追加提示词重发（4.3.3）。
6. 排查信息落库（4.4）。

验收：

- 单测：净化输出为 sRGB + JPEG（无 alpha）/ PNG（有 alpha）+ 长边 ≤2048 + 无元数据；小图同样被重编码。
- 单测：OTHER → 换参重发 1 次 → 仍失败返回"手动切 Flash / 重导参考图"提示（不自动切模型）。
- 单测：NO_IMAGE → 追加固定提示词重发。
- 单测：`providerRequestId` + 图片 hash/尺寸进入 `execution_meta_json`。
- `tsc`、`npm run build`、相关测试、`git diff --check`、CodeGraph sync/affected。
- 真实 Pro 生图验证需单独授权付费。

## 6. 风险与回滚

- 统一预处理会改变所有 Gemini 编辑参考图的编码（体积、色彩、透明语义），可能影响既有生成效果；透明图走 PNG 分支规避 flatten 回归。
- OTHER 换参重发会额外产生 1 次付费调用；已通过"仅 1 次、仍失败即提示"限制。
- 回滚：本方案各步骤独立提交，可逐 commit 回退；禁用解除前先做一致性备份（PostgreSQL + `/app/data`）。
