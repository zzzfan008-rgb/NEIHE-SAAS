# TiAngelNode Implementation Plan — 开发计划

## 2026-09-21 已确认修订

以 PRD v0.3 为准，以下旧版模板接入计划被覆盖：从左侧添加节点创建 TiAngle，默认关闭且不连线；用户手动连接第一轮输入。内置模板去绑定，但不改写已有用户项目和自建模板。兼容 local `8fdbf3c923e9e6c5414d7688d627e085ded1f0c1` 的预合成、独立姿势评审和可选精修参数，补齐 Gemini 3 Pro 适配。验证三种桌面宽度的添加、连线确认、折叠、模型切换及恢复，并执行完整检查和构建。此次不提交、合并或部署，不调用真实 AI。

> 执行交接：实施时按 `executing-plans` 技能逐任务推进；项目 AGENTS.md 和用户授权边界优先。本文是计划，不授权启动开发、提交、发布或真实 AI 调用。

**Goal:** 按 PRD v0.2 交付可从侧栏添加、可在一键换装第一阶段消费的三轴视角文本节点。

**Architecture:** Three.js 控件仅编辑结构化角度；纯语义编码器与 8 模型适配器输出文本。服务端按下游模型冻结运行快照，显示用参考图不成为模型输入；业务数据留在现有文档/Store，折叠和拖动预览留在组件本地。

**Tech Stack:** React、TypeScript、React Flow、项目本地 shadcn、Zustand、Three.js（实施时确定并锁定版本）、现有 Node/PostgreSQL 执行链路与 Playwright。

---

日期：2026-09-18。状态：T00–T08 工程开发与自动化验收已完成；T09 真实效果等待用户另行确认素材、模型矩阵、调用量和费用上限后执行。详细证据见 TODO。

- 需求基线：[TiAngelNode-PRD](../../doc/TiAngelNode-PRD.md)。冲突时遵循 AGENTS.md 和用户最新明确指令，并修订计划，不自行改变需求。
- 排期：[开发周期](../../doc/TiAngelNode-Schedule.md)。执行记录：[TODO](../../doc/TiAngelNode-TODO.md)。三份文档统一使用 T00–T09 编号。
- 所有源码路径以仓库根目录为基准；“新建”路径是拟定路径，不表示文件已经存在。

## 1. 范围与开发约束

保持 `ti-angle`、`TiAngelNode`、“3D 视角”命名；默认关闭；三轴参数范围和方向严格遵循 PRD。采用参考图平面、轨道、相机球与方向线，固定外部观察相机；roll 旋转取景框标记。文本初始完全折叠，不露摘要。

适配器覆盖 `ImageModelId` 全部 8 个 ID，但仅给 `scene-stabilize` 开放 `angle-direction`。原换装 3 模型白名单不变，第二阶段继承已确认基准。可选 `preview-image` 只接既有图片输入，不能增加 Provider 图片、费用或生成依赖。

不实现距离/焦距、三维重建、身体姿态编辑、引导图/Hybrid、视频、移动端、新模型接入、其他工作流开放或生产部署。不修改与本功能无关的设计师新模板 ADR。

## 2. 已核实的接入点与风险

2026-09-18 CodeGraph status 显示索引最新。explore 查询指出 `WorkflowNodeData` 关联 DAG、schema、UI 和文档测试；`ExecutionPlan` 关联 runner、队列及运行路由。图不是穷尽性证明。

| 接入点 | 现有位置 | 主要风险 |
| --- | --- | --- |
| 类型与默认数据 | `src/types/workflow.ts`、`src/store/flowStore.ts` | kind 穷尽分支、历史和复制漏字段 |
| 注册和添加入口 | `src/components/nodes/index.ts`、`src/components/panels/NodeLibraryPanel.tsx`、`src/components/CanvasFlow.tsx` | 有渲染注册但无法创建，或被当成 AI 生成目标 |
| 文档边界 | `src/lib/documentSnapshot.ts`、`src/lib/tabSessionStorage.ts`、`server/lib/workflowSchema.ts` | 临时状态进入快照，旧文档被自动改写 |
| 端口/图片名额 | `src/lib/workflowPorts.ts`、`src/components/panels/InspectorPanel.tsx` | 总入边数误计图片配额，显示边泄漏进请求 |
| 计划与执行 | `server/engine/dag.ts`、`server/routes/runPlan.ts`、`server/engine/runner.ts`、`server/engine/runQueue.ts` | 子图漏编译，重试读新值，增强/回退丢约束 |
| 基准/确认 | `flowStore.ts`、`src/components/nodes/StageApprovalNode.tsx`、上述运行服务 | 旧图能重新确认成新视角，客户端校验被绕过 |
| 模板 | `server/routes/templates.ts` | 只改模板定义而没更新刷新检测，旧用户项目被迁移 |

实施前对即将编辑的现有符号逐一执行 `codegraph impact "符号名" -p . -j`，报告实质风险。重点包括 `WorkflowNodeData`、`buildExecutionPlan`、`assertPlanInputs`、`executeStep`、`sceneBasisTargetsForSource`、`updateNodeData`、`dualModelStagedTryOnTemplate`。图为空时继续源码和测试检查，不视作低风险。本次仅写文档，不修改这些符号。

## 3. 执行方式与依赖

每个任务按以下小步执行：补一条失败用例 → 跑该用例确认失败原因 → 最小实现 → 重跑用例 → 补边界 → 检查 diff → 在 TODO 留证据。每小步以约 2–5 分钟动作拆分，大型集成/浏览器测试按实际耗时记录，不以时限降低验证标准。

依赖顺序：T00 → T01 → T02 → T03 → T04；T05 依赖 T02/T03；T06 依赖 T01/T05；T07 依赖 T03–T06；T08 依赖 T00–T07；T09 依赖 T08 及单独授权。双人实施时可在契约稳定后并行 T04 与 T05/T06；同一 Store、DAG、schema 文件指定单一集成人，避免交叉覆盖。

阶段完成不自动提交；用户说“通过”后才按项目规则提交、推送及本地精确 SHA 审查。不得调用 GitNexus，也不得以独立检查代替声称完整 gate 已通过。

## 4. 任务拆解

### T00 — 基线与接入验证（0.5 人日）

**文件：**读取 `AGENTS.md`、PRD、`package.json`、`.nvmrc`、上述接入点、`scripts/test-with-postgres.mjs`、`scripts/e2e-with-postgres.mjs`。

1. 记录工作树已有变更、base/head、Node 版本和 CodeGraph 状态；保留所有无关修改。
2. 列出 kind 注册、默认数据、端口、快照、schema、队列与运行请求的所有分支，impact 后记录遗漏风险。
3. 核实第二轮服务端校验能否关联已完成第一轮的输入指纹；若记录链不足，先限定所需元数据补充，不擅自增加数据库表。
4. 核实本地 shadcn 是否已有折叠原语，缺少时计划在 `src/components/ui/` 增加项目本地原语。
5. 复核 PRD 尺寸提案（320px / 288×208px）和位置建议；进入 UI 代码前完成具体布局确认，已确认交互不重复询问。

**退出标准：**接入表和风险可检查，数据库/测试环境可用或明确阻碍；不启动真实模型调用。

### T01 — 角度契约、语义与全部模型适配（1 人日）

**新建：**`src/lib/tiAngle.ts`、`tests/ti-angle.test.ts`。
**修改：**`src/types/workflow.ts`、`package.json` 的测试清单；复用 `src/types/imageModels.ts`，不扩大模型列表。

1. 用项目现有 `node:assert/strict` + tsx 风格写范围、正负方向、边界和禁用输出测试，先确认失败。
2. 实现 `TiAngleConfig`、严格服务端校验、交互规范化、语义编码及纯文本编译；配置和派生语义不混存。
3. 对每个模型显式注册适配器，测试八模型全覆盖、unknown ID、无 Qwen token、disabled 空输出、全零非空输出。
4. 测试 ±180°、-0、半档等距边界、浮点提交与非法类型；纯模块不导入 Three.js/DOM。
5. 将新增用例加入既有测试清单，跑失败→通过闭环。

首条可执行契约用例（拟新增接口，不表示已有实现）：

```typescript
import assert from "node:assert/strict";
import { compileTiAngleText } from "../src/lib/tiAngle.ts";

const config = { version: 1 as const, enabled: true, azimuthDeg: 45, elevationDeg: 15, rollDeg: -10 };
const compiled = compileTiAngleText(config, "gpt-image-2");
assert.equal(compiled.targetModelId, "gpt-image-2");
assert.equal(compiled.adapterVersion, 1);
assert.match(compiled.text, /左前/);
assert.match(compiled.text, /逆时针.*10/);
assert.equal(compileTiAngleText({ ...config, enabled: false }, "gpt-image-2").text, "");
```

**验证：**新增文件后执行 `pnpm exec tsx tests/ti-angle.test.ts`，期望断言通过、零网络调用。对应 A02/A03/A03b。

### T02 — 持久化、创建数据与历史（1 人日）

**修改：**`src/types/workflow.ts`、`src/lib/documentSnapshot.ts`、`src/store/flowStore.ts`、`server/lib/workflowSchema.ts`；必要时修改 `src/lib/tabSessionStorage.ts`。
**测试：**`tests/document-snapshot.test.ts`、`tests/workflow-schema.test.ts`、`tests/flow-history.test.ts`、`tests/project-tabs.test.ts`、`tests/project-tabs-session.test.ts`。

1. 先写新节点保存/恢复、旧文档保持不变、非法参数拒绝的用例。
2. 添加 kind、默认关闭数据与严格快照白名单；使用实施时下一个可用 schema 版本，不硬编码“必须 18”。
3. 贯通复制、粘贴、模板 ID 重映射和撤销重做；不保存 text、折叠、纹理或 renderer。
4. 为目标文档绑定的单次提交补测试，覆盖切页/删除后迟到事件；一次拖动只提交一次历史操作。
5. 跑隔离测试并检查保存后 JSON，而非只查源代码字符串。

**退出标准：**A04/A05/A06 的文档行为成立；旧项目不插节点、不自动开启。

### T03 — 类型端口与执行计划（1.5 人日）

**修改：**`src/lib/workflowPorts.ts`、`server/engine/dag.ts`、`server/routes/runPlan.ts`、`src/components/panels/InspectorPanel.tsx`；类型按需补充到 `src/types/workflow.ts`。
**测试：**`tests/dag.test.ts`、`tests/authorization.test.ts`、`tests/staged-try-on-ui.test.ts`。

1. 为 text 边、可选 preview-image、重复来源、错误 kind/第二阶段连接写失败用例。
2. 添加端口类型及前后端一致校验；图片名额按图片角色计数，不按总入边数。
3. 服务端从保存项目按目标模型重编译 `angleControl`，冻结来源、参数、版本、模型和文字；不信任客户端派生文字。
4. 显示边参与文档类型/环校验，但不进入图片上游、模型请求和生成依赖；缺图不阻断文本计划。
5. 验证单节点运行能读取角度来源；整图包含 ti-angle 时是零请求的数据步骤，不能单独当生成目标。
6. 比较关闭前后计划，确认原必需图、图序、换装白名单及授权不变。

**退出标准：**A07/A08/A09b；8 模型文本适配与 3 模型换装准入同时成立。

### T04 — 执行提示词、队列快照与基准确认（2 人日）

**修改：**`server/engine/runner.ts`、`server/engine/runQueue.ts`、`server/routes/runPlan.ts`、`src/store/flowStore.ts`、`src/components/nodes/StageApprovalNode.tsx`；确需补运行元数据时先定位现有存储接口。
**测试：**`tests/try-on-quality-pipeline.test.ts`、`tests/run-queue.test.ts`、`tests/flow-history.test.ts`、`tests/dag.test.ts`。

1. 用 mock Provider 截取最终请求，先复现角度遗漏/旧基准重确认问题。
2. 场景、姿势和样式参考中与镜头矛盾的规则按 PRD 第 8 节拆维度；原身份/服装约束保持。
3. 在增强成功、失败回退及 safetyFallback 后拼接同一冻结约束，不让增强改写；仅角度不额外调用增强。
4. 有效角度/启用/连接变化与 basisRevision 原子更新；展示图变化不单独失效，真实人物图业务边仍正常失效。
5. 第一轮结果绑定完整输入指纹；第二轮在服务端核实已完成运行和确认引用，拒绝旧图冒充新角度。
6. 测试运行中改角度、重试/重启、撤销、已入队第二轮、跨项目恢复；历史结果必须保留。

**退出标准：**A09/A10/A11/A14，记录 mock 请求内容及不增加请求的断言。发现必须改变主要存储方案时先重新对齐。

### T05 — 节点外壳、添加入口与折叠文本（1 人日）

**新建：**`src/components/nodes/TiAngelNode.tsx`。
**修改：**`src/components/nodes/index.ts`、`src/components/panels/NodeLibraryPanel.tsx`、`src/components/panels/InspectorPanel.tsx`、必要的 `NodeFrame.tsx` 适配；只修改触及的标准控件。
**测试：**`tests/canvas-creation.test.ts`、`tests/staged-try-on-ui.test.ts`，新增 `e2e/ti-angle.workbench.spec.ts`。

1. 先写侧栏添加、默认关闭、无连线、不可单独 AI 运行的行为用例。
2. 用本地 shadcn 实现三行数值、预设、重置、启用和文本折叠；缺少原语时补本地实现。
3. 默认输出区域只有“查看输出文本”；展开后显示目标节点/模型/全文和复制；只读项目不能改值。
4. 未连接显示未绑定模型的通用描述；多个下游分别显示/复制；切模型重编译但不自动展开。
5. 添加键盘、焦点恢复、复制失败、取消手势和 documentEpoch 保护测试，不复用会调用 LLM 的文本优化按钮。

**退出标准：**A01b/A01c/A03c/A05，UI 状态不进入文档。

### T06 — Three.js 控件、参考图与资源生命周期（2 人日）

**新建：**`src/components/nodes/TiAnglePreview.tsx`、`src/lib/tiAngleGeometry.ts`、`tests/ti-angle-geometry.test.ts`。
**修改：**TiAngelNode、`package.json`、`pnpm-lock.yaml`；扩展 `e2e/ti-angle.workbench.spec.ts`。

1. 独立几何模块先写相机球坐标、反解、边界和 roll 正负测试；确定锁定 three 及配套类型版本，仅安装所需依赖。
2. 固定外部观察相机，绘制图片平面、轨道、弧线、球、方向线和取景框；标注“示意”及约定正面。
3. 实现 raycast 命中与抓取偏移；水平/垂直手柄各只改一轴，球改两轴，roll 不旋转图片；处理背面命中和 ±180°接缝。
4. 复用鉴权图片来源首张图，contain 显示；缺失/失败用占位。异步纹理加载绑定文档和来源版本，晚到资源释放。
5. 隔离画布手势、pointer capture、Escape/失焦/切页取消；局部实时预览、松手一次提交。
6. 懒加载、单个活跃 renderer、按变化渲染、静态预览及 DPR 上限；卸载释放纹理/几何/材质/事件。
7. 浏览器验证 WebGL 初始化失败、context loss、手动重试、离屏切页和减少动态效果偏好。

**验证：**`pnpm exec tsx tests/ti-angle-geometry.test.ts`；`npm run test:e2e -- e2e/ti-angle.workbench.spec.ts`。对应 A01d/A02/A03/A04/A05/A12/A13。不把静态画面或纯数学测试当成拖动通过。

### T07 — 模板与完整用户流程（0.5 人日）

**修改：**`server/routes/templates.ts`；扩展 `tests/staged-try-on-ui.test.ts` 和新 E2E。

1. 测试 `builtin-tool-one-click-try-on` 保持身份，新增 view-angle、显示图边及 angle-direction 边。
2. 同步托管模板刷新检测；只更新内置定义，不修改旧项目/用户模板。
3. 验证图片上传自动连接不被显示边干扰；模板克隆重映射两条边。
4. 在三个桌面尺寸测量新增节点间距、文本展开后的遮挡；仅按原放置规则调整新节点。
5. mock 完整走通“添加/模板 → 角度 → 第一轮 → 确认 → 第二轮 → 结果查看/比较/下载/继续处理”。

**退出标准：**A01/A06/A13/A14；保留人工确认和原结果能力。

### T08 — 综合回归、修复与交付证据（1.5–2.5 人日）

**文件：**本功能源码/测试、`package.json` 测试清单、TODO；必要时新增 `doc/TiAngelNode-Verification.md` 保存实际证据。

1. 对照 PRD 每条 A 编号逐项跑验收，补断言而非只检查类名。
2. 跑第 5 节门禁，记录命令、环境、退出码、截图与未覆盖项。
3. 查看完整 diff（包括新增文件），确认没有真实调用、密钥、运行产物、无关重构。
4. 完成修复后重跑受影响测试；CodeGraph sync/affected 包含新源码文件，补图未覆盖的队列和浏览器用例。
5. 交付“工程验证完成/真实效果待验证”的明确状态；所有未通过项不得勾选完成。

### T09 — 真实生成效果验收（另行授权后 1–2 人日）

1. 提交测试参考图、角度矩阵、模型、调用量上限及费用预算，请用户授权。
2. 优先验证工作流实际支持的 3 模型；其余 5 模型只验文本契约，不擅自开放工作流或调用接口。
3. 记录原图与结果、最终提示词、方向/身份/服装/姿势表现；抽样方案和实际调用量单独留档。
4. 大角度/背面失真时报告限制，由用户决定调整适用范围；不自动加引导图或降级需求。

**退出标准：**人工效果结论可追溯；此阶段不包含部署、合并或发布。

## 5. 验证命令与执行注意事项

纯函数新用例可单独 `pnpm exec tsx tests/ti-angle.test.ts`、`pnpm exec tsx tests/ti-angle-geometry.test.ts`。先验证测试不导入数据库；数据库相关用例必须交给现有隔离 runner。

```bash
npm run lint
npm run test
npm run test:e2e -- e2e/ti-angle.workbench.spec.ts
npm run check
npm run build
git diff --check
codegraph sync .
```

逐条执行并记录结果，不用分号串联掩盖前序失败。`check` 已含 lint、web build 和全量 test，最终仍按项目要求单独运行 build。单测 runner 当前不转发测试文件参数，不编造 `npm run test -- 文件名` 的聚焦能力；E2E runner 已有参数转发。禁止临时直连生产 PostgreSQL 或自行管理测试 Compose 生命周期。

随后以实际全部变更源码列表运行 `codegraph affected <文件列表> -p . -j`（替换占位符，包含新文件），将推荐测试与手工选定测试取并集。期望所有必要检查退出 0、实际几何/交互通过、mock 请求符合契约。

`gate:codex` 仍依赖 GitNexus，迁移前禁止运行；报告门禁不可用，不把 check/build 宣称为完整 gate。迁移属于单独任务，不纳入本期工时。合并、发布、部署各需单独授权。

## 6. 完成定义

工程完成需要 T00–T08、PRD 所有自动化验收项、完整 diff 审查与实际证据；未执行的用例标“未验证”，不能勾选。产品真实效果完成还需要 T09；代码/单测通过不代表生图方向可靠。当前文档生成不表示任何开发任务已完成。
