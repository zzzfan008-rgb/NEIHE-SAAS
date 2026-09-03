# Garment Canvas 项目完成度台账

本文件记录从基线 `main@105fa861d5de7493a6d0d330e81c0a121eac4fb1` 到正式交付候选版本的实施、验证与审查证据。只有 A–G 全部验收并经用户确认合并最终 PR 后，项目才视为完成。

> 本文件是状态与证据台账，不重复定义当前项目规则。规则、优先级和冲突
> 处理统一以仓库根目录 [`AGENTS.md`](../AGENTS.md) 为准；此处的分支、SHA、
> PR、CI 与审核记录均按对应日期理解，并在使用前实时核对。

## 范围与约束

- 产品仅支持桌面端：最低 1024 CSS px，主要验收宽度为 1280 与 1440。
- 不建设移动端、触控专用布局、视频/音频生成或通用 AI 聊天伙伴。
- 不发送真实 AI 请求；自动化使用 dummy key、不可达 AI 地址或显式 stub。
- 保留登录、单设备会话、项目页签、生成队列、SSE 恢复、防重复计费、未知结果保护、跨项目 Results、查看、对比、素材、模板与三主题。
- 每个阶段使用 `codex/` 分支和独立 PR。GitHub Actions 不再作为门禁；当前门禁为本地确定性测试、GitNexus、精确 SHA 核对和使用 Codex 默认模型的 `npm run gate:codex`。合并、打 tag、发布和部署必须等待用户确认，且不触发或等待 Codex Cloud Review。
- GitHub 操作仅使用项目本地 `.env` 中的 `GITHUB_PAT`；不得提交或输出密钥。

## 当前基线

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 最新产品/UI PR | 已合并 | [PR #20](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/20) 已合并为 `c34336fa61d409eea1933917091cedbfec1126f0`；登录页视觉与交互改造进入 `main` |
| 最新维护 PR | 已合并 | [PR #21](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/21) 已合并为 `d942885c57fcf97c5f18821ee94c7f3f720e6cac`；加入本地开发预检与 PostgreSQL 读校验 |
| 最新门禁 PR | 已合并 | [PR #22](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/22) 以 `d942885c57fcf97c5f18821ee94c7f3f720e6cac` 为 base、`246a258bdad108c0c49853fb5804e811768c468a` 为 head，已 squash-merge 为 `4701280af93cea8a62df6c2799ba5f1b425829ce`；GitHub Actions 门禁由本地 Codex 门禁替代 |
| PR #23 合并前 main 基线 | 已确认 | PR #23 创建与合并前，本地 `main`、刷新后的 `origin/main` 与 GitHub 远端 `main` 均为 `4701280af93cea8a62df6c2799ba5f1b425829ce`（2026-09-01 复核） |
| GitHub Actions 状态 | 已退役 | PR #20 的 Test and build 在 `2ac4419d4ca66f749d39cf41ec7bc628707bbcfc` 成功；PR #21 的运行在启动阶段失败，不能作为代码结论。后续候选改用本地 Codex 门禁 |
| 证据收口 | 已完成 | [PR #18](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/18) 已合并为 `a6282818bf0f29f8217c473e6f1a55a13b58b276`，仅更新交付证据，不新增产品或生产行为 |
| 首个版本发布 | 已完成 | [`v0.1.0`](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/releases/tag/v0.1.0) 已于 2026-08-30 发布，annotated tag 解引用后精确指向 `a6282818bf0f29f8217c473e6f1a55a13b58b276`；生产部署仍需单独授权 |
| 最新已闭环审查证据 | 已记录 | PR #19 候选 `c8d99866d06468868920b684e90da6e367e66995` 的 GitNexus 累计变更风险为 high（66 个变更符号、11 条受影响流程）；定向影响为 low，29/29 桌面回归、完整 `npm run check`、本机 Gemma 三组精确 SHA 复审与 CodeRabbit 均通过 |
| 当前门禁候选 | 已完成 | `codex/codex-local-gate` 的精确 head `246a258bdad108c0c49853fb5804e811768c468a` 已通过完整门禁并经 PR #22 合并；合并后 `main@4701280af93cea8a62df6c2799ba5f1b425829ce` 的确定性套件再次通过，默认 Codex 模型复审补跑以退出码 0 返回 `pass` |
| 当前门禁规则 | 已验证 | GitHub Actions 因账户计费/额度无法启动而退役；后续候选运行 `npm run gate:codex`，由确定性本地套件加 Codex 配置的默认模型审查精确 diff，任何 P0-P3 有效问题阻断 |

## 阶段进度

状态约定：`未开始`、`进行中`、`待审查`、`待用户确认`、`已完成`、`阻塞`。

| 阶段 | 状态 | 交付范围 | PR | CI | 复审 |
| --- | --- | --- | --- | --- | --- |
| A 状态正确性与撤销事务 | 已完成 | 文档事务、运行态隔离、拖拽单步撤销、canonical selection、失效结果引用清理 | [PR #2](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/2) | [实现终态](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/32755048012)与[合并后 main](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/32802751095)通过 | [最终精确头审查](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/2#issuecomment-5398788404)无重大问题 |
| B 文档与持久化边界 | 已完成 | `DocumentSnapshot`、活动文档单一数据源、草稿隔离、持久化节流 | [PR #3](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/3) | [最终代码头 CI 32836676937](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/32836676937) 与[合并后 main CI 32847496614](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/32847496614)通过 | B1–B3 独立本地审计 APPROVE；[最终代码头 Cloud Review](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/3#issuecomment-5409048696) 无重大问题，5 个线程全部解决 |
| C 首次生成黄金路径 | 已完成 | pristine 启动器、模板 fit/聚焦、点击添加/快捷建图、隔离生成 E2E | [PR #4](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/4) | [最终代码头 CI 32854643883](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/32854643883) 通过 | [最终代码头精确复审](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/4#issuecomment-5411293171)无重大问题；2 个 P2 线程已解决 |
| D 结果迭代与桌面体验 | 已完成 | 显式结果动作、三主题 × 三宽度、统一左侧 Dock、横向缩放、平台快捷键与拖拽稳定性 | [PR #10](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/10)、[PR #14](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/14)、[PR #15](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/15)、[PR #17](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/17)、[PR #19](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/19) | [最新合并后 main CI](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/33313563543) 通过 | 三主题 × 三宽度、键盘/焦点、Results 与最新 UI 回归证据已补齐并经用户视觉确认；本机 Gemma 与 CodeRabbit 通过 |
| E 生产产物与 CI | 已完成 | production Playwright smoke、CI 顺序、runner 信号清理、导航竞态修正 | [PR #11](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/11)、[PR #12](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/12)、[PR #13](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/13) | [最新合并后 main CI](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/33266794035) 通过 | 不适用（当前流程不再使用 Cloud Review） |
| F 性能与包体 | 已完成 | lazy boundary、稳定 vendor 拆包、初始 gzip 预算、CI 体积门禁 | [PR #16](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/16) | [PR head CI 33266192802](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/33266192802) 与[合并后 main CI 33266794035](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/33266794035)通过 | 本机 `gemma4:e4b` 精确 SHA 分组复审无有效 P0–P3 阻塞项；CodeRabbit 通过 |
| G 文档与发布准备 | 已完成 | 部署/恢复/安全文档、发布候选 PR、最终审计与用户确认 | [PR #17](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/17) | [PR head CI 33268687680](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/33268687680) 与[合并后 main CI 33269171028](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/33269171028)通过 | [本机 Gemma 精确 SHA 复审记录](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/17#issuecomment-5464184334)为 `APPROVE`，无有效 P0–P3 |

## 验收清单

### A. 状态正确性与撤销事务

- [x] queued/running/retry/cancel 等运行态不进入撤销历史。
- [x] 一次节点拖拽只产生一条撤销记录，且一次撤销回到拖拽前位置。
- [x] 无实际文档变化的 undo/redo 不修改 revision、dirty 或 saveState。
- [x] 成功生成输出作为一次原子文档提交。
- [x] 建立并统一使用 `commitDocumentMutation`、`runWithoutHistory`、`beginHistoryTransaction` / `endHistoryTransaction`。
- [x] React Flow 使用 drag start/stop 作为事务边界；blur、pointercancel 与卸载也会幂等收口。
- [x] `selectedNodeIds` 为 canonical，`primarySelectedNodeId` 为派生值；点击、框选、新增、删除、复制、切页和空白取消一致。
- [x] DOM focus 不进入文档、撤销栈或项目持久化。
- [x] recentResults 裁剪、删除和同步后原子清理失效的 selectedResultId / compareIds。
- [x] Inspector、复制、删除与 Result 对比作用于同一选择对象。

Phase A 本地行为证据：`flow-history` 19/19、`selection-consistency` 11/11、`project-tabs` 35/35、`project-tabs-session` 12/12、`recent-results` 20/20；Playwright 在 1024 / 1280 / 1440 三个桌面项目共 11/11 通过。用户确认后 PR #2 已合并为 `d50aa6dc46fcdea23368c4c547683a582b9ca49a`，合并后 main CI 全部通过。

### B. 文档与持久化边界

- [x] 定义纯 `DocumentSnapshot`，仅含可保存项目内容。
- [x] selection、viewer、compare、运行状态、测量尺寸和临时 UI 不进入文档。
- [x] tabs 中活动文档成为唯一数据源；移除依赖订阅顺序的双向复制同步。
- [x] 保留兼容 selector，分步迁移消费者。
- [x] session 持久化按文档 revision / 页签拓扑触发，并 debounce 或 idle flush。
- [x] 草稿按页签隔离；单页签配额失败不删除其他草稿。
- [x] 连续输入形成合理撤销粒度，不逐键序列化完整 tabs。
- [x] 刷新、切页、后台任务、坏页签、配额失败、撤销重做和跨账号清理均有测试。

Phase B1 本地证据：项目保存、模板保存、运行计划与 v1 浏览器草稿统一走同一纯文档 serializer；9 种节点的运行态、错误、选择、测量、React Flow 外壳与未知字段均被剥离，wire 仅补 `status: idle`。服务端严格 canonicalization、v0/v1 模板读取、历史不兼容 v2 内置模板修复与全新目录六份模板均有回归。`document-snapshot`、`workflow-schema` 22/22、`project-tabs-session`、`project-tabs` 35/35、`npm run check` 与生产构建通过；三名独立审计最终均为 APPROVE。

Phase B2 本地证据：建立完整活动文档 selector 边界，并将画布、顶栏、属性/结果面板、节点、模板、复制粘贴与命令式 `getState()` 路径全部迁移。TypeScript TypeChecker 架构门禁扫描 57 个 `flowStore` 外的消费者源文件，拒绝绕过 selector 直读 14 个临时镜像字段，并以故意违规的参数解构/重命名负向探针防止门禁空跑。印花素材异步保存修复了请求期间切页后误回写新页签的竞态，回归验证始终定向发起命令的原页签。`npm run check` 含完整隔离 PostgreSQL 套件通过；GitNexus 因涉及 48 个已变更符号、41 个受影响符号与多条画布/页签流程评为 critical，已用页签、选择、历史、会话与全套回归覆盖，三次独立审计最终均为 APPROVE。

Phase B3 本地证据：`ProjectTab[]` 成为活动与后台文档的唯一真相，`FlowState` 已删除 14 个顶层镜像字段、镜像 helper 和同步 subscriber；selector 直接返回 `tabs` 内原始对象引用。文档、选择、结果引用、保存元数据、SSE 回写、会话草稿与页签切换都以单次 `tabs` 替换原子发布。zundo 仅作为每页签历史栈记录器，公开与应用内 undo/redo 统一由 canonical 页签回放适配器执行，不会生成顶层幽灵字段，并保留服务端运行态、选择与 React Flow 测量瞬态。所有保存、运行、上传、素材选择、蒙版和印花素材异步回写在发起时捕获不可变 `DocumentTarget(tabId, projectId, documentEpoch)`，因此同一页签整体换项目后，旧响应也不能污染新文档。`npm run check`、`npm run build`、`git diff --check` 通过；历史 21/21、页签 37/37、选择 11/11、会话 13/13、结果 20/20、活动文档边界 5/5，共 107 项高风险定向回归通过。GitNexus 最终识别 131 个变更符号、110 个受影响符号与 12 个索引文件，风险为 critical；范围与本次横切单一数据源及异步身份迁移一致。三轮独立终审均为 APPROVE，无 P0–P3。

Phase B4 本地证据：会话草稿升级为 v2 manifest + 每页签独立分片，以 `projectId / documentEpoch / revision / savedRevision / dirty / readOnly / saveState` 和页签拓扑为稳定信号，250 ms trailing debounce 后在 idle 写入，`pagehide` / hidden 同步收口。单页签 quota 失败仅隔离该分片，健康新页签仍可发布拓扑；legacy 迁移和 manifest 发布失败保留上一完整恢复点。Storage 读取抛错与确定缺失/写失败已分类：瞬时读异常不修剪 manifest、不清理分片，启动时读取不完则停用本页 writer；跨账号清理会先永久停用旧页面 writer，并验证旧草稿确已删除后才绑定新 owner。`project-tabs-session`、`auth-client`、历史/页签/选择定向回归、`npm run check`、`npm run build` 与 `git diff --check` 均通过；未发送真实 AI 请求。

Phase B5 本地证据：项目名、节点标题、提示词与结果备注统一接入 800 ms 空闲收口的文本事务。输入过程直接更新 canonical 文档供界面实时显示，但不逐键增加 revision、history 或 session 写入；blur、单行 Enter、多行 Enter 后、IME composition end、切页/关页/新建/载入、保存、运行、撤销重做、拖拽开始、同文档后台 success 回写及 `pagehide` / hidden / beforeunload 均先提交当前 burst。IME 候选确认 Enter 会跨 `keydown → compositionend → keyup` 保留身份并吞掉对应 keyup，避免被误判为多行提交边界；若该 keyup 丢失，下一次普通 Enter keydown 会清理陈旧抑制。事务 token 固定 `tabId + projectId + documentEpoch + field`，迟到的 blur/组合事件不能污染新页签或同容器新项目；所有运行事件在任何 durable 分支前同样完成全目标校验，旧项目 success 不能因复用同一 tab 容器而提交新项目的 IME；NodeFrame 的 Escape 仅恢复所属字段；后台页签的 durable success 独立写入该页签 history，不结束前台页签正在进行的输入或 IME 事务。新增 9 项文本事务回归，并在真实 session scheduler 中验证一个 burst 只增加一次 revision、写一次页签分片。Cloud 对 B4/B5 共提出 1 个 P1 与 4 个 P2，均已补行为回归并解决全部 5 个线程；[最终代码头 `34b3665` 精确审查](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/3#issuecomment-5409048696) 无重大问题，[CI #24](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/32836676937) 成功。完整 `npm run check`、Web/server 构建、`git diff --check` 与 0 import cycle 均通过。GitNexus 因统一边界横切所有文档 mutation 评为 critical（50 changed / 202 affected / 14 indexed files），已由历史、页签、session、保存/运行与全套隔离回归覆盖；未发送真实 AI 请求。

### C. 首次生成黄金路径

- [x] pristine 项目展示任务化启动器，至少含“上传图片开始”和“文本生成开始”。
- [x] 任务选择创建独立页签或明确替换；不静默覆盖现有画布。
- [x] 模板落地后自动 fitView，并聚焦首个缺失输入/参数节点。
- [x] Dock 开合保持 viewport，不触发自动 fit/recenter。
- [x] 节点库支持拖拽与点击添加。
- [x] 上下游快捷建图复用连接校验、只读门禁和撤销事务。
- [x] 隔离黄金路径 E2E：模板 → 输入 → stub 生成 → 运行状态 → 成功结果 → 查看/对比/继续处理。
- [x] Results 的跨项目恢复、失败、未知结果、查看和对比能力无降级。

Phase C 本地证据：空白项目任务启动器从内置模板分别提供上传图片与文本生成入口，始终新建独立项目页签并保留原空白画布；节点尺寸初始化后只执行一次模板 `fitView`，随后聚焦文件输入或提示词，普通 Dock 开合不触发重定位。节点库保留拖拽并支持相邻点击添加；Inspector 上下游快捷建图共用画布连接校验与只读/输入上限门禁，节点和边在一次文档事务内提交并可一次撤销。隔离 Playwright 黄金路径覆盖真实上传标准化、两条 stub 生成、保存与运行快照一致、运行中到成功、跨项目 Results、查看、双图对比及继续添加处理节点；全程未配置或访问真实 AI。`npm run check`、生产 Web 构建、41 项项目页签回归、12/12 Playwright 桌面回归与 `git diff --check` 通过。GitNexus 因改动画布、Inspector 与共享 Store 评为 critical（29 个已索引变更符号、84 个受影响符号）；高风险范围由全量隔离回归、三宽度既有工作台回归和新增黄金路径覆盖。

Cloud Review 首轮提出 1 个 P2：空内容项目在首次保存或从服务端重新打开后仍可能被 revision/形状误判为 pristine。修复后，成功保存和服务端载入的干净项目显式进入 `saved` 生命周期，启动器同时要求 `saveState === idle`；回归覆盖“新空白可见、保存后不可见、重开空项目不可见、编辑后不可见”。

Cloud Review 精确复审继续指出 1 个 P2：首次保存失败会进入 `saveState=error`，但并不代表项目已经持久化。最终修复把持久化身份独立为 `hasBeenPersisted`：仅服务端确认保存或载入时置为 true，失败不改变；会话分片单独保存并迁移该标记，旧草稿仅在 `saved` 或 `savedRevision > 0` 时保守推断已持久化。启动器只额外屏蔽正在保存的瞬间，保存失败后及刷新恢复后仍可使用。回归补齐失败、恢复、成功与重开路径。

### D. 结果迭代与桌面体验

- [x] 结果卡显式提供查看、对比、下载、继续处理/设为输入。
- [x] 项目、节点、状态、失败原因和未知结果清晰可辨。
- [x] current / white / eye × 1024 / 1280 / 1440 视觉回归有保存证据。
- [x] Tab、Escape、焦点恢复、Dialog/Popover focus trap、React Flow 快捷键隔离、Dock inert 通过。
- [x] 使用内置浏览器完成登录后的人工视觉验收。

Phase D 证据补录：2026-08-30 在 `main@3dc6a1d` 的已登录本地工作台完成三主题 × 三宽度矩阵，逐张检查画布、节点、Dock、MiniMap 与 Results；另行验证成功、失败、结果未知、查看、对比、下载、继续处理、主题菜单、快捷键说明、Project Center 焦点循环、Escape 焦点恢复和 1024 Dock 互斥。截图与交互记录见 [`PHASE_D_VISUAL_ACCEPTANCE.md`](PHASE_D_VISUAL_ACCEPTANCE.md)。本轮未发现必须修改的 UI，用户已完成视觉确认，并在随后明确授权合并最终发布候选 PR #17。

PR #19 补充证据：2026-08-30 在已登录本地服务上按用户反馈迭代统一左侧 Dock、悬浮节点库、横向缩放滑杆、平台化快捷键和节点拖拽稳定性；用户逐项确认后授权推送与合并。精确候选 `c8d99866d06468868920b684e90da6e367e66995` 的桌面 Playwright 29/29（1024 / 1280 / 1440）、完整 `npm run check`、生产构建、本机 `gemma4:e4b` 三组复审和 CodeRabbit 均通过；合并后 `main@bb89795b632af04e48c3246af6ada33245c7fdd4` 的 CI 33313563543 再次通过。Results 的恢复、失败、未知结果、查看、对比与继续处理边界保持不变。

### E. 生产产物与 CI

- [x] production Playwright 先构建 `dist` / `dist-server`，再以隔离 PG、DATA_DIR 和 dummy AI 启动。
- [x] 浏览器真实加载哈希 JS/CSS，覆盖登录、工作台、模板、静态路由与 SPA fallback。
- [x] CI 将生产构建和 production smoke 设为必过门禁。
- [x] E2E runner 在 SIGINT/SIGTERM 下回收 Compose、临时目录和测试锁。
- [x] 测试与正式 DB、AI 和真实密钥完全隔离。

### F. 性能与包体

- [x] 记录当前精确基线 851.73 kB minified / 267.33 kB gzip，并按 sourcemap 统计 React DOM、Base UI、XYFlow/D3、Store 与 panel 构成。
- [x] 非首屏 Compare、ImageViewer、AssetPicker、ProjectCenter 改为 lazy-load；React、Base UI、XYFlow/D3、state 与 icon 依赖稳定拆分。
- [x] 无单 chunk 超过 500 kB 的 Vite 警告；当前最大 JS chunk 为 194.27 kB minified。
- [x] 初始必须请求 JS gzip 总量 148,497 bytes，低于 210,000 bytes 预算。
- [x] 生产 smoke 显式监控 script 响应，项目中心动态 chunk 无 4xx/5xx；工作台宿主保留首次 overlay 事件与 Esc，Canvas/Dock/Results 保持挂载。
- [x] `verify-bundle-budget.mjs` 递归统计 manifest 入口静态依赖、排除 dynamic import，并作为 `build:web` / CI 失败门禁输出 `bundle-budget.json`。

Phase F 本地证据：基线为单主包 851.73 kB / gzip 267.33 kB；收口后为 11 个 JS chunk，初始必需 gzip 148,497 / 210,000 bytes，最大 chunk 194.27 kB，无 >500 kB 警告。登录壳与认证后 App 解耦，但跨账号工作区恢复信号仍由轻量模块共享；Results 保持常驻，仅查看/对比弹层按需加载。`npm run lint`、隔离 PostgreSQL `npm test`、桌面 Playwright 26/26（1024/1280/1440）、production smoke 3/3、生产 Web/server 构建与 `git diff --check` 通过；全程仅使用 dummy/stub AI。GitNexus PDG 重建后检测 30 个已索引变更符号、8 条受影响流程与 15 个已索引文件，风险为 high；高风险范围为 Workspace / ProjectTabs 的历史、文档与异步边界，已由全量回归与新增懒加载契约覆盖。

本地模型复审使用 Ollama `gemma4:e4b`，按认证/会话、受控浮层、项目中心与 Results、构建/包体门禁分组输入。认证/会话与受控浮层组明确返回 `APPROVE`；其余输出中的候选项逐条复核后均不成立（包括把刻意排除的 dynamic import 误计为首屏依赖、把已永久置真的项目中心请求标记误判为关闭时卸载、以及把 Playwright 的已卸载元素计数断言误判为未验证关闭）。最终处置为无有效 P0–P3 阻塞项；不触发或等待 Codex Cloud。

### G. 文档与发布准备

- [x] README、环境变量、管理员安装、macOS 部署、备份恢复、迁移、故障、安全和桌面矩阵更新。
- [x] 首次安装、登录、改密、项目恢复、任务恢复和失败处理流程明确，并由隔离认证/恢复回归覆盖。
- [x] `dist` / `dist-server` 和 Playwright 报告不受版本控制；Docker/macOS/CI 现场构建。
- [x] `npm audit` 无未处置高危漏洞。
- [x] 发布候选 PR 附摘要、风险/回滚、测试矩阵、视觉证据、包体、GitNexus、CI 与本地精确 SHA 复审。
- [x] 用户明确确认最终合并后，main 合并后 CI 再次成功。

Phase G 本地证据：2026-08-30 新增部署运维手册、发布清单和 Phase D 视觉证据，校正 Compose 宿主机端口与进程内限流说明。`npm ci`、`npm audit`（0 漏洞）、`npm run check`、`npm run build` 与 production smoke 3/3 通过；桌面 E2E 首轮在 1440 项目中心 Tab 切换后过早读取卡片几何，出现 1 项测试同步失败，增加卡片可见同步点后全量重跑 26/26 通过，未修改产品 UI。另以一次性 PostgreSQL 18 容器和 `/tmp` 目录完成 dump→新库 restore 与 `DATA_DIR` 归档→恢复校验，随后清理全部隔离资源。发布候选 `fbdff19193bff4dbdbc8b33dc416bcea1aa451d4` 经本机 `gemma4:e4b` 精确复审为 `APPROVE`，PR head CI 通过；用户明确授权后，PR #17 合并为 `c23f4174865dda827f969219e035f55c3038a2e8`，新的 main CI 33269171028 再次成功。全程仅使用 dummy/stub AI。

Phase G 完成后的 PR #19 属于已确认的桌面 UI 收口，不改变部署、恢复、安全、数据库或 AI Provider 边界；其最新产品基线、回归、审查与合并后 CI 证据由 PR #18 回填。PR #18 随后合并为 `a6282818bf0f29f8217c473e6f1a55a13b58b276`，main CI 33315734726 通过；用户另行授权的 `v0.1.0` tag 与 GitHub Release 已精确发布在该提交。生产部署仍等待单独授权。

## 每阶段门禁与证据

每个阶段至少记录以下结果；不适用项必须说明原因，不能留空后宣称完成。

| 门禁 | 最新结果 | 证据/备注 |
| --- | --- | --- |
| `npm ci` | 通过 | 2026-09-01 `main@4701280` 合并后门禁；安装 482 个包、审计 483 个包，未使用真实 AI 配置 |
| `npm test` | 通过 | 2026-09-01 `main@4701280` 合并后门禁；隔离 PostgreSQL 全套回归，包含包体预算、懒加载边界与 Codex 门禁行为契约；仅使用 dummy/stub AI |
| `npm run test:e2e` | 通过 | 2026-09-01 `main@4701280` 合并后门禁为 30/30；覆盖 1024、1280、1440 桌面项目、登录、独立黄金路径、初始项目恢复与拖拽/同步提示稳定性；临时 PostgreSQL + dummy/stub AI |
| production browser smoke | 本地通过 | 2026-09-01 `main@4701280` 合并后门禁的 production smoke 3/3；真实哈希产物、动态 chunk、项目中心与 SPA fallback 均通过 |
| `npm run build` | 通过 | 2026-09-01 `main@4701280` 合并后门禁；Web + server；PR #22 精确 head 的初始 JS gzip 为 147,188 / 210,000 bytes |
| `npm audit` | 通过 | 2026-09-01 `main@4701280` 合并后门禁：`found 0 vulnerabilities` |
| `git diff --check` | 通过 | 2026-09-01；精确候选差异与合并后提交均未发现空白错误，`dist` / `dist-server` 仍为忽略产物 |
| 隔离恢复演练 | 通过 | 一次性 PostgreSQL 18 容器完成 custom dump→新库 restore；临时 `DATA_DIR` 完成 tar→restore 与逐文件一致性校验；当前服务与真实数据未触碰，隔离资源已清理 |
| GitNexus `detect_changes` | 已执行 | 2026-09-01 `main@4701280` 索引已同步；对 `d942885...4701280` 的比较为 8 个索引文件、64 个变更符号、0 条受影响流程、low risk，并由 30/30 桌面回归和完整隔离测试覆盖 |
| GitHub CI | 已退役 | 历史上 [PR #19 head CI 33312678619](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/33312678619)、[产品合并后 main CI 33313563543](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/33313563543) 与[文档收口后 main CI 33315734726](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/33315734726) 均通过；PR #22 起不再把 GitHub Actions 作为当前 main 的门禁证据 |
| 本地模型复审 | 当前 main 精确 SHA 通过 | 2026-09-01 Codex 配置的默认模型对 `d942885...4701280` 精确差异返回 `pass`、0 个 P0-P3 findings；GitNexus 同步返回 pass；未触发或等待 Codex Cloud |
| 视觉证据 | 已采集并经用户确认 | Phase D 的三主题 × 三宽度共 9 张工作台截图及失败/未知 Results 证据继续保留；PR #19 的最新 Dock、缩放、快捷键与拖拽修正另由已登录本地服务逐项确认 |

## 已知风险与决策日志

| 日期 | 项目 | 结论/后续动作 |
| --- | --- | --- |
| 2026-08-24 | Store 双数据源与隐式同步 | Phase A 先以行为测试锁住撤销/选择不变量；Phase B 再迁移到 `DocumentSnapshot` 单一数据源，避免一次性大爆炸重写。 |
| 2026-08-24 | 运行态污染文档历史 | 先审计 zundo partialize、SSE/runtime 写回和成功输出边界，再建立显式 history API。 |
| 2026-08-24 | 浏览器自动化只覆盖开发服务器 | Phase E 增加真实 production bundle smoke，作为后续拆包保护门。 |
| 2026-08-24 | 主包约 721 kB / 230 kB gzip | Phase F 先测量，再 lazy-load 与拆包；禁止仅提高警告阈值。 |
| 2026-08-24 | shadcn/Base UI 使用边界 | 用户确认可结合仓库使用；优先复用现有 UI primitives 承担通用弹层、Tabs、Tooltip 与焦点管理，继续由 `data-theme` / `--gc-*` 和业务 Store 掌管主题与状态。 |
| 2026-08-24 | Phase A 每页签撤销历史 | zundo 继续挂载活动文档，非活动页签使用进程内 past/future 栈换入换出；历史不跨刷新持久化，项目文档与会话恢复仍由 Phase B 收敛。 |
| 2026-08-24 | 中断拖拽瞬态 | blur、pointercancel、卸载均提交最后可见位置并清除 `dragging`；历史 Undo→Redo 与会话恢复都不得重新引入永久拖拽态。 |
| 2026-08-24 | 大型节点拖拽性能 | Cloud 首轮 P2 指出每帧序列化完整 mask payload；改为字段级相等性与共享值短路，并以 `toJSON` 探针保证位置检测不触发大型 data 序列化。 |
| 2026-08-24 | 拖拽会话原子性 | Cloud 第二轮 P2 指出中间坐标可能以 clean/saved 元数据落 session；事务中改为 deferred persistence，在 end/cancel 所有稳定出口补写，并覆盖无位移、净零位移、并发 success、失败重试与切页取消。 |
| 2026-08-24 | 空白画布上下文 | Cloud 第二轮 P2 指出关闭 Result viewer 后上下文粘住；空白 pane 统一调用 canonical selection command，清节点与结果选择但保留独立 compareIds，且不写文档历史。 |
| 2026-08-25 | 拖拽期间显式保存 | Cloud 第三轮 P2 指出 Ctrl/Cmd+S 可能写入中间坐标；保存、首次付费运行与撤销/重做统一等待真实 dragStop/cancel 后按 FIFO 执行，保存固定到发起页签，切页/关闭时安全取消。 |
| 2026-08-25 | 保存重试与手势身份 | 显式保存重试使用独立 generation，不与 revision 自动补写混用；同快照成功不多发第三请求。拖拽以原生事件 `timeStamp` 隔离旧 stop 与新手势，取消后的迟到位置帧不会污染新页签或拆散历史。 |
| 2026-08-25 | 纯文档持久化边界 | 项目、模板、运行计划与浏览器草稿统一使用严格白名单 `DocumentSnapshot`；运行态在 wire 层固定为 idle。合法 v0/v1 内置模板保留，已知损坏或不兼容的历史 builtin 由当前定义受控修复，用户模板不受影响。 |
| 2026-08-25 | 活动文档消费边界 | B2 先以叶子 selector 收口 React 订阅，命令式复合读取使用 `selectActiveDocument` / `selectDocumentForTab`。组件不直接订阅会构造新对象的复合 selector；B3 仅替换 selector 内部数据源即可移除镜像字段。 |
| 2026-08-25 | 异步素材回写 | 印花素材保存在发起请求前固定 `tabId`，成功后使用 `updateNodeDataInTab` 回写原页签；请求期间切页的回归已覆盖。 |
| 2026-08-25 | canonical tabs 与 zundo 回放 | 顶层活动文档镜像与同步 subscriber 已删除。zundo 继续保管每页签 past/future，但不再将 partial snapshot 直接合并到根 Store；所有回放原子替换活动 `ProjectTab`，并保留 runtime、selection、edge selection 与 React Flow 测量瞬态。 |
| 2026-08-25 | 同页签整体换项目的异步身份 | 仅固定 `tabId` 仍可能让旧保存、运行或上传响应写入同一容器中的新项目；异步边界统一改为捕获并校验 `tabId + projectId + documentEpoch`，保存队列和运行准备键也使用完整身份。 |
| 2026-08-25 | 切页取消拖拽回滚 | 取消事务回到起点时显式不保留 `dragging`，并直接断言后台 canonical 页签内存状态，避免依赖 session sanitize 掩盖永久拖拽态。 |
| 2026-08-25 | 分片草稿与发布边界 | manifest 只引用已确认存在的页签分片；单页签 quota 失败不得阻断健康拓扑，manifest 发布或 legacy 迁移未完成时保留上一完整恢复点。 |
| 2026-08-25 | Storage 读异常与账号安全 | `getItem` 抛错是归属/存在性未知，不能降级为缺失并清理。启动恢复不完时 fail-closed 停 writer；认证绑定期间读失败则通过重载隔离已恢复内存画布。 |
| 2026-08-25 | 连续文本事务 | 输入时只更新 canonical 字段；800 ms 空闲或明确边界才写一次 history/revision/session。所有 token 固定文档与字段身份，IME 期间暂停计时，后台 success 等非文本 mutation 必须先收口文本以保持撤销顺序。 |
| 2026-08-25 | 恢复页签的活动任务锁 | 纯文档草稿不会持久化 runtime status，因此历史/活动任务对账完成前不能相信节点的 idle。冷启动安全门同时封锁新付费运行和页签关闭；同步失败保持 fail-closed，重试成功后统一解锁。 |
| 2026-08-25 | 首次生成任务落地 | pristine 启动器只识别从未编辑的初始空白项目；任务和模板始终新建页签，避免覆盖现有画布。一次性 landing 意图只驻留内存，在节点尺寸就绪后执行 fit/聚焦，不进入文档、撤销或草稿。 |
| 2026-08-25 | Results 保留边界 | Phase C 只增加启动、建图和黄金路径，不移动或削弱跨项目 Results；失败、未知状态、恢复、查看与对比继续由现有全局记录和回归保护。显式结果后续动作留在 Phase D 完善。 |
| 2026-09-01 | GitHub Actions 门禁退役 | PR #22 将门禁切换为精确 SHA 绑定的本地确定性套件、GitNexus 和 Codex 默认模型结构化复审；合并后 `main@4701280` 已完成确定性复跑与退出码 0 的模型复审补跑。 |

## 更新规则

1. 实现或验证完成后，在同一提交中更新本台账。
2. PR、CI、本地精确 SHA 复审和截图必须填写可追溯 URL、提交 SHA 或文件路径。
3. 失败门禁保留失败原因与修复提交，不覆盖历史事实。
4. 未经用户确认，不把阶段 PR 或最终发布候选 PR 合并到 `main`。
