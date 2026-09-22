# 侧栏对话修改 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 按 PRD C01–C41 / A01–A65 交付桌面侧栏对话式图片修改，不影响现有节点工作流。
**Architecture:** 对话、轮次、来源和有效要求存入 PostgreSQL，复用既有文件、生成队列、SSE 与全局结果。前端对话领域状态与画布文档分离，面板开关仅为本地 UI 状态。
**Tech Stack:** 现有 React 19、TypeScript、Zustand、React Flow、本地 shadcn、Express、PostgreSQL 18、Playwright；Node >=22.20.0。

---

日期：2026-09-21。状态：P0–P7 已实施；P8 已完成本地技术门禁、专项回归、构建、E2E 与 CodeGraph 收口；A01–A65 尚未逐条完成证据审计，真实 Provider、`gate:codex` 与生产发布仍不在本批验证范围。
上述技能执行提示保留为实施交接记录；P0 方案已获确认，当前实现按批准范围推进，不自动提交或部署。
工作根目录：`/Users/neihe/NEIHE-AI`。下文代码路径均相对此根目录；实现状态以实际工作树和验收记录为准。
依据：[PRD](/Users/neihe/NEIHE-AI/docs/侧栏对话修改PRD.md)、[当前项目规则](/Users/neihe/NEIHE-AI/AGENTS.md)、[归属决策](/Users/neihe/NEIHE-AI/docs/adr/0002-image-conversation-ownership.md)。
配套：[周期估算](/Users/neihe/NEIHE-AI/docs/plans/2026-09-21-chat-edit-schedule.md)、[TODO](/Users/neihe/NEIHE-AI/docs/plans/2026-09-21-chat-edit-todo.md)。

## 1. 边界与实施前提

- 本计划不扩展为通用聊天、历史会话列表、分支树、移动端或历史删除功能。
- 不修改 PRD 已确认规则；PRD 页首仍写“默认参数待评审”，应以 C01–C41 的具体确认优先，页首状态在文档定稿时统一。
- 当前工作区存在其他未提交代码/测试与设计师文档。不得覆盖、批量暂存或借本任务提交它们。开发前确定批准基线；专用 worktree 不会自动含这些未提交 PRD，需按批准文件清单带入，不能只从 HEAD 开工。
- P0 先解决方案与 UI 稿；已确认的产品规则不重新逐条问。跨范围选择才请求用户决策。
- 普通 UI 使用本地 shadcn；无合适组件先补项目 primitive，不用覆盖式 Sheet 违背占位布局。
- 保存、上传、蒙版、生成等异步必须绑定发起文档三元组。侧栏开关不进入 Store 持久化或 DocumentSnapshot。
- 新路由保留 requireAuth / requirePasswordChanged 和 owner/admin 边界，引用验证、项目回收、文件防遍历不退化。

## 2. 当前实现证据及回归风险

本轮核对了实际源码和 package.json；P0–P7 已完成实现与专项验证，P8 的隔离 PostgreSQL 全量测试、`check`、`build`、`lint` 和对话 Dock/多选起点/持久化历史/结果操作/来源隔离/模式草稿三档 E2E 均已通过。最新增量补齐了共享服务端参数能力校验、按模式模型列表、多选图片显式起点取消保护、历史轮次输入/蒙版快照与来源轮次展示、折叠参数、资产预览恢复，以及 `/resolve` 的完整历史 hydration；新增 E2E 还验证了真实持久化轮次关闭侧栏后再次恢复、已完成结果继续修改的草稿冲突取消/确认、显式加入画布时的原图保留与稳定来源元数据、同项目复制/跨项目粘贴的对话来源隔离、三模式未提交草稿隔离与“开始新修改”独立会话，以及空白指令/有序多图/参数请求/未保存蒙版的提交契约；同时修复了 1024px 结果操作栏按钮被底部编辑器遮挡、首次打开 Dock 时异步建立会话覆盖未提交草稿，以及浏览器直接调用 `crypto.randomUUID` 导致发送失败的可操作性问题。工作区仍保留与本功能无关的其他 dirty 变更，但未阻断本轮门禁；详见验收记录。

| 接入点 | 已核实事实 | 计划影响 |
| --- | --- | --- |
| WorkbenchShell / workbenchState | 当前 reducer 有 rightDockOpen；CodeGraph 调用链到 Workspace/App | 扩充互斥面板类型，但保持开关本地化和画布实例 |
| generate.ts / runQueue.ts | 已有事务内 enqueueGenerationRunInTransaction；直接生成将 batchSize 限制到 1–8 | 新契约必须先拒绝超限，不借旧逻辑静默截断；多意图不能重复同一 prompt |
| runQueue 入队函数 | CodeGraph 涉及 generate、runPlan、poseReferences、server/index 及姿势 API 测试 | 共享队列最小扩展；这些流程全部纳入回归 |
| generationRecords.ts | 输出完成逻辑包含按 run 删除再写入输出记录 | 不可用重试覆盖原 run 的成功结果；新增尝试关联稳定意图，复核计费和输出 ID |
| database.ts | PostgreSQL 18 + transaction，已有独立业务迁移入口 | 新增增量迁移和引用保护，不引入 SQLite 运行态 |
| apiyi.ts | explicit modelSelection 控制明确模型路由 | 侧栏必须端到端传递，不更改其他节点隐式默认 |
| test-with-postgres.mjs | 固定执行 test:suite；没有单文件参数转发 | 新服务端测试注册 test:suite，经 npm run test 执行 |
| playwright.config.ts | 已有 desktop-1024/1280/1440，必须隔离 runner | 新 spec 命名 *.workbench.spec.ts，使用 npm run test:e2e |

CodeGraph status/sync 报告最新，但 explore 曾提示 runQueue 源码切片与索引时间不符，因此以直接读取源码补查，不能声称图覆盖完整。开发每批修改前重新 impact，交付前 sync/affected。

## 3. P0 必须关闭的决策项

1. D01：对话身份不能只使用 nodeId 或图片内容 hash；定义起始来源、具体结果、同项目副本与跨项目清除关联的策略。
2. D07：确定受支持的文本解析能力、结构化校验、超时及成本。现有图像分析模块只是复用候选，不证明已有通用多意图规划器；不能只用正则“数张数”交付。
3. D06：三档 UI 稿确认具体侧栏宽度和折行、参数折叠区、Enter 换行/Cmd-Ctrl Enter 发送；PRD 这些仍标建议。
4. 明确无画布节点承载的旧对话如何重新打开：PRD 同时要求无会话列表、原对话可恢复。建议评估复用既有全局结果/记录入口的来源定位；有实质交互改变时交用户确认，不能暗加会话列表。
5. 确定“加入画布”的承载节点类型；局部重绘 1 底图 + 最多 6 参考图为当前复用建议，不当作用户另行确认的额度。
6. 澄清阶段与结果未知是否占用活动锁、刷新后的 pending 状态恢复、核对终态的解除条件必须有状态表。不得把未知当作失败直接补发。
7. 迁移只增量；生产启用/回退走批准流程。关闭入口不删除历史、不停用已有任务恢复。

## 4. 执行顺序与任务

依赖：P0 → P1 → P2 → P3 → P4；P0/P1 → P5 → P6；P4/P5/P6 → P7 → P8。
每个任务内部按下列小步骤拆成可审查补丁；每次只实现一个测试场景，不把“整个模块”当一次修改。
通用节奏：写失败测试 → 运行并确认预期失败（不是环境失败）→ 最小实现 → 重跑通过 → 看 diff → 记录证据。
提交仅在用户批准后按批次执行，不机械运行技能示例中的 git commit。

### P0：技术契约与 UI 验收稿

依赖：无。估算：2–3 工程人日。

**文件：**

- 新增 docs/plans/2026-09-21-chat-edit-technical-design.md
- 新增 docs/plans/2026-09-21-chat-edit-ui-spec.md

**步骤：**

1. 绘制对话、轮次、具体结果、执行尝试的关联和状态转换，列出 API 请求/响应及错误码。
2. 确定来源标识、原子提交/并发锁、澄清持久化、未知结果恢复及旧对话重新打开入口。
3. 给出 1024/1280/1440 的布局、宽度、折行、空/多选/失败态和键盘行为稿。
4. 确认技术方案和具体 UI 稿；记录文本解析模型接入、成本和能力证据；未决项不得伪装成已确认。

**验证：** 不写功能代码；审阅契约和三档布局稿，确认 D01/D06/D07 与下列决策清单。。实现前相关新用例应按目标行为失败，实现后全部通过；已有测试不得回退。

### P1：共享契约、校验与上下文纯逻辑

依赖：P0。估算：2–3 工程人日。

**文件：**

- 新增 src/types/imageConversation.ts
- 新增 src/lib/imageConversationRules.ts
- 新增 tests/image-conversation-rules.test.ts

**步骤：**

1. 编写单图 1 张、融合 2–8、输出整数 1–8、无数量控件契约的失败测试。
2. 编写来源链继承、明确覆盖、相对动作不重复、模式隔离及模型不兼容的失败测试。
3. 实现最小类型和纯校验，持久保持要求与本轮相对动作分开，按具体结果而非仅轮次选上下文。
4. 运行纯测试，确保 3/5/6/7 张不取整、超限不截断；列出请求快照不可变约束。

**验证：** pnpm exec tsx tests/image-conversation-rules.test.ts。实现前相关新用例应按目标行为失败，实现后全部通过；已有测试不得回退。

### P2：PostgreSQL 对话存储、身份与授权

依赖：P1。估算：3–4 工程人日。

**文件：**

- 新增 server/lib/imageConversationMigration.ts
- 新增 server/lib/imageConversationStore.ts
- 新增 server/routes/imageConversations.ts
- 修改 server/lib/database.ts、server/index.ts
- 新增 tests/image-conversation-storage.test.ts、tests/image-conversation-api.test.ts
- 修改 package.json（注册新增测试）

**步骤：**

1. 先写迁移重复执行、历史快照、猜测标识越权、图片引用归属的失败测试。
2. 实现对话/轮次/意图/尝试及任务关联的增量迁移；不建立第二套文件、计费或生成任务存储。
3. 实现同项目复制共享来源、替换新图独立、跨项目不继承及开始新修改保留旧对话。
4. 测试项目删除/回收、资产引用保护、刷新恢复和跨账号 404；不增加删除对话或历史接口。

**验证：** npm run test（隔离 PostgreSQL；新增测试先注册 test:suite）。实现前相关新用例应按目标行为失败，实现后全部通过；已有测试不得回退。

### P3：自然语言意图解析、澄清与要求继承

依赖：P1、P2；P0 解析方案确认。估算：4–6 工程人日。

**文件：**

- 新增 server/lib/imageConversationPlanner.ts
- 新增 server/providers/imageConversationPlanner.ts（仅在 P0 确定需要适配器后）
- 新增 tests/image-conversation-planner.test.ts
- 修改 server/routes/imageConversations.ts

**步骤：**

1. 建立中文 fixture：默认 1、明确 5、三效果 3、数量不符澄清、授权补足、9 张拒绝、一图多项修改。
2. 注入 mock 解析器，测试结构化响应错误、超时、重复澄清回答与输入注入不能绕过数量/权限。
3. 实现结构化解析和服务端校验，保留原文、结果意图标签、来源结果与有效要求快照；不以关键词拆句替代完整需求。
4. 持久化已提交的澄清请求；明确才创建图片任务。选择旧结果只继承其来源链，失败重试不重新解析目标。

**验证：** pnpm exec tsx tests/image-conversation-planner.test.ts（纯逻辑及注入 mock）；持久澄清用 npm run test。实现前相关新用例应按目标行为失败，实现后全部通过；已有测试不得回退。

### P4：持久队列、多方案执行及失败项重试

依赖：P2、P3。估算：3–4 工程人日。

**文件：**

- 新增 server/engine/imageConversationExecution.ts
- 修改 server/engine/runQueue.ts、server/engine/runner.ts（仅必要扩展）
- 修改 server/lib/generationRecords.ts、server/routes/imageConversations.ts
- 新增 tests/image-conversation-queue.test.ts
- 复核 server/providers/apiyi.ts、server/providers/gptImage25.ts

**步骤：**

1. 先测事务回滚不遗留任务、双页并发只接收一轮、幂等冲突拒绝、提交响应丢失恢复。
2. 按独立意图执行而非串联图片；原子建立轮次与既有队列任务，稳定关联具体输出。
3. 保持 modelSelection 明确选择贯穿 provider、质量与分辨率独立；不改变其他节点默认路由。
4. 测试 worker 重启、事件重放、3 成功 2 失败只重试 2 项、未知结果核对、重复点击重试及全局记录不重复记账。

**验证：** npm run test；重点运行已注册的对话队列、run-queue、provider-contract、exact-generation、recent-results 测试。实现前相关新用例应按目标行为失败，实现后全部通过；已有测试不得回退。

### P5：前端状态与右侧对话壳

依赖：P1；P0 UI 稿确认；可与 P2–P4 并行。估算：3–4 工程人日。

**文件：**

- 新增 src/store/imageConversationStore.ts
- 新增 src/lib/imageConversationClient.ts
- 新增 src/components/conversation/ConversationPanel.tsx、ConversationComposer.tsx、ConversationHistory.tsx
- 修改 src/components/workbench/WorkbenchShell.tsx、workbenchState.ts
- 修改 src/types/workbench.ts、src/App.tsx
- 新增 tests/image-conversation-state.test.ts
- 新增 e2e/chat-edit.workbench.spec.ts

**步骤：**

1. 先写面板互斥、不持久化开关、三模式草稿独立、换底图确认取消、迟到回调隔离测试。
2. 实现本地开关及独立对话状态，不向 DocumentSnapshot 写入历史/运行态；所有异步携带 tabId/projectId/documentEpoch。
3. 使用本地 shadcn 组装入口、模式、历史和底部输入；实现空选、多选指定起点、模型参数校验。
4. 在三档窗口测占位几何、缩放和平移不变、固定输入与历史滚动、焦点/IME/减少动画；mock 下完整演示。

**验证：** pnpm exec tsx tests/image-conversation-state.test.ts；npm run test:e2e -- e2e/chat-edit.workbench.spec.ts。实现前相关新用例应按目标行为失败，实现后全部通过；已有测试不得回退。

### P6：四类图片输入与局部重绘

依赖：P5；服务端接口 P2。估算：2–3 工程人日。

**文件：**

- 新增 src/components/conversation/ConversationImageInputs.tsx
- 复用 src/components/AssetPickerOverlay.tsx、src/components/nodes/MaskEditor.tsx
- 必要修改 src/lib/maskUpload.ts、src/lib/maskRedraw.ts
- 复核 server/lib/maskProcessing.ts
- 新增 tests/image-conversation-inputs.test.ts
- 扩展 e2e/chat-edit.workbench.spec.ts

**步骤：**

1. 先写有序引用、隐藏模式图不泄漏、图片归一化及换图旧蒙版失效测试。
2. 接通画布、本地、素材库、当前历史，区分新修改与参考图，引用必须来自有权限来源。
3. 复用蒙版编辑/上传/处理，校验 alpha PNG、尺寸一致、小于 4 MiB 与第 1 张对应，不退化既有区域合成。
4. 验证上传失败、切项目/替换文档时旧上传和蒙版响应不回写；局部重绘仅参考图可选，蒙版必需。

**验证：** pnpm exec tsx tests/image-conversation-inputs.test.ts；npm run test；npm run test:e2e -- e2e/chat-edit.workbench.spec.ts。实现前相关新用例应按目标行为失败，实现后全部通过；已有测试不得回退。

### P7：历史恢复、结果操作与端到端联调

依赖：P4、P5、P6。估算：3–4 工程人日。

**文件：**

- 新增 src/components/conversation/ConversationResultActions.tsx
- 必要修改 src/store/flowStore.ts、src/types/workflow.ts
- 复用 src/components/ImageViewer.tsx、CompareOverlay.tsx、panels/ResultsPanel.tsx、nodes/ResultNode.tsx
- 新增 tests/image-conversation-recovery.test.ts
- 扩展 e2e/chat-edit.workbench.spec.ts

**步骤：**

1. 先写生成中刷新、SSE 重复、切项目恢复、旧结果继续、复制/跨项目来源测试。
2. 连接真实本地服务与 mock provider，轮次和全局记录引用同一任务/输出。
3. 实现查看、对比、下载、继续修改、显式加入画布及重新打开原对话；新增节点类型按 P0 决策，不自动铺满画布。
4. 接入手动失败项重试及费用提示；测试原输入快照与草稿隔离，旧结果保留，成功标志必须晚于文件与终态持久化。

**验证：** npm run test；npm run test:e2e -- e2e/chat-edit.workbench.spec.ts。实现前相关新用例应按目标行为失败，实现后全部通过；已有测试不得回退。

### P8：全量回归、安全审查与交付

依赖：P0–P7 完成。估算：2–3 工程人日。

**文件：**

- 更新本批规划文档和验收记录
- 新增 docs/plans/2026-09-21-chat-edit-acceptance.md
- 按实际缺陷最小修复相关源码与测试

**步骤：**

1. 逐条执行 A01–A65，记录命令、结果、截图/trace、未验证项，不以 mock 通过宣称真实模型效果。
2. 复测现有 AI 改款、工作流、蒙版、属性、上传、结果恢复、项目文档与授权；审查完整差异。
3. CodeGraph sync/affected 与本地评审记录精确 base/head；gate:codex 未迁移前禁止运行，明确报告缺失关卡。
4. 形成交付报告；需要真实 AI、提交推送、合并或部署时分别取得对应授权，未授权不执行。

**验证：** npm run lint；npm run test；npm run check；npm run build；npm run test:e2e -- e2e/chat-edit.workbench.spec.ts；git diff --check。实现前相关新用例应按目标行为失败，实现后全部通过；已有测试不得回退。

## 5. 关键合约测试样例（拟建，非当前 API）

以下是 P1 可直接落成的完整最小纯校验示例，用于固定“任意整数 1–8、不得截断”的边界；它不替代 P3 语义解析。

```ts
// src/lib/imageConversationRules.ts 的一个独立导出
export function validateOutputCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 8) {
    throw new RangeError("单轮输出数量必须为 1–8 的整数");
  }
  return value;
}
```

```ts
// tests/image-conversation-rules.test.ts 的首批用例
import assert from "node:assert/strict";
import { validateOutputCount } from "../src/lib/imageConversationRules";
for (const count of [1, 2, 3, 4, 5, 6, 7, 8]) {
  assert.equal(validateOutputCount(count), count);
}
for (const count of [0, 9, 1.5, NaN, Infinity, "5", null, undefined]) {
  assert.throws(() => validateOutputCount(count), RangeError);
}
console.log("image conversation output-count tests passed");
```

队列集成必须在同一数据库事务内完成权限/引用检查、幂等冲突判断、对话活动锁、轮次/意图写入及既有队列入队；锁顺序遵守现有 user → project → assets → files → run 约束并在 P0 确定 conversation 的位置。不能先请求付费生成再补写历史。
结果以 intentId + attemptId 映射，不按完成顺序认定正面/侧面；相同提交重放使用同一 clientRequestId，同一次明确重试有独立稳定请求号。

## 6. 验证与交付命令

从项目根目录运行；源码修改阶段逐批执行，当前文档制作不代表以下已通过。

```sh
codegraph status .
codegraph impact WorkbenchShell -p . -j
codegraph impact enqueueGenerationRunInTransaction -p . -j
pnpm exec tsx tests/image-conversation-rules.test.ts
pnpm run lint
pnpm run test
pnpm run check
pnpm run build
pnpm run test:e2e -- --grep "conversation edit dock"
git diff --check
codegraph sync .
```

新增纯测试可用 pnpm exec tsx 聚焦；数据库测试不直连现有服务、不手动起测试 Compose。`pnpm run check` 已包含 lint/build:web/test，独立命令用于阶段诊断，耗时估算不重复计费。
执行 codegraph affected 时显式传入本批所有新增/修改源码文件，例如：

```sh
codegraph affected src/types/imageConversation.ts src/lib/imageConversationRules.ts server/lib/imageConversationStore.ts server/routes/imageConversations.ts src/components/workbench/WorkbenchShell.tsx -p . -j
```

上面仅为早期批次示例，最终必须从实际差异补全，不照抄当作完整覆盖。图无结果仍补源码与聚焦测试。
gate:codex 目前依赖 GitNexus，禁止运行且不得报告通过；迁移该脚本不属于本功能。交付记录该缺失关卡和精确 base/head，本地评审是否具备替代入口需另外核实。
没有真实付费调用授权时只进行 mock/契约验证。真实效果、费用及供应商稳定性列为未验证，不伪装全部完成。
提交/推送、合并、发布、Docker 同步与部署不是本次文档授权；获准后再逐项执行。

## 7. 本轮文档交付状态

已完成 P0/P1 规则与 UI 契约、P2 PostgreSQL 存储/API、P3 结构化规划/澄清、P4 持久队列/重试、P5 右侧对话壳、P6 四类输入/蒙版和 P7 历史恢复/结果操作；新增验收记录汇总实际证据与未验证项。
P8 已完成隔离 PostgreSQL `pnpm run test`、`pnpm run check`、`pnpm run build`、`pnpm run lint`、三档对话 Dock/多选起点/持久化历史/结果操作/提交契约 E2E、`git diff --check`、CodeGraph `sync/affected`；未擅自修改工作区中与本功能无关的其他 dirty 文件。`gate:codex` 未运行，因为项目规则明确禁止其 GitNexus 路径。
真实文本/图片模型、费用、生产迁移/回退、提交推送和部署未执行或未验证。
