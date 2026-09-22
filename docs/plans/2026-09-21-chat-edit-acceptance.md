# 侧栏对话修改：验收记录

日期：2026-09-21
工作根目录：`/Users/neihe/NEIHE-AI`
范围：P0–P7 实现、P8 本地专项交付审查。未提交、未推送、未部署。

## 结论

P0–P7 已落地：对话状态与画布文档分离，PostgreSQL 持久化对话/轮次/意图/尝试，结构化规划与澄清，持久队列和独立意图重试，右侧 Dock、三种编辑模式、四类图片来源、蒙版、历史恢复、结果操作和加入画布来源追溯均已接通。本轮补齐具体历史结果的来源链要求恢复、切换到无历史图片时的对话隔离、GPT Image 2.5 显式模型路由、`outcome_unknown` 活动轮次保护、服务端共享参数能力校验、按模式过滤模型列表、多选图片先指定对话起点的取消保护，以及历史轮次的输入/蒙版快照、来源轮次、折叠参数和资产预览恢复；另外修复了首次打开 Dock 时异步建立会话覆盖未提交模式草稿的问题，并补充三模式草稿隔离与“开始新修改”独立会话回归。

P8 本地技术门禁已通过：`pnpm run lint`、`pnpm run build`、`pnpm run test`、`pnpm run check`，以及包含 1024/1280/1440 三档桌面宽度的对话 Dock、多选起点、持久化历史、结果操作、来源隔离、模式草稿和开始新修改 E2E 均通过。持久化历史场景通过真实项目、文件、对话和轮次接口构造 `draft` 轮次，验证首次打开、关闭后再次 `/resolve`、输入/蒙版快照和折叠参数；结果操作场景用真实上传文件和前端已完成结果快照验证继续修改、冲突取消保留草稿、确认换底图才清空草稿、加入画布、原图保留和稳定来源元数据；来源隔离场景验证同项目复制保留对话来源、跨项目粘贴清除对话来源；模式草稿场景验证异步首次建会话不覆盖各模式未提交内容；开始新修改场景验证独立对话和原草稿恢复。另修复 1024px 下结果操作按钮被压缩并被底部编辑器遮挡，以及首次打开 Dock 时异步建立会话覆盖未提交草稿的可操作性问题。上述场景均不调用规划器或真实图片 Provider。

本轮追加 `e2e/image-conversation-contract.workbench.spec.ts`：在三档桌面宽度下验证空白指令不提交、多图顺序和模式草稿隔离、未保存蒙版阻止局部重绘，以及参数选择后只提交一次带有有序 `inputManifest` 的请求。该用例暴露并修复浏览器中直接调用 `crypto.randomUUID` 导致发送路径 `Illegal invocation` 的问题，修复后 7/7 通过；仍未调用规划器或真实图片 Provider。

另外追加 `e2e/image-conversation-runtime-states.workbench.spec.ts`：在三档桌面宽度下验证排队轮次阻止重复发送但允许编辑下一轮草稿、澄清回答为空时阻止提交、失败方案显示单项重试并提示费用、未知结果只提供核对而不直接重试；该专项 10/10 通过，未调用规划器或真实图片 Provider。

工作树仍保留用户既有的其他 dirty 改动；本批没有修改或覆盖这些无关内容。

## 实现证据

| 工作包 | 结果 | 关键证据 |
| --- | --- | --- |
| P0 | 已完成 | 技术设计、UI 规格、归属 ADR 与计划文档 |
| P1 | 已完成 | `tests/image-conversation-rules.test.ts`、`tests/image-conversation-api.test.ts`；数量、输入顺序、上下文、模型参数、按模式能力过滤和不可变快照规则；规划前拒绝不支持模型/尺寸/蒙版比例 |
| P2 | 已完成 | `server/lib/imageConversationStore.ts`、增量迁移、授权/来源保护、无删除接口；`getImageConversation` 返回按 owner/project 校验的 `sourcePreviews`，PostgreSQL 存储/API 测试覆盖资产来源重读和 `/resolve` 完整历史 |
| P3 | 已完成 | `server/lib/imageConversationPlanner.ts`、API易适配器、结构化响应校验、澄清持久化与回答透传 |
| P4 | 已完成 | `server/engine/imageConversationExecution.ts`、`imageConversationReconciliation.ts`；原子入队、幂等、独立意图、未知结果与失败项重试 |
| P5 | 已完成 | `ConversationPanel`、`ConversationComposer`、`ConversationHistory`、`WorkbenchShell`；target-keyed memory-only store；历史轮次显示有序输入/蒙版快照、来源轮次和折叠参数；多选图片先指定起点，草稿底图冲突需确认，取消不切换、不创建对话、不发送请求 |
| P6 | 已完成 | 画布/本地/素材库/历史输入、稳定 sourceRef、引用绑定、MaskEditor 和 DocumentTarget 迟到回写门禁 |
| P7 | 已完成 | `ConversationResultActions`、生成输出来源映射、历史恢复草稿、资产预览恢复、`/resolve` 历史 hydration、加入画布稳定元数据、查看/对比/下载/继续/参考/重试 |

## 已执行命令

| 命令 | 结果 |
| --- | --- |
| `pnpm run lint` | 通过；`pnpm run check` 的 lint 阶段也通过 |
| `pnpm run build` | 通过；web/server 构建、CSS 产物和包体门禁通过 |
| `pnpm run test` | 通过；隔离 PostgreSQL 18 runner 正常创建并清理容器，图片对话规则、队列、存储和 API 全部通过 |
| `pnpm run check` | 通过；lint、web build、CSS/包体门禁和全量隔离 PostgreSQL 测试均通过 |
| `pnpm exec tsx tests/image-conversation-planner.test.ts` | 通过 |
| `pnpm exec tsx tests/image-conversation-inputs.test.ts` | 通过 |
| `pnpm exec tsx tests/image-conversation-recovery.test.ts` | 通过 |
| `pnpm exec tsx tests/image-conversation-ui.test.ts` | 通过 |
| `pnpm exec tsx tests/image-conversation-rules.test.ts` | 通过；共享参数能力校验和按模式模型列表 |
| `pnpm exec tsx tests/image-conversation-storage.test.ts` | 直接运行未设置 `DATABASE_URL`；已由标准隔离 PostgreSQL runner 在 `pnpm run test/check` 中通过，6/6 |
| `pnpm run test:e2e -- --grep "conversation edit dock\|multi-selected images require"` | 通过：setup + 两个场景覆盖 desktop-1024/1280/1440，共 7/7；覆盖 Dock 几何、焦点、模式草稿、素材入口、多选起点、取消保护和无对话请求 |
| `pnpm run test:e2e -- --grep "persisted conversation history restores snapshots"` | 通过：setup + desktop-1024/1280/1440，共 4/4；通过真实持久化轮次验证首次打开、关闭后再次 `/resolve`、输入/蒙版快照和折叠参数，未触发规划器或 Provider |
| `pnpm run test:e2e -- --grep "conversation result actions continue"` | 通过：setup + desktop-1024/1280/1440，共 4/4；验证历史结果继续修改只更新当前草稿，加入画布才新增节点且保留原图和对话来源元数据，未触发 AI 请求 |
| `pnpm run test:e2e -- --grep "conversation result actions continue\|conversation provenance survives same-project copy"` | 通过：setup + desktop-1024/1280/1440，共 7/7；验证结果操作栏在最小桌面宽度可操作，继续修改冲突取消保留草稿、确认才替换底图，同项目复制保留来源、跨项目粘贴清除对话来源，未触发对话或 AI 请求 |
| `pnpm run test:e2e -- --grep 'conversation mode drafts stay isolated|start-new upload creates'` | 通过：setup + 两个场景覆盖 desktop-1024/1280/1440，共 7/7；验证异步首次建会话不覆盖三模式未提交草稿，以及上传“开始新修改”创建独立会话并可恢复原对话草稿，未触发规划器或 Provider |
| `pnpm run test:e2e -- --grep 'conversation composer'` | 通过：setup + 两个契约场景覆盖 desktop-1024/1280/1440，共 7/7；验证空白指令、三模式草稿/输入顺序、未保存蒙版、参数请求和单次提交；同时回归浏览器安全的 `crypto.randomUUID` 请求号生成，未触发规划器或 Provider |
| `pnpm run test:e2e -- e2e/image-conversation-*.spec.ts` | 通过：setup + 8 个图片对话场景覆盖 desktop-1024/1280/1440，共 34/34；包含剪贴板来源隔离、提交契约、历史恢复、模式草稿、结果操作、运行态/澄清/失败未知结果、多选起点和开始新修改 |
| `git diff --check` | 通过 |

专项测试已覆盖并通过对话规则、输入/蒙版边界、planner、queue、storage、API、恢复/结果操作和前端状态契约；全量 `test/check` 也已通过。该结论仅覆盖本地 mock/回归门禁，不等同于真实 Provider 效果或生产验收。

## CodeGraph 证据

- `codegraph status .`：最终报告 index up to date；索引包含 445 个文件、7,748 个节点和 29,368 条边。
- `codegraph sync .`：本轮同步新增运行态/澄清/失败未知结果 E2E（新增 1 个文件、12 个节点）；最终 `status .` 报告 index up to date。
- `codegraph affected ... -p . -j`：显式传入 65 个新增/修改 TypeScript/TSX/JS/MJS/CSS 源码与测试文件，遍历 303 个依赖节点并返回受影响测试集合，其中包含全部 `tests/image-conversation-*.test.ts`、多选起点、持久化历史、结果操作、来源隔离、模式草稿、开始新修改、提交契约和运行态 E2E 与 `e2e/workbench.spec.ts`。
- 开发前及收尾核对已对 `WorkbenchShell`、`Workspace`、`addAssetNode`、`createDocumentSnapshot`、`findConversation`、`reconcileImageConversationRun`、`ConversationPanel`、`ConversationComposer`、`ConversationHistory`、`ImageConversationPlanner`、`buildModelOptions`、`normalizeSize` 等现有符号执行 impact；空/不完整图结果均按源码和测试补查。
- 未运行 `gate:codex`：项目规则明确该脚本仍调用 GitNexus，本批禁止运行。

## 未验证与后续门槛

- A01–A65 尚未逐条形成截图/trace 矩阵；当前证据以专项测试、完整技术门禁和三档 Dock E2E 为主。
- 未调用真实文本规划模型、真实图片 Provider 或付费 API，因此真实质量、时延、费用和供应商稳定性未验证。
- 本批未修改工作树中其他既有 dirty 内容；当前全量测试未发现其阻断。
- 未执行生产数据库迁移/回退、提交、推送、合并、发布或部署。
