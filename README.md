# Garment Canvas

Garment Canvas 是面向服装设计师的桌面工作流画布，覆盖图片输入、模板建图、AI 生成、局部修改、项目页签、跨项目 Results 与素材管理。最低支持宽度为 1024 CSS px，主要验收宽度为 1280 与 1440；不提供移动端专用布局。

当前项目硬规则、UI/shadcn 边界、验证流程与发布门禁以 [`AGENTS.md`](AGENTS.md) 为唯一规则源；日期交接和完成度台账只记录历史状态与证据。

生产部署、macOS 常驻运行、完整环境变量、管理员初始化、备份恢复、PostgreSQL/SQLite 迁移、故障处理和安全基线见 [`docs/DEPLOYMENT_AND_OPERATIONS.md`](docs/DEPLOYMENT_AND_OPERATIONS.md)。发布前使用 [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md)，最新三主题桌面视觉证据见 [`docs/PHASE_D_VISUAL_ACCEPTANCE.md`](docs/PHASE_D_VISUAL_ACCEPTANCE.md)。

## Docker 启动（推荐）

要求 Docker Desktop / Docker Engine + Compose。先复制 `.env.example` 为私有
`.env`，至少替换 PostgreSQL 密码、AI 网关和首次管理员配置，然后执行：

```bash
docker compose up -d --build --wait
```

网页入口固定为 `http://192.168.0.92`，仅反向代理绑定 `192.168.0.92:80`，
不发布到 `0.0.0.0` 或 IPv6。应用 3002 和 PostgreSQL 5432 仅在 Docker 网络内访问。
私有 `.env` 的 `PORT` 不再控制 Docker 发布端口。本机必须持有该局域网 IP，
建议在路由器设置 DHCP 地址保留；不要配置公网端口转发。
PostgreSQL 18 数据保存在 Docker 命名卷
`garment-canvas_postgres_data`，上传和生成文件仍保存在 `data/`。

PostgreSQL 18 官方镜像的卷挂载点是 `/var/lib/postgresql`。从 17 升级时不能直接
复用 17 的数据目录，必须先用 `pg_dump` 导出，再在新建的 18 卷中恢复。

如果 `data/garment-canvas.db` 存在且 PostgreSQL 还没有用户，首次启动会自动导入
旧 SQLite 中的用户、会话、项目、素材、生成记录和消耗流水。导入成功后原
SQLite 文件会保留，便于回退核对。

## 本地开发

要求 Node.js 22.20.0 或更高版本。先只启动 PostgreSQL，再启动开发服务：

```bash
docker compose -f compose.yaml -f compose.development.yaml up -d postgres --wait
pnpm install --frozen-lockfile
pnpm run dev
```

`pnpm run dev` 会先自动执行 `pnpm run dev:check`：核对 Node.js 版本、5173/后端端口
占用、PostgreSQL 认证与只读 `SELECT 1`、Docker Engine 和 Vite API 代理目标。预检只读取连接状态，
不会停止进程、启动容器、修改数据库或调用 AI。若提示旧 Vite/API 端口冲突，应先停止
旧开发进程；若 PostgreSQL 不可达，按提示重新执行
`docker compose -f compose.yaml -f compose.development.yaml up -d postgres --wait`。
也可单独运行 `pnpm run dev:check` 排查环境。开发覆盖文件仅显式使用时发布本机数据库端口，
不要用于局域网生产部署。

前端开发服务器默认为 `http://localhost:5173`，API 默认为
`http://localhost:3001`，本机 Node 通过 `POSTGRES_HOST_PORT`（默认 54329）连接容器。
Vite 的 `/api` 代理会跟随同一个 `PORT`；例如 `PORT=3002 pnpm run dev`
会同时将后端与前端代理切换到 3002。如需转发到独立地址，可在私有
`.env` 中显式设置 `API_PROXY_TARGET=http://localhost:3002`，该值优先于 `PORT`。

`pnpm run test` 会自动启动隔离的临时 PostgreSQL 容器，运行全部回归后删除测试容器和卷；
测试数据不会污染正式数据。

未提交改动先运行只读预审；固定候选提交并保持干净工作树后，再运行完整本地门禁替代
GitHub Actions：

```bash
pnpm run gate:codex -- --uncommitted --review-only

# 候选提交后
nvm use
pnpm run gate:codex -- --base origin/main
```

门禁先运行完整确定性检查、桌面 E2E、生产构建和 production smoke，再调用
结构化 `codex exec` 审查精确差异。命令不指定模型，始终使用当前 Codex 配置的默认模型；
任何 P0-P3 有效问题都会令门禁失败。为覆盖最低支持版本兼容性，门禁只接受
`.nvmrc` 固定的 Node.js 22.20.0；审查单个提交可改用 `--commit SHA`。

桌面端浏览器回归同样使用独立 PostgreSQL、动态端口和临时文件目录，并会阻断真实 AI
请求。首次运行先安装 Chromium，然后执行：

```bash
pnpm exec playwright install chromium
pnpm run test:e2e
```

该套件覆盖项目支持下限 1024×768，以及主要视觉宽度 1280×720 与 1440×900；
不包含移动端适配测试。

## 非 Docker 构建与启动

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm start
```

`pnpm run build` 会同时生成：

- `dist/`：Vite 前端静态文件；
- `dist-server/index.js`：可由 Node.js 直接运行的服务端产物。

部署机器只需要生产依赖和两个构建目录：

```bash
pnpm install --prod --frozen-lockfile
pnpm start
```

完整生产模式缺少 `dist/index.html` 时会直接退出，避免 API 看似启动成功但前端不可用。
如果前端由其他服务托管，可显式设置 `API_ONLY=true` 启动仅 API 模式。

运行状态接口：

- `GET /api/health`：进程存活检查；
- `GET /api/ready`：检查 PostgreSQL、`DATA_DIR`、AI 配置和完整模式下的前端构建。

用户、会话、项目、素材、生成记录和消耗流水保存在 Docker 内置 PostgreSQL 18；上传及
生成图片保存在 `DATA_DIR`。当前部署使用本地磁盘，不自动备份，但 PostgreSQL 命名卷
与文件目录已分离，可后续接入备份接口。

首次启动前必须在私有 `.env` 中配置管理员临时凭据（不要提交 `.env`）：

```bash
INITIAL_ADMIN_ACCOUNT_ID=your-admin-account
INITIAL_ADMIN_PASSWORD=your-temporary-password
```

临时密码至少 10 位并同时包含字母和数字。它只在数据库没有任何用户时用于创建首位
管理员；管理员首次登录后必须修改密码。管理员随后可在网页右上角创建、停用、重置或
删除普通用户。每个账号仅保留一个有效设备会话，新设备登录会立即使旧会话失效；会话
固定有效 30 天。

素材默认仅创建者可见，用户可主动共享给所有账号；历史部署包中的素材和上传文件会在
首次启动时登记为全局素材。被项目引用的素材不能删除，普通删除进入 15 天回收期。
生成历史与成功消耗流水由服务端保存，失败记录保留在历史中但不计入消耗。用户可导出
自己的 CSV，管理员可按用户或全部导出。

`/api/ready` 还会检查 API易图片网关已配置：必须提供非空的
`APIYI_API_KEY`，且 `APIYI_BASE_URL` 必须为 HTTPS。该检查不会主动调用
外部模型，不会产生费用。

生成、工作流入队和 AI 诊断探测共用进程内限流：同一 IP 每分钟最多请求 100 次；
登录接口单独限制为每分钟 10 次。服务重启后计数重置，多实例部署需要集中式限流。

每个 AI 节点独立保存模型和原生参数。普通图片节点可选择
`gpt-image-2-vip`、`gemini-3.1-flash-image`、`flux-2-pro`、
`seedream-5-0-260128` 或 `grok-imagine-image`；`gpt-image-2` 仅用于蒙版
局部修改。业务接口先将任务写入 PostgreSQL，再由 Worker 调用 API易同步图片
端点并立即转存结果。完整契约见 [`docs/ai/apiyi/README.md`](docs/ai/apiyi/README.md)。

内置模板将“人物场景迁移”与“图案风格迁移”分开，避免人物/座椅语义污染
印花图案处理。
