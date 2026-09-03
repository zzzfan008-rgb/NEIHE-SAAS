# gemini-3.1-flash-image

产品范围：正式模型用于普通图片生成节点；`gemini-3.1-flash-image-preview` 仅用于“虚拟模特换装”多参考图编辑。

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
- 建议调用超时 360 秒。

项目仍保留最多 8 张引用图的产品限制，即使模型文档描述了更高的参考物体能力。
“虚拟模特换装”是唯一例外：固定使用 preview 模型名，统一最多接收 14 张有序参考图。图 1 固定为最终模特基准，图 2 固定为主穿搭，图 3–14 只补充服装、鞋包、材质和工艺细节；补充要求不得重定义图片编号。

## 响应

- 遍历 candidates[].content.parts[]，收集所有包含 inlineData.data 的图片 part。
- 不得假设第一项 part 一定是图片；启用 TEXT 与 IMAGE 时可能出现文本或中间图片 part。
- 必须检查候选项、finishReason 和是否实际存在图片数据；HTTP 200 不等于成功出图。
- inlineData.data 为纯 Base64，mimeType 决定保存格式。
