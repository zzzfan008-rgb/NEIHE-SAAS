# Portkey 与 TuziAPI 接入

文档与登录后的模型广场核对日期：2026-10-05。协议回归使用模拟响应，尚未进行真实密钥或付费生成验证。

## 配置与切换

AI 请求统一经过自托管的 [Portkey Gateway](https://github.com/Portkey-AI/gateway)。`deploy/portkey/Dockerfile` 使用固定摘要的官方 1.15.2 发行文件，运行于 Node 22.23.2；不修改 Portkey 源码。Compose 内部地址为 `http://portkey:8787`，服务不发布宿主机端口。项目保留账号权限、供应商选择、任务快照和各模型的请求/结果适配；条件路由和上游凭据注入交给 Portkey。

本机开发需运行该网关，并在服务端配置 `PORTKEY_GATEWAY_URL`（默认 `http://127.0.0.1:8787`，根地址不带 `/v1`）。Compose 已包含网关构建、健康检查和依赖关系；部署仍需按项目发布流程单独授权。无需 Portkey 云账号。

本机独立运行网关的命令如下（仅绑定本机端口）：

```sh
docker build -t garment-canvas-portkey:local deploy/portkey
docker run --rm -p 127.0.0.1:8787:8787 garment-canvas-portkey:local
```

在服务端 `.env` 设置 `TUZI_API_KEY`，`TUZI_BASE_URL` 默认 `https://api.tu-zi.com`。重启服务后，管理员可通过账户按钮右侧的「供应商」下拉菜单切换 APIYI / TuziAPI。未配置密钥或 HTTPS 地址无效时，该供应商不可选。GPT Image 2.5 的完整尺寸和质量参数要求令牌可访问 image（绘画）分组；素材审核还需对应账号权限。

选择保存在 PostgreSQL 的 `ai_gateway_settings` 单例中，默认 APIYI。写入使用版本校验，普通账号不能修改。切换影响所有账号之后提交的任务和辅助分析请求；其他页面通过广播、重新聚焦或最长约 10 秒的轮询更新显示。

每个 `generation_runs` 保存 `gateway_id`，执行、自动重试、视频恢复及对话的手动重试沿用原供应商。存量记录默认 APIYI。图片模型、画布文档和历史结果不会因切换而被改写；供应商状态不进入文档历史或本地会话持久化。密钥只在服务端使用。

Portkey 按任务的供应商元数据选择目标，关闭网关重试，不启用跨供应商回退或缓存；项目原有 Worker 继续管理重试。网关不可用时请求失败，不绕过网关直连。图片生成、编辑、聊天、原生 Gemini、视频提交/轮询和 Tuzi 素材审核均通过网关。已有独立 icover 素材存储及受校验的结果文件下载保留原下载通道，以执行文件大小、公网 DNS 和重定向限制。

## 模型和协议

完整映射见 [model-contracts.json](./model-contracts.json)。

| 项目模型 | TuziAPI 上游模型 / 协议 |
| --- | --- |
| GPT Image 2.5 Flare / Sunburst | `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`；OpenAI images |
| GPT Image 2 / VIP | `gpt-image-2` / `gpt-image-2-vip`；OpenAI images |
| Gemini 3 Pro Image | `gemini-3-pro-image-preview`；原生 Gemini |
| Gemini 3.1 Flash Image | `gemini-3.1-flash-image`；原生 Gemini |
| Seedream 5 | `doubao-seedream-5-0-260128`；生成 JSON，编辑 multipart |
| Seedance 2.0 / Fast / Mini / 2.5 | 保留项目内精确型号；`/v1/videos` 异步任务协议 |

规划和提示词优化等聊天请求使用选中供应商的 `/v1/chat/completions`，保留项目配置的文本/视觉模型（默认 `gpt-5.6-terra`、`gemini-3-flash-preview`）。

FLUX.2 Pro、Grok 图片模型未在本次 TuziAPI 模型广场查询中找到，前后端均阻止在 TuziAPI 下提交；不自动替换已有模型。参考图数量、排序、格式和尺寸校验沿用项目限制。实际模型权限、配额和参数支持仍需真实令牌验证。

## 视频差异

- 支持文生视频、首帧、首尾帧、多模态参考及 Seedance 2.5 延长；视频编辑和智能时长 `-1` 不受支持，提交前明确提示。
- 图片通过 `/v1/seedance/assets` 上传，启动审核并等待 `active` 后使用 `asset://` 引用。
- TuziAPI 的素材接口不接收视频。本地参考视频继续使用项目已有的独立 icover.ai 素材存储，需要 `SEEDANCE_ASSET_API_BASE_URL` / `SEEDANCE_ASSET_API_KEY`。
- 受理后保存任务 ID，恢复只查询原任务。结果下载限制为 100 MiB，并校验 HTTPS、公网 DNS 和重定向，不向结果 CDN 转发供应商密钥。

## 验证入口

- `tests/tuzi-provider.test.ts`：独立密钥、并发隔离、协议映射、蒙版/多图、素材审核和视频恢复。
- `tests/ai-gateway.test.ts`：管理员权限、持久化、版本冲突、队列快照及重试。
- `tests/ai-gateway-client.test.ts`：过期响应、账号切换、并发冲突和读取失败恢复。
- `tests/portkey.test.ts`：网关配置、并发隔离、凭据边界和禁止直连回退。
- `npm run test:portkey`：构建官方发行物，在 `--network none` 的临时容器内启动真实 Portkey 和模拟上游，验证 JSON、multipart 文件顺序、原生路径、独立视频凭据及无重试/回退；不读取本机 `.env`。
- 项目标准 `npm run check` / `npm run build`；测试环境覆盖两家供应商和 Portkey 地址，禁止真实生成。

2026-10-05 本地验收：`npm run check`、`npm run build`、`npm run test:portkey`、`git diff --check` 和 Compose 配置校验通过。官方 Portkey 实例完成 21 次断网模拟请求，包含 8 MiB JSON 请求往返。Playwright 在 1024 / 1280 / 1440 宽度验证按钮位于账户右侧、菜单边界、键盘/焦点恢复、跨页同步、普通账号隐藏入口、未配置项禁用和原模型/提示词保留。CodeGraph 已完成 sync / affected；图谱不视作完整覆盖。`gate:codex` 仍依赖 GitNexus，按项目规则未运行。尚未配置真实 TuziAPI 密钥、进行付费生成或部署生产环境。

## 官方来源

- [图片 API](https://api.tu-zi.com/docs/api/images)
- [Gemini API](https://api.tu-zi.com/docs/api/gemini)
- [OpenAI 兼容 API](https://api.tu-zi.com/docs/api/openai)
- [Seedance 真人视频 API](https://api.tu-zi.com/docs/api/seedance-real-person-video)
- [模型广场](https://api.tu-zi.com/pricing)
