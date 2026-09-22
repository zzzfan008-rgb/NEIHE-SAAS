# 多图编辑换装接口核对（2026-09-22）

范围：`多图编辑换装+修改` 的第一阶段与 Gemini 原生图片编辑适配器。原三阶段模板保持不变。

## 请求契约

| 检查点 | 实现与结论 |
| --- | --- |
| 路径与方法 | 内部兼容 ID 仍为 `gemini-3-pro-image-preview`，上游改为 POST `/v1beta/models/gemini-3-pro-image:generateContent`；JSON、服务端 Bearer 认证 |
| `parts` | Pro 正式路由发送 `role: "user"`；一个 `{text}` 放首位，之后每张图一个独立 `{inline_data}`，不混合字段 |
| 图片编码 | `inline_data.data` 是纯 Base64，不含 data-URL 前缀；`mime_type` 随实际 PNG/JPEG，WebP 转 PNG |
| 输出设置 | `responseModalities: ["IMAGE"]`；Pro 正式请求发送 `imageSize`，不再向该样例追加 `aspectRatio` |
| 返回解析 | 遍历候选 parts，不假定首个 part 是图片；使用最后一张有效终稿，兼容前置文字 |
| 原图排序 | 前三张固定为姿势、人物、场景；服装及配饰在其后，提示词逐图/逐格映射 |
| 多图策略 | Pro 原始有效图 ≤14 时逐张直接传递；>14 时才本地拼接，并保持前三图独立 |
| 模型多图能力 | API易多图指南描述最多 14 张模型输入。Pro 模板支持最多 20 张原始素材，超额素材经拼接后最多提交 14 张 |
| 大小与保真 | 适配器已有约 6MB 合计预算，可能等比压缩；拼图没有生成中间人物图，但细节仍可能因拼接后的降采样受损，不能承诺无损 |

模型能接收多图，不等于任何组合都能成功，也不等于全部商品细节必然恢复。保真对象数、人物一致性参考数和总输入图数是不同约束。

## 本次失败与修正

现场日志是 `promptFeedback.blockReason=OTHER`，没有候选图片、候选 token 为 0。供应商提供的成功样例使用正式 `gemini-3-pro-image` 路由、`role: "user"`、snake_case 图片字段和七张独立图片；适配器已据此对齐，同时取消七图场景下不必要的鞋袜拼接。

现在优先使用明确的 blockReason：SAFETY、BLOCKLIST、PROHIBITED_CONTENT 分别说明；OTHER 提示服务方未说明具体原因。单独零 token 不能判断违规，也不覆盖有效图片。已有 IMAGE_SAFETY 行为保持不变；OTHER 不自动改写或重发。

第一阶段提示词采用“保持参考人物外观一致”等中性职责描述。失败节点增加手动简化重试，仅去除冗余说明，保留原图、角色映射、用户要求和拍摄设置。按钮明确新请求可能收费且不保证成功。

简化模式作为 run-plan 顶层请求选项，只允许单个多图编辑节点。在服务端校验已保存画布一致、输入和权限后注入本次执行参数，并计入请求指纹和运行记录；不进入项目/模板快照。旧节点、下游批量请求和非法模式被拒绝。

## 验证范围

- Provider 回归覆盖各 blockReason、零 token 以及有效图片与异常统计并存。
- 多图测试从执行器到真实适配器截获模拟 HTTP JSON，覆盖 4/5/6/7/14/15/20 张原图与普通/简化模式；检查独立 parts、排序、Base64、正式端点、输出配置与单次图片编辑。
- 授权测试覆盖运行参数、快照不变、跨用户拒绝、幂等重放与同编号不同模式冲突。
- 桌面浏览器测试覆盖失败入口、当前请求与普通请求区分、未知结果不显示简化入口、按钮几何；模拟提交失败，不访问真实 AI。
- 这些验证不证明线上模型一定能生成，也不能进一步确定 OTHER 的内部原因。未获授权，不发送付费探针。

## 核对资料

先读取 [API易文档索引](https://docs.apiyi.com/llms.txt)，再核对：

- [图片编辑 API](https://docs.apiyi.com/api-capabilities/nano-banana-image/image-edit)
- [多图融合指南](https://docs.apiyi.com/api-capabilities/multi-image-fusion-testing)
- [API易错误处理指南](https://docs.apiyi.com/api-capabilities/gemini-image-error-handling)
- [Google GenerateContent / BlockReason 定义](https://ai.google.dev/api/generate-content)

API易错误处理页将零候选 token 作为审核启发式；此处采用更保守的错误报告：统计不是拦截原因，以明确反馈为准，OTHER 不等价于 SAFETY。

## 首次验证与部署记录（提交前）

- 当前工作区 `npm run check`（含 lint、前端构建、隔离 PostgreSQL 完整测试）和 `npm run build` 均通过。
- 隔离的 `e892fe3` 加本次补丁也通过完整 `check`；使用测试凭据，不复制生产 `.env`。Docker 使用冻结锁文件独立安装并成功构建。
- 桌面 E2E：1024 / 1280 / 1440 全部通过（加认证准备共 4 passed）。Provider 契约测试 35 项通过。
- `git diff --check`、CodeGraph sync / affected 已执行；图谱列出 89 个受影响测试，作为回归选取依据，不代表覆盖穷尽。
- `gate:codex` 仍调用禁用的 GitNexus，未运行，不宣称完整 gate 通过。
- 已部署镜像：`sha256:23dc1578c390b375ce36aed78367c1fcf7570c60db7e86288d6c4f656298d136`。localhost:3002 与 192.168.0.92 的 health / ready 均通过；旧镜像保留为 `garment-canvas-app:before-tryon-contract-20260922`。
- 本节记录的是提交前验证；后续提交与重建版本以 Git 记录和镜像 revision 标签为准。原模板、已有记录未被修改，其他未提交功能未随镜像部署。没有真实生图验证，无法承诺 OTHER 已在服务方消除。
