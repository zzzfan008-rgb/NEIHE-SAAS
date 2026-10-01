# Image Workbench — 原版完整迁移包

这是 **React 19 / TypeScript + Node.js / Express + PostgreSQL** 源码套件，不是 Rust/Go 重写版，也不含任何 `coin-ai-agent` 宿主适配。

三个节点和侧栏对话的组件、业务状态、服务端执行、鉴权及持久化依赖均保留在本目录。安装、构建和运行不需要 NEIHE-SAAS 的其他目录，也不需要旁边的 `image-workbench-core`。

交付形态是可嵌入的前端库和可独立启动的 API 服务，**不是带导航、项目菜单和布局的独立成品页面**。尚未将原项目切换为使用本包。

## 1. 功能与源码入口

| 功能 | 原版入口 | 保留内容 |
| --- | --- | --- |
| 3D 视角 | `src/components/nodes/TiAngelNode.tsx` | Three.js 懒加载预览、角度/镜头提示词、生成参数、连线和结果写回 |
| 人物姿势参考图 | `src/components/nodes/ImageInputNode.tsx` + `src/components/pose/PoseEditorDialog.tsx` | 必须使用 `poseReference: true` preset；上传、姿势编辑、IK、撤销/重做、参考图生成与保存 |
| 背景板生成 | `src/components/nodes/BackgroundExtractNode.tsx` | 原节点的背景板生成/提取流程、输入图尺寸、模型参数、任务和结果 |
| 侧栏多轮对话修改 | `src/components/conversation/ConversationPanel.tsx` | 单图/多图、蒙版、规划/澄清、执行、继续修改、分支、未知结果对账与恢复 |

配套能力包括结果查看、对比、下载、设为输入、跨项目恢复，以及素材选择、连接角色确认、账号会话和文档草稿恢复。共享 Store、执行器和数据模型保留必要的关联实现，并未为了减少文件数量删掉恢复/权限逻辑；这不代表导出了原产品的所有工具或页面。

## 2. 环境与独立安装

- Node.js **22.20.0+**，pnpm **11.19.0**；本包包含独立 `pnpm-lock.yaml`。
- 前端 **React / React DOM 19**。本完整套件尚不承诺 React 18 兼容；不要使用 `--force` 或忽略 peer dependency 冲突。
- PostgreSQL **18**，独立数据库和可写数据目录。SQLite 仅保留在原有导入/验证依赖中。
- 桌面端，最小宽度 1024 CSS px；布局应按 1024 / 1280 / 1440 验收。
- AI 需要服务端 HTTPS 网关和凭据，不能在前端传递或存储密钥。

将整个 `image-workbench/` 目录复制到任意位置后：

```sh
cd image-workbench
corepack pnpm install --frozen-lockfile
npm run build
```

`build` 生成：

- `dist/`：React ESM 库、懒加载分块和 `styles.css`。
- `dist-types/`：前端及服务端公开类型。
- `dist-server/app.js`、`dist-server/cli.js`：Node API 库和 CLI。

原生依赖 `sharp`、`better-sqlite3` 须在目标 OS/CPU/Node 环境安装；不要跨系统复制 `node_modules`。首次安装需要网络，可能需要本机 C/C++ 编译环境。`pnpm-workspace.yaml` 仅允许这两个依赖及 esbuild 的安装构建。

## 3. 后端启动

1. 准备新的 PostgreSQL 数据库及专用账号，不要直接指向源项目或宿主生产数据库。
2. 根据 `.env.example` 手动配置本包根目录的 `.env`，或注入同名环境变量。已有 `process.env` 优先。
3. 必填 `DATABASE_URL`、`INITIAL_ADMIN_ACCOUNT_ID`、`INITIAL_ADMIN_PASSWORD`、`APIYI_BASE_URL`、`APIYI_API_KEY`。管理员参数用于空库初始化，密码 10–200 位且含字母和数字；首次登录强制改密。
4. `DATA_DIR` 用独立目录，持久保存上传、蒙版、素材及生成输出；备份时同时备份数据库和该目录。
5. 执行：

```sh
npm start
```

示例配置监听 `127.0.0.1:3010`，不占用原项目的 3002。容器内对外监听时明确设置 `HOST=0.0.0.0`，并通过可信反向代理限制暴露范围。生产使用 HTTPS，并设置 `COOKIE_SECURE=true`。

- `/api/health`：进程存活。
- `/api/ready`：数据库、管理员、可写目录和 AI 配置检查；不会发起真实 AI 请求。
- API-only：本服务不托管前端 HTML，也不提供 SPA fallback。
- 启动初始化原数据库 schema、清理过期会话/素材草稿、恢复原任务 Worker。
- 每个进程只有一套数据库、Store 和 Worker 生命周期；不要在一个进程创建多个不同租户实例，也不要在同一数据库上随意启动多个 Worker。

SDK 用法：

```ts
import { startImageWorkbenchServer } from '@garment-canvas/image-workbench/server';
const { server } = await startImageWorkbenchServer(3010, '127.0.0.1');
// server.close() 结束监听时会停止本实例 Worker 和定时清理。
```

`createImageWorkbenchApp()` 只构建路由，不连接数据库、不启动 Worker，供已有生命周期的服务或测试使用；普通使用选择 `startImageWorkbenchServer()` / CLI。

## 4. 前端公开接口与装配契约

```ts
import '@garment-canvas/image-workbench/styles.css';
import {
  WorkbenchSession,
  WorkbenchRecoveryNotice,
  WorkbenchResults,
  ConversationPanel,
  imageWorkbenchNodeTypes,
  addPoseReferenceNode,
  useFlowStore,
  selectActiveNodes,
  selectActiveEdges,
} from '@garment-canvas/image-workbench/react';
```

**容器负责布局，包负责这些功能的原业务链路。** 不要只挂三个节点而省略 Runtime、结果和对话恢复：

1. 整个已登录工作区挂一个 `WorkbenchSession`。它包含原 `AuthProvider`、登录/首次改密/会话替换处理及 `WorkbenchRuntime`，不要重复嵌套 Runtime。
2. 在其内部放置 `WorkbenchRecoveryNotice`、画布、`ConversationPanel` 和 `WorkbenchResults`。`WorkbenchResults` 应保持挂载；隐藏面板用容器可见性，不要丢弃结果状态。
3. 画布使用 `@xyflow/react`，`nodeTypes={imageWorkbenchNodeTypes}`。原始类型键是 `ti-angle`、`image-input`、`background-extract`、`result`。每个活动画布使用对应的 `ReactFlowProvider`。
4. `nodes` / `edges` 从 `useFlowStore(selectActiveNodes)` / `useFlowStore(selectActiveEdges)` 读取；`onNodesChange`、`onEdgesChange`、`onConnect`、`isValidConnection` 接同名 Store action。不要另设一份持久化节点数组。
5. 选择变化调用 `setSelectedNodeIds`；创建节点用 `addNode`。人物姿势入口用 `addPoseReferenceNode({ x, y })`，普通图片入口用 `addNode('image-input', position)`。
6. 容器画布保留 `role="application"`、`aria-label="工作流画布"` 和可聚焦元素，供连接角色弹窗恢复焦点。
7. `ConversationPanel` 的 `onCollapse`、`intent: { seq, wasOpen }` 对接容器的本地开关状态；不写入文档、撤销栈或业务 Store。再次从选中图进入对话时递增 `seq` 并传入原先的 `wasOpen`。
8. 同源代理 `/api/*` 到本包 API，并保留 Cookie、SSE 流和上传大小限制。当前客户端使用固定同源 `/api`，没有虚构的 `baseUrl` 或宿主身份令牌适配器；不要用宽泛 CORS 替代权限检查。

Runtime 内含历史对账门禁、分页加载、草稿恢复、连接角色确认、查看器、对比、素材选择、生成记录弹窗和 Tooltip 上下文。主题仍由 `data-theme` + `--gc-*` 管理；样式是原版**全局样式**，不是 Shadow DOM 隔离样式，同页混入其他设计系统前须核对样式影响。

`WorkbenchRuntime({ userId, children })`、`AuthProvider`、`useAuth` 也独立导出，但 `userId` 只是前端生命周期键，**不授予后端权限**。直接使用 Runtime 时，必须仍有有效的本包 Cookie 会话，并由外层处理会话失效和账号切换。宿主 SSO/账号映射不在本次交付范围。

## 5. API 与安全边界

完整路由见 `server/app.ts`，契约见各路由及 `src/types/`：

- `/api/auth`：登录、会话、改密、注销和原账号管理权限。
- `/api/projects`、`/api/files`、`/api/assets`：文档、上传、素材和所有权保护。
- `/api/pose-references`：姿势分析及参考图任务。
- `/api/run-plan`、`/api/generate`：原执行队列、重连与结果恢复。
- `/api/image-conversations`：对话、轮次规划、确认执行、重试及未知结果对账。
- `/api/history`、`/api/history/active`、`/api/usage`：全局结果恢复和使用记录。
- 关联的颜色、提示词优化、素材分析、绘图板等原依赖路由随包保留。

保留 `requireAuth` / `requirePasswordChanged`、资源 owner/admin 检查、单设备会话、哈希 Token、事务与引用删除保护。异步写回绑定 `tabId + projectId + documentEpoch`；未知结果不得当成失败自动重复扣费重跑。`ProjectTab[]` 和 `DocumentSnapshot` 仍是文档边界。

## 6. 可选姿势/深度辅助服务

`scripts/pose/`（DWPose）和 `scripts/depth/`（Depth Anything）保留原 Python 服务与依赖声明；Node 通过 `POSE_SERVICE_URL/TOKEN`、`DEPTH_SERVICE_URL/TOKEN` 使用它们。

自动检测/深度估计需要另行准备 Python 环境、模型权重和计算资源。本包不包含下载的权重，不自动启动辅助服务；未配置时相应能力按原协议返回不可用，不伪装成功。手动姿势编辑等不等于自动模型分析。

## 7. 回归、打包与来源

```sh
npm run check        # 类型检查 + 隔离 PostgreSQL 回归；需要 Docker
npm run build
npm run test:package # 包闭包、哈希、依赖与入口检查
npm pack            # 自动 build + 包检查，生成 .tgz
```

- 本次交付的 `image-workbench-0.1.0.zip` 包含源码、构建产物、锁文件和说明，可解压后独立安装/构建。
- `npm pack` 生成的 `.tgz` 用于 npm 依赖安装；npm 默认排除 `pnpm-lock.yaml`，它不等同于完整源码 ZIP。需要锁版本重建时使用源码目录或 ZIP。
- `npm test` 继续使用原 `scripts/test-with-postgres.mjs`，由 runner 管理独立 Compose 项目及测试库清理，不依赖生产数据。
- 50 个测试文件：48 个来源回归文件 + 包契约检查 + API 装配测试。AI 行为使用 mock，不应指向真实付费 Provider。
- `provenance.json` 保存源 commit、来源文件 SHA-256、抽离文件 SHA-256、依赖关系和测试清单。
- `scripts/extract-source.mjs` 是维护工具，不是安装/运行前置步骤；只在维护来源映射时显式传源仓库路径，不要把它当成覆盖式同步命令。
- 本包不含真实 `.env`、凭据、数据库、用户图片、`data/` 或 `node_modules/`。依赖和模型权重需要自行安装。
- 与初始 `image-workbench-core` 的区别：core 是纯规则/展示子集；本包包含原版完整功能链路，因此仍内含 ReactFlow、Zustand、Node/Express 等原技术依赖。

已执行验证及未覆盖范围见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。
