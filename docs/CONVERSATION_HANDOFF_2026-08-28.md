# Garment Canvas 交接文件

> 用途：将当前项目状态完整交给下一次 Codex/ChatGPT 对话继续推进。
>
> 更新时间：2026-08-28（Asia/Shanghai）
>
> 状态说明：这是 2026-08-28 的历史交接快照，不是当前规则源。长期规则与
> 冲突处理统一以仓库根目录 [`AGENTS.md`](../AGENTS.md) 为准；分支、SHA、PR、
> CI 和运行状态必须实时核对。

## 1. 项目身份与工作边界

- 产品：Garment Canvas（服装设计协同工作台）。
- 仓库：`zzzfan008-rgb/kittin-saas-b-v2`。
- 本地路径：`/Users/lionfan/Documents/ChatGPT/无限画布/garment-canvas`。
- 远程仓库：[GitHub 仓库](https://github.com/zzzfan008-rgb/kittin-saas-b-v2)。
- 当前分支：`codex/phase-e-production-smoke`。
- 当前代码基线：`origin/main@9ca0fd18d38e09b471651aff9924cd0329a484d1`；历史 SHA 仅作背景，不作为现状判断。
- 当前 PR：[PR #11](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/11)；当前 head 必须通过实时 PR API 查询。
- PR 基线（`main`）：`9ca0fd18d38e09b471651aff9924cd0329a484d1`。
- PR 状态：OPEN、MERGEABLE；Phase E 代码头 `50e119a960c75a06264c7db3b3e687754e950c22` 的 GitHub CI 与 CodeRabbit 已通过，最终合并仍需用户单独授权。
- 当前审核流程：用户已明确要求后续不再等待或触发 Codex Cloud 审核；本地测试、GitNexus、CI、精确 head/base 核对和用户合并确认门禁保持不变。

### 产品硬约束

1. 产品是桌面端，不做移动端适配；支持下限为 1024 CSS 像素，主要验收宽度为 1280 与 1440。
2. 用户要求任何 UI 或交互逻辑修改，在实际编辑前先给方案并等待确认。已明确确认的当前任务才可继续实现。
3. `Results`/结果能力不能删除或弱化，它负责跨项目运行恢复、失败状态、未知结果、查看和对比。
4. 本地浏览器测试允许独立登录并挤掉其它登录会话，但仅限本项目测试；不得修改密码或无关账号/安全设置。
5. 生产数据源是 PostgreSQL 18；SQLite 仅用于旧数据导入和迁移验证。
6. 不把 `.env`、PAT、AI 网关密钥、上传文件、数据库 dump、运行时目录和构建产物提交到 Git。

## 2. 技术栈与架构速览

- 前端：React 19 + TypeScript + Vite 6。
- 画布：`@xyflow/react`。
- 状态：Zustand 5；zundo 只负责每页签撤销/重做记录器。
- 后端：Express 4 + Node.js 22.20+。
- 数据库：PostgreSQL 18；Docker Compose 为推荐运行方式。
- AI 图片：API易网关；服务端调用，客户端不得接触网关密钥。
- 样式：Tailwind CSS 4 + `@tailwindcss/vite`；项目已经完成 Tailwind 4 迁移。
- UI：已引入 shadcn 生成的通用 primitives，底层基于 `@base-ui/react`；当前目录为 `src/components/ui/`。
- 主题：由 `data-theme` 与 `--gc-*` 变量控制；业务状态仍由 Store 控制，不要让 shadcn 组件接管主题状态。

### 关键目录

| 目录/文件 | 责任 |
| --- | --- |
| `src/App.tsx` | 应用壳、认证后路由和工作台入口 |
| `src/store/flowStore.ts` | canonical `ProjectTab[]`、文档 mutation、选择、历史和运行态边界 |
| `src/initialDraft/` | 初始草稿生命周期、恢复和 pristine 启动器判定 |
| `src/components/panels/TopBar.tsx` | 顶部栏、项目入口、主题及全局操作 |
| `src/components/panels/ProjectTabs.tsx` | 页签、项目名编辑和页签切换 |
| `src/components/panels/ProjectCenter.tsx` | 最近项目、我的模板、内置模板、创建/打开项目入口 |
| `src/components/TaskLauncher.tsx` | 新空白项目的任务启动器和内置模板卡片网格 |
| `src/lib/templatePresentation.ts` | 六个内置模板的名称、简介、封面和展示元数据 |
| `src/lib/templateLaunch.ts` | 模板创建页签和落地工作流 |
| `src/components/nodes/MaskEditor.tsx` | 蒙版编辑、Alpha 保真和保存动作 |
| `src/lib/maskGeometry.ts` / `src/lib/maskRedraw.ts` | 蒙版尺寸、羽化、扩展和动作就绪判定 |
| `server/routes/projects.ts` | 项目读写、恢复、保存和权限 |
| `server/routes/templates.ts` | 内置模板/用户模板、我的模板生命周期 |
| `server/routes/files.ts` | 图片、蒙版上传和所有权校验 |
| `server/engine/runQueue.ts` / `server/engine/runner.ts` | 生成队列、Provider 调用和结果持久化 |
| `src/auth/session.ts` | 页签会话草稿、manifest v2 和跨账号清理 |
| `tests/` | PostgreSQL 隔离回归、Store/文档/蒙版/权限测试 |
| `e2e/` | 桌面 Playwright 回归和黄金路径 |

## 3. 已完成的主要工作

### A–B：文档、页签、会话和历史边界

- `ProjectTab[]` 已成为活动文档和后台页签的唯一真相，删除了顶层活动文档镜像和同步 subscriber。
- `DocumentSnapshot` 严格白名单序列化；选择、viewer、compare、运行态、React Flow 测量值和临时 UI 不进入项目文档。
- 异步保存、运行、上传和素材回写统一捕获并验证 `tabId + projectId + documentEpoch`，防止切页或同页签换项目后的迟到响应污染新项目。
- 会话草稿使用 v2 manifest + 每页签分片，支持 debounce/idle 写入、pagehide/hidden 收口、单页签 quota 隔离和跨账号清理。
- 文本输入采用 800ms 空闲收口的文本事务，支持 Enter、blur、IME、切页、关闭、运行和撤销边界。
- 保存失败与已持久化身份分离；失败不会误判项目已保存，刷新后可继续使用。

### C：首次生成黄金路径

- 初始空白项目显示任务化启动器，不再在新页面直接塞一个无意义的技术节点。
- 启动器包含上传图片、文本生成和全部六个内置模板；模板始终在启动器中可见。
- 模板落地后只执行一次 `fitView` 并聚焦首个缺失输入/参数节点。
- 模板始终创建独立页签，不静默覆盖已有画布。
- 节点库支持拖拽和点击添加；Inspector 上下游快捷建图复用连接校验、只读门禁和撤销事务。
- Results 的跨项目恢复、失败、查看、对比能力保持不变。

### 项目中心与模板生命周期

- 顶部栏/项目导航已重构为 `Coin AI - Canvas` 方向的工作台布局。
- 项目名在页签中双击编辑；保存动作只在编辑状态激活，支持点击保存或 Enter。
- 顶部新增/打开入口合并到页签栏 `+`，可选择新建项目或打开已有项目。
- 已有项目登录后默认恢复最近保存项目，不再每次强制创建新的空白项目。
- “最近项目”不展示内置模板；“我的模板”单独作为页签展示。
- 用户模板创建、载入、删除、失败恢复和所有权边界已有服务端保护。
- 初始草稿在关闭/离开时自动保存并进入命名流程；已保存的项目不会再次被判定为 pristine 初始草稿。

### 六个内置模板案例图

已生成六张本地封面，统一使用亚洲年轻女性、韩系简约服装方向，并按具体工作流表达步骤；历史远程提交曾使用 PNG，当前工作树改为 WebP：

```text
public/assets/project-center/templates/
├── text-to-image.webp
├── text-recolor.webp
├── sketch-recolor.webp
├── sketch-upscale.webp
├── pattern-style-transfer.webp
└── person-scene-transfer.webp
```

交接后的修正已推送到远程 PR；后续状态以实时 PR head/base 查询为准：

- 六张封面统一转为同尺寸 WebP，保留可读性并显著降低首屏资源体积。
- 启动器按模板节点类型传递 `upload`/`text` 落地模式；其它调用仍保留 `default`。
- 黄金路径直接验证文件选择器事件和提示词全选状态。
- `text-to-image` 的历史视觉修正仍保持：左侧为放大的纯文字提示词，右侧为服装生成图。

## 4. 当前 PR 与审核状态

PR #10 的提交链：

1. `d5958d2`：启动器展示完整内置模板卡片。
2. `efae3fb`：增加流程型模板封面与中文简介。
3. `40e102d`：按实际工作流刷新六张案例图。
4. `7f7897b`：修正文生图封面为严格左右两端结构。
5. `cce4f14`：补充本项目交接文档（该提交是当前远程 PR head，后续仍以实时查询为准）。
6. 后续修正：启动器与项目中心按模板节点类型传递 `upload`/`text` 模式；六张封面统一使用 WebP，并补齐前端与桌面回归断言。

Cloud/Codex 的历史复审曾对 `d5958d2`、`40e102d` 给出“未发现重大问题”。对历史远程 head `cce4f1460c76acca4c1cd740f02e825dbfc1dab5` 的精确复审曾返回以下待处理意见；对应修正已完成并推送。以下仅作历史证据，不构成当前审核门禁：

- P1：启动器卡片没有显式传递模板模式，导致文本模板不会全选提示词、图片模板不会激活文件选择器；修复已推送，待新 head 的精确复审确认。
- P2：六张未哈希 PNG 会增加无缓存首屏体积；已转换为 WebP，待新 head 复审资源加载和视觉质量。
- P2：`text-to-image` PNG 体积偏大；已由 WebP 处理。
- P1：交接文档曾硬编码旧 SHA；本文件现改为“历史基线 + 动态查询”规则。

历史 CI 在 `cce4f146...` 上通过；当前 head 的 CI 必须以实时查询结果为准，Codex Cloud 不再作为当前门禁。

CodeRabbit 对原 PNG 资源因默认路径过滤跳过，并不代表图片已完成审查；WebP 变更推送后仍需关注资源加载、可读性、包体和视觉回归。

### 合并规则

- 新 PR 仍需实时核对 `headRefOid`、`baseRefOid`、本地测试、GitNexus 与 GitHub CI；历史 SHA 只作历史证据。
- 不再请求或等待 Codex Cloud Review；合并、打 tag、发布和部署仍需用户明确确认。

## 5. 验证命令与已知证据

在仓库根目录运行：

```bash
# 本地开发
npm run dev

# 类型检查
npm run lint

# 完整检查：lint + Web 构建 + 隔离 PostgreSQL 回归
npm run check

# Web + server 生产构建
npm run build

# 桌面 Playwright（首次需要 npx playwright install chromium）
npm run test:e2e

# 生产依赖启动
npm start
```

本次本地修复的验证证据：

- `npm run lint`：通过。
- `npm run check`：通过（包含完整 PostgreSQL 隔离回归套件）。
- `npm run build`：通过；Web 主包 `848.67 kB` minified / `266.39 kB` gzip，CSS `112.83 kB` / `19.06 kB` gzip；仍有单 chunk >500 kB 的既有警告。
- `npm run test:e2e`：23/23 通过（含文件选择器事件和提示词全选断言）。
- 六张 WebP 源资源总计 `1,033,748` bytes，构建产物同值；相对历史 PNG 总计 `11,815,324` bytes，体积减少约 `91.25%`。每张保持 `1586×992`，旧 PNG 已从工作树移除。
- `git diff --check`：通过。
- GitNexus 已执行 `analyze --index-only --pdg` 并刷新到当前分支代码基线；`detect_changes` 识别 6 个代码/文档变更文件、9 个受影响流程，风险级别为 HIGH（另有 6 个 WebP 新增与 6 个 PNG 删除资源；主要代码风险来自 TaskLauncher 落地链路，已由上述回归覆盖）。
- 远程 PR 的 CI 与 Codex 结论只对对应精确 SHA 有效；每次推送后必须重新查询 head 并重新请求精确复审。

历史 Phase C 验证也已通过：`npm run check`、12/12 桌面 Playwright 黄金路径、PostgreSQL 隔离测试、生产 Web/server 构建和 `npm audit`。

## 6. 下一阶段优先级

### P0：推进 Phase E 生产证据链

1. 先构建 `dist` / `dist-server`，再用隔离 PostgreSQL、DATA_DIR 和 dummy AI 启动生产服务。
2. 用 Playwright 验证哈希 JS/CSS、登录、工作台、模板、静态路由和 SPA fallback。
3. 将 production smoke 与生产构建接入 CI，并验证 SIGINT/SIGTERM 清理。
4. 当前 `npm run test:e2e:production`、`npm run check`、`npm run build` 与 PR #11 首个代码头 CI 均已通过；等待用户单独授权合并。

### P1：Phase D 结果迭代和桌面视觉验收

- 结果卡补齐并验证：查看、对比、下载、继续处理/设为输入。
- 检查项目、节点、状态、失败原因和未知结果的可读性。
- 采集 `current`、`white`、`eye` 三主题在 1024/1280/1440 的视觉证据。
- 用内置浏览器登录后完成人工验收：项目恢复、模板启动、运行状态、Results、蒙版和主题切换。
- 任何新 UI/交互方案先向用户确认。

### P1：生产构建与 CI 门禁（Phase E）

- 先构建 `dist` / `dist-server`，再使用隔离 PostgreSQL、DATA_DIR 和 dummy AI 启动。
- 验证真实 hash JS/CSS 加载、登录、工作台、模板、静态路由和 SPA fallback。
- 将 production smoke、生产构建和桌面回归设为 CI 必过门禁。
- 验证 E2E runner 在 SIGINT/SIGTERM 下能回收 Compose、临时目录和测试锁。

### P2：包体和性能（Phase F）

- 重新记录当前构建的主包 minified/gzip 基线；交接前一次本地构建观察值约为 848.50 kB / 266.35 kB，且仍有单 chunk >500 kB 警告。
- 对非首屏 overlay、React、Base UI、XYFlow/D3 和业务模块做测量后再拆包。
- 目标：初始 JS gzip 总量不高于 210 kB，并消除单 chunk >500 kB 警告。
- 拆包后验证无 chunk 404、闪烁、状态丢失或 Canvas/Dock/Results 重挂。

### P2：发布准备（Phase G）

- 更新 README、环境变量、管理员安装、macOS 部署、备份恢复、迁移、故障、安全和桌面矩阵。
- 保持 `.env.example` 是公开配置契约；私有 `.env` 只在本机使用。
- 发布候选必须包含摘要、风险/回滚、测试矩阵、视觉证据、包体、GitNexus 和 CI；不再要求 Cloud Review。
- 用户明确确认后才合并到 `main`；合并后再次确认 main CI。

## 7. 开新对话时可直接使用的启动提示词

```text
你接手的是 Garment Canvas 仓库：
/Users/lionfan/Documents/ChatGPT/无限画布/garment-canvas

请先阅读：
1. AGENTS.md
2. docs/CONVERSATION_HANDOFF_2026-08-28.md
3. docs/PROJECT_COMPLETION.md
4. README.md

当前分支 codex/task-launcher-template-gallery；交接前历史基线为
7f7897b0246a8676f1bd996a61d144c9b0a97fdd，PR #10 为 OPEN，不能自行合并；当前 head/base 必须实时查询。
最新已推送修正将六张模板封面改为 WebP，并让启动器与项目中心按模板类型传递 upload/text 模式；text-to-image 仍保持严格左右两端结构：
左侧放大纯文字提示词，右侧服装生成图。

继续工作前请：
- 先查看 git status、PR #10 的精确 base/head SHA 和 CI 状态；
- 如需修改代码，先用 GitNexus query/context/impact 做结构和影响分析；
- 任何 UI 或交互逻辑修改先给我方案，等待我确认后再编辑；
- 运行 npm run check、npm run build 和相应桌面回归；
- 提交前运行 GitNexus detect_changes；
- 不要泄露或提交 .env、GITHUB_PAT、AI 密钥和运行数据；
- 不要自行合并 PR，必须等我明确确认。

当前建议从 P0 开始：检查 PR #10 最新精确 head/base 与 CI，然后推进 Phase D
结果迭代与三主题桌面视觉验收。
```

## 8. 交接注意事项

- GitNexus 索引必须与当前 HEAD 对齐；若状态提示落后，在进行代码结构分析前刷新索引：

  ```bash
  node .gitnexus/run.cjs analyze --index-only --pdg
  ```

- 若增量分析报告 `FTS index ... is inconsistent`，可先运行 `gitnexus clean --force`，再运行 `gitnexus analyze --force --pdg` 重建被忽略的本地索引；这不会改动产品工作树。

- `npm run test` 使用隔离 PostgreSQL 测试容器，不要改成在同一工作区手动运行 `docker compose -f compose.test.yaml`。
- 不要把 `CODEX_REVIEW_HANDOFF*.md` 中的旧基线误认为当前分支基线；本文件和实时 Git/PR 查询优先。
- 内置模板图属于二进制资源，CodeRabbit 可能因路径过滤跳过；必须用浏览器或 `view_image` 做视觉检查。
- 如遇页面异常，先保留本机画布数据，优先重新加载；不要直接清除当前页签，除非确认页签数据损坏且用户同意。
