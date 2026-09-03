# Implementation Plan: 画布工作台 UI 整改

**Branch**: `001-canvas-workbench-redesign` | **Date**: 2026-09-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-canvas-workbench-redesign/spec.md`

## Summary

把当前“两个左侧入口 + 共用左侧 Dock + 高信息密度节点”整改为五组低噪音工具栏、锚定式工具浮层、中心无限画布和可收起的固定右侧属性/Results Dock。节点创建由数据驱动的能力目录和统一创建意图控制；未具备独立执行契约的本地视频、白底图、风格迁移与视频生成功能仅展示禁用原因，不创建节点或触发网络请求。

文档层升级到工作流 schema v5：增加文本、画板、色板和独立人工确认节点；连接角色继续以 `edge.targetHandle` 为唯一持久化真相，并把端口升级为 `image/text/colors/video` 类型契约。场景仍使用 `image` 端口，服务端仅将其受限分析文本合入提示词，原图不发送给生成模型。分步换装通过第一轮 `basisRevision`、当前输出引用和独立确认节点共同判定确认是否有效；节点使用十态非持久化显示模型区分当前基准的可运行性和任务结果。画板编辑器按需加载，编辑期使用按账号、项目、页签和文档 epoch 隔离的 IndexedDB 恢复草稿，结束编辑时只向项目历史提交一次不可变内容引用。自动整理只处理主选节点的完整连通分量，并以一次原子文档修改更新坐标。

## Technical Context

**Language/Version**: TypeScript 5.7；Node.js 22.20 或更高；React 19

**Primary Dependencies**: React 19、Vite 6、Express 4、Zustand 5、zundo 2、`@xyflow/react` 12、`@base-ui/react` 1.7、本地 shadcn primitives、Tailwind CSS 4；新增按需加载的 `konva` 与 `react-konva` 用于画板编辑

**Storage**: PostgreSQL 18 保存项目、工作流、画板结构化版本与运行记录；`DATA_DIR` 保存上传和导出的二进制图片；IndexedDB 仅保存当前账号隔离的未提交画板恢复草稿；浏览器现有页签会话缓存继续用于项目会话恢复

**Testing**: Node `assert` + `tsx` 合同/单元/集成测试；所有新增测试必须登记到显式 `test:suite` 并由注册完整性门禁验证；隔离 PostgreSQL 测试运行器；Playwright 1.61 桌面 E2E；固定节点夹具的整改前后高度对比；至少 20 名首次使用者的可用性验收；stub/dummy provider，禁止真实或付费 AI

**Target Platform**: 桌面 Web，最低 1024 CSS px；主要验收宽度 1024、1280、1440；现有 current、white、eye 三种主题

**Project Type**: React 单页应用 + Express API + PostgreSQL 的 Web 应用

**Performance Goals**: 工具浮层在 250ms 内出现且跨越触发器与浮层不闪烁；常态第一/二轮换装节点使用同一固定夹具、浏览器和验收宽度测得的高度相对整改前下降至少 30%；自动整理后目标连通分量无节点重叠；初始 JS gzip 不超过 210KB、任一异步 JS chunk 不超过 500KB

**Constraints**: 中心 React Flow、ContextPanel/Results 业务树保持单实例挂载；UI、选择、画板编辑草稿和恢复栈不得进入持久化项目；自动整理、颜色选择、预览和可用性检查不得触发 AI；每个文档异步提交必须校验 `tabId + projectId + documentEpoch`；分步换装总参考图仍受 14 张上限和角色隔离约束；不实现未经独立规格批准的视频执行链路

**Scale/Scope**: 现有 10 种节点扩展为 14 种持久节点；五个工具分组、19 个可发现工具项；单项目上限沿用 500 节点/2000 边；画板首版最多 5 层并实施文档大小与对象数量上限；Results 的跨项目恢复、查看、比较、下载和设为输入全部保留

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Gate | Pre-research | Post-design evidence |
| --- | --- | --- |
| I. Professional garment semantics and reference isolation | PASS | 角色只存于 `targetHandle`；typed ports、角色基数、第一轮 detail 和独立确认契约在客户端、schema 与 DAG 三层一致校验。 |
| II. Paid AI safety and deterministic execution | PASS | 禁用项没有创建/网络副作用；角色、上限、确认和材料工艺在付费前拒绝；本功能不改变“初次请求后最多重试 2 次”的既有策略。 |
| III. Data security, privacy, and authorization | PASS | 画板内容与预览按 owner/project/node 授权；恢复草稿按账号与 DocumentTarget 隔离并在登出清理；不新增秘密或跨账号引用。 |
| IV. Contract-first, test-first delivery | PASS | 本目录先定义数据模型、UI/文档/画板契约和端到端验收；任务阶段必须先写失败回归，并覆盖 1024/1280/1440、三主题、键盘与 reduced-motion。 |
| V. Observable, recoverable production | PASS | Results 保持单实例；画板失败保留恢复草稿；项目保存使用不可变画板版本引用；任何迁移都需要备份、回滚与无真实 AI 验证。 |
| ProjectTab / DocumentSnapshot canonical boundary | PASS | 只有已提交节点数据和边进入快照；工具浮层、Dock、连接草稿、画板编辑栈和 IndexedDB 草稿明确排除。 |
| GitNexus and delivery gates | PASS | 2026-09-03 绑定仓库 `NEIHE-AI` 的索引覆盖 236 文件、24,325 symbols、56,986 edges、810 flows；`VirtualTryOnNodeData` 上游影响为 CRITICAL（至少 80 个依赖、49 个直接依赖），因此实现前必须逐符号 impact，完整覆盖前端、DAG、runner、schema、路由与测试，并在提交前执行非 partial/non-truncated 的 detect-changes。 |

不存在需要宪法例外或延期豁免的设计。

## Project Structure

### Documentation (this feature)

```text
specs/001-canvas-workbench-redesign/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── drawing-board-contract.md
│   ├── ui-interaction-contract.md
│   └── workflow-document-contract.md
└── tasks.md                         # 由 /speckit-tasks 生成，本阶段不创建
```

### Source Code (repository root)

```text
src/
├── App.tsx
├── components/
│   ├── CanvasFlow.tsx
│   ├── drawing/                     # 新增：按需加载的画板编辑器、图层与工具
│   ├── edges/PulseEdge.tsx
│   ├── nodes/
│   │   ├── NodeFrame.tsx
│   │   ├── VirtualTryOnNode.tsx
│   │   ├── TextInputNode.tsx        # 新增
│   │   ├── DrawingBoardNode.tsx     # 新增
│   │   ├── ColorPaletteNode.tsx     # 新增
│   │   └── StageApprovalNode.tsx    # 新增
│   ├── panels/
│   │   ├── ContextPanel.tsx
│   │   ├── InspectorPanel.tsx
│   │   └── ResultsPanel.tsx
│   ├── ui/popover.tsx               # 新增：项目本地 shadcn/Base UI primitive
│   └── workbench/
│       ├── WorkbenchShell.tsx
│       ├── ToolRail.tsx              # 新增
│       ├── ToolFlyout.tsx            # 新增
│       └── workbenchState.ts
├── lib/
│   ├── documentSnapshot.ts
│   ├── graphLayout.ts                # 新增：连通分量、路径与确定性布局纯函数
│   ├── nodeDisplayState.ts            # 新增：十态节点显示状态纯派生
│   ├── workflowPorts.ts               # 新增：跨故事共享的类型化端口兼容契约
│   ├── drawingDraftStore.ts          # 新增：IndexedDB 恢复草稿
│   ├── toolCatalog.ts                # 新增：五组能力目录与创建意图
│   └── canvasLanding.ts
├── store/
│   ├── flowStore.ts
│   └── customColors.ts
└── types/workflow.ts

server/
├── engine/
│   ├── dag.ts
│   └── runner.ts
├── lib/
│   ├── database.ts
│   └── workflowSchema.ts
└── routes/
    ├── drawingBoards.ts              # 新增：画板版本读取/写入与授权
    ├── projects.ts
    └── templates.ts

tests/
├── workbench-shell.test.ts
├── tool-catalog.test.ts              # 新增
├── canvas-creation.test.ts            # 新增
├── staged-try-on-ui.test.ts           # 新增
├── graph-layout.test.ts              # 新增
├── node-display-state.test.ts         # 新增
├── drawing-board.test.ts             # 新增
├── palette-flow.test.ts               # 新增
├── custom-colors.test.ts              # 新增
├── video-capabilities.test.ts         # 新增
├── document-snapshot.test.ts
├── workflow-schema.test.ts
├── dag.test.ts
├── flow-history.test.ts
├── project-tabs-session.test.ts
├── selection-consistency.test.ts
├── recent-results.test.ts
└── theme-contract.test.ts

e2e/
└── workbench.spec.ts
```

**Structure Decision**: 保留现有单仓库前端/服务端布局，不新建应用包。纯 UI 状态留在 `components/workbench`，项目文档命令仍由 `flowStore` 统一提交，图算法、节点显示状态、类型化端口和目录规则放在无 React 的 `src/lib` 纯模块中。画板编辑 UI 与 Konva 依赖放入独立异步 chunk；结构化画板版本由 PostgreSQL 授权资源承载，项目节点只保存不可变引用和可预览图片引用。新增合同测试必须同时进入显式 `test:suite`，测试注册完整性由独立门禁验证。

## Delivery Slices

1. **外壳纵向切片**：先用测试替换旧“禁止右侧 Dock”的契约，完成五组 ToolRail、锚定浮层、可用性目录、统一创建意图、视口安全落点和右侧 ContextPanel；确保 Canvas 与 Results 不重建。
2. **图语义纵向切片**：升级 typed ports、角色确认、路径高亮、自动整理和业务错误；把现有图像工作流保持兼容。
3. **分步换装纵向切片**：增加第一轮 detail、`basisRevision` 与 `stage-approval`，迁移 v4 已确认流程并确保所有无效输入在付费前阻断。
4. **创作工具纵向切片**：实现文本、色板和按需画板；先完成 DTO、授权资源、恢复/历史边界，再接编辑器、保存后直接图片输出和可选导出。色彩文本输入只接受规格规定的 HEX/RGB/HSL 子集并统一规范化。
5. **回归与上线门禁**：三宽度 × 三主题 × 鼠标/键盘/reduced-motion，完整 Results 回归、schema 迁移、bundle 预算、构建和 GitNexus change detection。视频执行、白底图和风格迁移继续禁用，待独立规格批准。

## Complexity Tracking

无宪法违规项；无需复杂度豁免。
