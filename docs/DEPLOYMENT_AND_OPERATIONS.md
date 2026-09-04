# Garment Canvas 部署与运维手册

本文是生产安装、macOS 运行、管理员初始化、备份恢复、数据库迁移、故障处理和安全加固的权威操作手册。产品仅支持桌面浏览器：最低 1024 CSS px，主要验收宽度为 1280 与 1440。

## 1. 发布边界

- 生产数据由 PostgreSQL 18 与 `DATA_DIR` 共同组成，二者必须在同一个恢复点备份。
- `dist/`、`dist-server/`、`.env` 和 `data/` 都不是版本库内容；部署现场构建或使用 Docker 多阶段构建。
- 自动化和验收不得连接真实 AI。只有正式部署才填写真实 `APIYI_API_KEY`。
- 浏览器内未保存的 session 草稿不属于服务端备份。维护前应先让用户保存项目并退出生成任务。
- 生成队列与历史由 PostgreSQL 持久化；启动后会恢复活动任务并通过 Results 展示成功、失败或未知状态。同步未完成时不要盲目重新提交，以免重复计费。

## 2. 环境变量

从 `.env.example` 复制私有 `.env`，不要提交、打印或上传该文件。

| 变量 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `APIYI_API_KEY` | 是 | 无 | API易图片网关密钥；就绪检查只验证非空，不会主动调用模型 |
| `APIYI_BASE_URL` | 否 | `https://api.apiyi.com` | 覆盖默认网关时必须是 HTTPS URL |
| `PORT` | 否 | 本地 3001；Compose 无配置时对外 3002 | 非 Docker 时是服务监听端口；Compose 容器内固定监听 3002，宿主机映射使用该值 |
| `API_PROXY_TARGET` | 否 | 跟随 `PORT` | 仅开发环境需要转发到独立 API 地址时设置 |
| `DATA_DIR` | 否 | `./data` | 上传、生成文件与旧 SQLite 导入源目录 |
| `DATABASE_URL` | 否 | 无 | 非 Docker 部署可使用完整 PostgreSQL 连接串；设置后优先于分项变量 |
| `PGHOST` / `PGPORT` | 否 | `127.0.0.1` / `POSTGRES_HOST_PORT` | 非 Docker PostgreSQL 地址 |
| `PGDATABASE` / `PGUSER` / `PGPASSWORD` | 否 | 回退到 `POSTGRES_*` | 非 Docker PostgreSQL 凭据 |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | Compose 必需 | 数据库名和用户有默认值 | `POSTGRES_PASSWORD` 必须使用长随机值 |
| `POSTGRES_HOST_PORT` | 否 | `54329` | PostgreSQL 只绑定到本机开发端口 |
| `DATABASE_POOL_SIZE` | 否 | `10` | 连接池上限，服务端限制为 1–50 |
| `INITIAL_ADMIN_ACCOUNT_ID` | 空库必需 | 无 | 仅数据库没有用户时创建首位管理员 |
| `INITIAL_ADMIN_PASSWORD` | 空库必需 | 无 | 至少 10 位并同时含字母和数字；首次登录强制修改 |
| `SQLITE_IMPORT_FILE` | 否 | `garment-canvas.db` | 相对于 `DATA_DIR` 的旧 SQLite 文件，只在 PostgreSQL 空库时导入一次 |
| `COOKIE_SECURE` | 否 | `false` | HTTPS 反向代理部署必须设为 `true` |
| `API_ONLY` | 否 | `false` | `true` 时不要求或托管前端构建 |
| `AI_TIMEOUT_MS` | 否 | 按模型契约，通常 300000 | AI 请求总时限（毫秒） |
| `AI_CONNECT_TIMEOUT_MS` | 否 | `30000` | TCP/TLS 建连时限，不超过总时限 |
| `AI_HEADERS_TIMEOUT_MS` | 否 | 等于总时限 | 等待响应头时限，不超过总时限 |
| `AI_BODY_TIMEOUT_MS` | 否 | 等于总时限 | 响应体分段空闲时限，不超过总时限 |
| `AI_IMAGE_TAIL_GRACE_MS` | 否 | `5000` | chunked JSON 完整后等待连接正常收尾的窗口；超时后主动回收完整结果 |
| `GENERATION_WORKER_POLL_MS` | 否 | `2000` | Worker 轮询间隔，限制为 100–60000 ms |

初始化成功并完成管理员改密后，可以从 `.env` 移除 `INITIAL_ADMIN_ACCOUNT_ID` 和 `INITIAL_ADMIN_PASSWORD`，避免长期保留临时凭据。

Compose 会读取私有 `.env` 做端口插值：复制当前 `.env.example` 后宿主机网页端口是 3001；删除或不设置 `PORT` 时回退到 3002。Compose 部署通常不要再设置 `DATABASE_URL`，否则它会优先于容器内的 `PG*` 连接配置。

## 3. Docker 安装与升级

要求 Docker Desktop 或 Docker Engine + Compose。

```bash
cp .env.example .env
chmod 600 .env
docker compose config
docker compose up -d --build --wait
curl --fail http://localhost:3001/api/ready
```

首次登录使用私有 `.env` 中的管理员临时凭据。界面会要求管理员本人完成最终密码修改；随后再通过账户菜单创建、停用、重置或删除普通用户。

升级应用前先完成第 5 节的一致性备份，然后：

```bash
git fetch origin
git switch --detach <approved-release-commit>
docker compose up -d --build --wait
curl --fail http://localhost:3001/api/ready
```

不要在未复审的分支或漂移 SHA 上构建生产版本。升级数据库结构后，代码回滚不一定等于数据回滚；需要回退数据库时必须使用同一发布前备份。

## 4. macOS 非 Docker 部署

适用于已经独立管理 PostgreSQL 18 的单机环境。要求 Node.js 22.20.0 或更高版本。

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm install --prod --frozen-lockfile
NODE_ENV=production pnpm start
```

服务端会读取项目根目录的私有 `.env`。完整模式缺少 `dist/index.html` 时会直接退出；只有明确的 API 独立部署才设置 `API_ONLY=true`。

### launchd 示例

先使用 `command -v node` 确认 Node 的绝对路径，并将下面所有 `/ABSOLUTE/PATH` 替换为真实路径。保存为 `~/Library/LaunchAgents/com.garment-canvas.app.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.garment-canvas.app</string>
  <key>ProgramArguments</key>
  <array>
    <string>/ABSOLUTE/PATH/TO/node</string>
    <string>/ABSOLUTE/PATH/TO/garment-canvas/dist-server/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>/ABSOLUTE/PATH/TO/garment-canvas</string>
  <key>EnvironmentVariables</key>
  <dict><key>NODE_ENV</key><string>production</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/ABSOLUTE/PATH/TO/garment-canvas/logs/app.log</string>
  <key>StandardErrorPath</key><string>/ABSOLUTE/PATH/TO/garment-canvas/logs/app-error.log</string>
</dict>
</plist>
```

```bash
mkdir -p logs
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.garment-canvas.app.plist
launchctl kickstart -k "gui/$(id -u)/com.garment-canvas.app"
curl --fail http://localhost:3001/api/ready
```

启用 HTTPS 反向代理后，将 `.env` 中的 `COOKIE_SECURE` 改为 `true` 并重启服务。不要把 PostgreSQL 或应用端口直接暴露到不可信网络。

## 5. 一致性备份

建议每天备份，并在每次发布、数据库迁移、批量用户管理前额外备份。以下命令使用时间戳目录，避免覆盖旧备份：

```bash
backup_dir="backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
docker compose stop app
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$backup_dir/postgres.dump"
tar -C data -czf "$backup_dir/data.tar.gz" .
shasum -a 256 "$backup_dir/postgres.dump" "$backup_dir/data.tar.gz" > "$backup_dir/SHA256SUMS"
docker compose start app
curl --fail http://localhost:3001/api/ready
```

备份完成后检查文件非空，并把整个时间戳目录复制到独立磁盘或受控备份系统。只有放在同一台机器同一磁盘上的副本不算灾备。

## 6. 恢复演练

恢复会覆盖数据，只能在明确选定的恢复环境中执行。生产恢复前停止应用，并保留当前故障现场的额外快照。

1. 校验备份：`shasum -a 256 -c SHA256SUMS`。
2. 使用相同主版本的 PostgreSQL 18 启动空环境。
3. 停止 `app`，确认没有生成 Worker 或写请求。
4. 在空数据库中执行：

```bash
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < backups/<timestamp>/postgres.dump
```

5. 将现有 `data/` 移到隔离位置后，重建空目录并解压同一时间戳的文件备份：

```bash
mkdir -p data
tar -C data -xzf backups/<timestamp>/data.tar.gz
```

6. 启动应用，检查 `/api/ready`，然后人工验证登录、项目、素材、Results、活动任务和文件下载。

不要只恢复 PostgreSQL 或只恢复 `DATA_DIR`。数据库记录与文件目录不一致时，结果卡可能存在但文件丢失，或出现无人引用的文件。

## 7. PostgreSQL 与旧 SQLite 迁移

### PostgreSQL 17 → 18

PostgreSQL 18 镜像挂载点为 `/var/lib/postgresql`，不能直接复用 17 的数据目录。使用 `pg_dump` 导出 17，再在全新的 18 卷中使用 `pg_restore`；确认恢复成功前不要删除旧卷。

### SQLite → PostgreSQL

- 把旧 SQLite 文件放到 `DATA_DIR`，并用 `SQLITE_IMPORT_FILE` 指定相对文件名。
- 只在 PostgreSQL 没有任何用户时触发一次只读导入。
- 导入覆盖用户、会话、项目、素材、生成记录和消耗流水；原 SQLite 文件保留不变。
- 导入后检查用户数量、项目、素材、历史、消耗 CSV 和文件下载，再把旧文件归档为只读证据。

## 8. 首次安装与恢复流程

### 首次安装

1. 生成私有 `.env`，启动服务并确认 `/api/ready` 为 200。
2. 管理员使用临时凭据登录并亲自完成强制改密。
3. 创建一个普通用户，验证普通用户看不到管理员功能和他人私有素材。
4. 创建、保存并重新打开一个项目，确认服务端持久化。
5. 使用 dummy/stub 环境完成发布验收；正式 AI 连通性只在生产授权范围内单独检查。

### 项目与任务恢复

- 已保存项目从项目中心重新打开；浏览器 session 草稿只用于同一浏览器的临时恢复，不能替代服务端保存。
- 刷新后等待历史与活动任务对账完成。同步失败时生成安全门保持关闭，应先重试同步或修复后端，不能直接重复运行。
- `失败` 记录保留失败原因且不计成功消耗；`结果未知` 表示终态无法确认，应先检查服务端历史和日志。
- Results 必须继续支持跨项目恢复、失败、未知、查看、对比、下载和继续处理。

## 9. 健康检查与故障排查

| 信号 | 含义 | 处理 |
| --- | --- | --- |
| `GET /api/health` 200 | Node 进程存活 | 仍需检查 `/api/ready` |
| `dataDirWritable: false` | `DATA_DIR` 不可创建、写入或清理探针 | 检查目录、磁盘空间、所有者和挂载权限 |
| `frontend: false` | 完整生产模式缺少 `dist/index.html` | 重新执行 `pnpm run build`；不要用 `API_ONLY` 掩盖完整部署错误 |
| `aiConfigured: false` | 密钥为空或网关 URL 不是 HTTPS | 检查私有 `.env`，不要输出密钥 |
| `database: false` | PostgreSQL 不可达或迁移失败 | 检查 `docker compose logs postgres`、连接变量和磁盘 |
| `usersConfigured: false` | 数据库没有用户且管理员初始化失败 | 检查初始管理员变量和密码规则 |
| 会话被替换 | 同一账号在另一设备登录 | 用户确认后重新登录；不要修改无关账号设置 |
| 任务长期运行或未知 | Worker、网关或 SSE 状态不完整 | 检查 app 日志、历史和活动任务；避免盲目重提 |

常用诊断：

```bash
docker compose ps
docker compose logs --tail=200 app postgres
curl --fail http://localhost:3001/api/health
curl --fail http://localhost:3001/api/ready
```

## 10. 安全基线

- `.env` 权限设为 600；密钥、数据库 dump、上传文件和 `data/` 不进入 Git、PR、日志或截图。
- 生产入口使用 HTTPS 反向代理并设置 `COOKIE_SECURE=true`；限制应用与 PostgreSQL 的网络暴露。
- 首次管理员必须改密；临时凭据完成初始化后从 `.env` 删除或轮换。
- 每个账号只保留一个有效设备会话，会话最长 30 天；管理员操作使用独立账号并遵循最小权限。
- AI 网关 URL 必须 HTTPS；生成、工作流入队和 AI 诊断探测共用按 IP 每分钟 100 次的限流，登录单独限制为每分钟 10 次。限流是单进程内存状态，多实例部署需额外的集中式限流。
- 定期运行 `pnpm audit`、依赖更新审查、恢复演练和权限抽查；高危漏洞未处置时不得发布。
- 备份包含敏感业务数据，应加密存储、限制访问并设置保留/销毁策略。

## 11. 桌面验收矩阵

| 宽度 | 最低高度/参考高度 | 必验内容 |
| --- | --- | --- |
| 1024 | 768 | 左右 Dock 互斥、画布仍可操作、顶栏/页签不溢出 |
| 1280 | 720 | 主工作区、节点参数、Results、MiniMap、弹层 |
| 1440 | 900 | 完整工作区密度、长提示词、结果详情、项目中心 |

每个宽度覆盖 `current`、`white`、`eye` 三主题，并验证 Tab、Escape、焦点恢复、Dialog/菜单焦点边界、React Flow 快捷键隔离、失败/未知 Results 和继续处理。最新证据见 [`PHASE_D_VISUAL_ACCEPTANCE.md`](PHASE_D_VISUAL_ACCEPTANCE.md)。
