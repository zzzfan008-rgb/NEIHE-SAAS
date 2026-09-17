# 人物姿势参考：本地深度服务

## 当前接入状态

提供独立 Python/MPS 推理服务、Node 服务端适配器，以及一键换装姿势输入节点的三图对比入口。结果独立持久化到 PostgreSQL，不会改变现有一键换装输入，不会在上传或打开弹窗时自动调用骨骼分析。

选中已连接第一轮定版 `pose` 端口的图片节点，点击“生成姿势参考”或“查看对比”打开弹窗。可以分别生成骨骼/深度，或点击“生成两种参考”。骨骼使用现有视觉分析服务，可能计费；深度只调用本地服务。生成前自动保存发起请求的项目，保存失败不调用模型。只读项目可以查看既有结果，但不能生成。

对比弹窗提供原图、骨骼图、深度图三栏，支持放大、下载、分别重试和刷新结果。失败不会清除另一侧成功结果。关闭弹窗后任务继续，重新打开只查询状态；服务重启后超时运行记录标记为失败或结果未知，不自动重复付费请求。替换原图或文档后不会回填旧结果。

模型使用官方 Depth Anything V2 Large（vitl，335.3M）。权重采用 **CC-BY-NC-4.0**：本配置仅用于许可允许的非商业验证，不授权商业 SaaS 上线。模型源码许可与权重许可分别遵守。

## 环境与启动

使用独立 Python 3.11 环境，不安装到系统 Python。依赖见 `scripts/depth/requirements.txt`。官方源码固定到：

`https://github.com/DepthAnything/Depth-Anything-V2/tree/a561b849ebae10a6f5ef49e26c83cbbcd36c71bf`

权重、源码下载、虚拟环境与测试输出保存在版本库外或被忽略的 `tmp/` 中。不要提交 `.pth`、令牌或图片。

通过私有环境注入以下配置，不要把令牌写进文档、前端或日志：

| 变量 | 用途 |
| --- | --- |
| `DEPTH_NONCOMMERCIAL_ACK=true` | 确认用途符合 Large 非商业许可 |
| `DEPTH_SOURCE_DIR` | 官方源码根目录，包含 `depth_anything_v2/` |
| `DEPTH_CHECKPOINT` | 已下载 vitl 权重的绝对路径 |
| `DEPTH_SERVICE_TOKEN` | 至少 32 字符的随机 ASCII 令牌；Node 与 Python 一致 |
| `DEPTH_SERVICE_PORT` | Python 监听端口，默认 8766 |
| `DEPTH_SERVICE_URL` | Node 访问地址，例如 `http://127.0.0.1:8766` |
| `DEPTH_INPUT_SIZE` | Node 推理尺寸参数，默认 518，范围 518–1036 |
| `DEPTH_MODEL_REVISION` | 缓存版本，默认 `vitl-official-v1`；更换权重或推理源码后必须更新，建议使用权重 SHA-256 |

用虚拟环境 Python 运行 `scripts/depth/service.py`。MPS 不可用时明确拒绝启动，不悄悄退回 CPU。模型仅启动时加载一次，权重使用 `weights_only=True` 加载，响应附带权重 SHA-256。

服务仅监听 `127.0.0.1`，不提供公网或局域网直连。独立 Mac 或 Docker 调用需配置受控 HTTPS 代理或本机 SSH 隧道，不要把无 TLS 的令牌鉴权端口直接暴露出去。本批不改变生产部署、网络规则或自动启动项。

## 数据约定

- Node 校验输入图片后按 EXIF 旋转、等比缩小到最长边 2048；Python 只接收标准化 PNG，不接受文件路径或远程 URL。
- 拒绝长短边超过 4:1 的极端图片，避免上游按短边缩放后占用过量 MPS 内存。
- 请求 `POST /depth`，JSON 包含 `image`（PNG data URL）和 `inputSize`；Bearer 令牌由服务端注入。
- 响应为同尺寸灰度 PNG，亮近暗远。按全图预测最小值和最大值映射，不使用美化 gamma 或伪造几何细节。
- 深度是相对深度，不是米制距离。它描述可见表面，不能恢复衣服遮挡的真实关节。
- 一个推理槽；忙时返回 429，不自动重试；客户端总时限 180 秒。
- `/api/pose-references` 按用户、已保存项目、姿势节点、本地原图和模型配置绑定结果。成功结果复用，失败/未知结果只有显式重试才重新调用。生成记录与 PNG data URL 保存在 PostgreSQL 的 `pose_references` 表，避免产生未登记的公开文件；记录随项目硬删除或账号删除级联清理。
- 每账号最多两个活动任务和 128 条缓存记录，避免无界计算与存储。GET/POST 都检查项目、当前节点图片和源文件权限；修改节点标题不影响入口识别。
- 弹窗开闭、放大状态留在组件；运行状态留在独立 Store，按 `tabId + projectId + documentEpoch + nodeId + source` 隔离，不写入项目文档或撤销历史。

## 验证

```sh
pnpm exec tsx tests/depth-analysis.test.ts
pnpm exec tsx tests/pose-reference-runtime.test.ts
tmp/depth-venv/bin/python tests/depth-service.test.py
# API 与迁移回归通过项目自带隔离 PostgreSQL runner 运行：
npm run test
# 通过隔离浏览器 runner 验证 1024/1280/1440：
npm run test:e2e -- pose-reference.workbench
```

以上测试只运行假预测器及本地 HTTP 协议，不调用付费服务。真实模型验证单独执行；不能以协议测试通过宣称真实模型精度或 UI 已验收。

2026-09-17 本机验证：用户提供的 vitl 权重成功加载至 MPS，通过鉴权 HTTP 服务对项目自带封面图完成 768×480 推理，输出同尺寸 PNG、灰度范围 0–255。单次请求约 1.98 秒（不含模型启动加载），不是人像精度测试，也不是性能基准。权重 SHA-256：`a7ea19fa0ed99244e67b624c72b8580b7e9553043245905be58796a608eb9345`。验证进程已退出，未设置后台自启动。

同日补充：Node 适配器到真实 Python/MPS 服务的调用通过，返回 1200×750 PNG。三种桌面宽度的浏览器用例通过（三栏几何、部分失败与重试、放大、下载、两个入口的焦点恢复、重新打开只读恢复、换图关闭旧弹窗）；浏览器图片与分析响应为隔离模拟，不代表真实人像效果或付费骨骼分析已经验收。`gate:codex` 仍依赖 GitNexus，按项目规则未执行。
