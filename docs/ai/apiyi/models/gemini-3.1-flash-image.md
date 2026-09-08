# gemini-3.1-flash-image

产品范围：正式模型用于普通图片生成、图片编辑和虚拟模特换装。v0-v11 项目的 Preview 标识在读取时迁移为正式模型。

## 请求

- 产品模型 ID 与上游模型 ID 均为 gemini-3.1-flash-image。端点由契约模板 POST /v1beta/models/{model}:generateContent 生成。
- API易详情页代码示例仍使用 gemini-3.1-flash-image-preview；总览页明确说明无 preview 的正式名称已经上线且两个名称均可用。本项目按用户开放清单固定使用正式名称，不在代码中静默切换别名。
- Content-Type：application/json
- contents[0].parts 必须由 1 个 text part 和 0 到 N 个 inlineData part 组成。
- 每个 part 只能包含 text 或 inlineData 之一，不能同时包含两者。
- inlineData.mimeType 使用 image/png 或 image/jpeg；inlineData.data 为不带 data URI 前缀的 Base64。
- generationConfig.responseModalities 固定包含 IMAGE。
- generationConfig.imageConfig.aspectRatio 支持 14 种：1:1、1:4、4:1、1:8、8:1、2:3、3:2、3:4、4:3、4:5、5:4、9:16、16:9、21:9。
- generationConfig.imageConfig.imageSize 支持 512、1K、2K、4K，大小写必须严格匹配。
- 总调用超时、undici 响应头和响应体空闲时限最低 360 秒。TCP/TLS 建连时限默认 30 秒，建连完成后不参与生成等待。
- 不发送 google_search 工具，也不使用 -4k 模型别名。

供应商接口最多 14 张有序参考图；通用画布节点保留 8 张产品限制，虚拟换装允许 14 张。换装参考角色及顺序由服务端工作流构建。

超过 1.5 MiB 的参考图等比缩到最长边 2048px 以内，不放大小图。JPEG 使用 quality=90；PNG 无同义质量参数，使用无损压缩并按需要缩小尺寸。保持 PNG/JPEG 格式，WebP 转 PNG。若总量超过 6 MiB，再按每张预算缩减；单张压缩失败回退原图，最终仍超出总量或单图硬限制时在提交前拒绝。此步骤不改写素材库原图。

## 响应

- 遍历 candidates[].content.parts[]，收集所有包含 inlineData.data 的图片 part。
- 不得假设第一项 part 一定是图片；启用 TEXT 与 IMAGE 时可能出现文本或中间图片 part。
- 仅返回最后一张有效图片，保留响应 MIME；持久化层再统一实际转码为 PNG。
- 必须检查候选项、finishReason 和是否实际存在图片数据；HTTP 200 不等于成功出图。
- inlineData.data 为纯 Base64，mimeType 决定保存格式。
- 先检查 candidatesTokenCount=0，再处理 finishReason。IMAGE_SAFETY 由现有 Worker 最多自动重试两次，供应商层仅发送一次请求。

## 部署

上游 generateContent 是同步接口，没有上游任务 ID。应用自己的 PostgreSQL 队列先返回本地 run ID，由长期运行的 Worker 等待出图并持久化，浏览器断开不取消 Worker。供应商连接所经代理需允许至少 360 秒等待；Serverless/容器任务执行预算需覆盖生成、结果下载与保存。无法从本仓库修改 API易自身网关或外部平台的执行上限。
