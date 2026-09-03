# gpt-image-2

产品范围：“局部修改”和“虚拟模特换装”节点，不得出现在其他普通图片生成节点的模型列表中。

## 请求

- Base URL：https://api.apiyi.com
- 端点：POST /v1/images/edits
- Content-Type：multipart/form-data
- 必填：model、prompt、至少一张 image[]；只有“局部修改”必须发送 mask
- model 固定为 gpt-image-2
- image[] 可为 PNG、JPEG 或 WebP；即使只有一张也使用 image[] 字段。单张小于 50MB，项目仍执行自身更严格的上传和引用图限制。
- mask 必须为带 Alpha 通道的 PNG、小于 4MB，并与第一张 image 的像素尺寸完全一致。
- Alpha 0 表示允许编辑；Alpha 255 表示尽量保留；半透明仅是软过渡。
- mask 只作用于第一张 image。
- 虚拟模特换装不发送 mask，节点统一最多接收 14 张有序参考图；上游接口本身最多支持 16 张。图 1 固定为最终模特基准，图 2 固定为主穿搭，图 3–14 只补充服装、鞋包、材质和工艺细节；补充要求不得重定义图片编号。
- 单次固定返回 1 张；请求不发送 n。
- 不得发送 input_fidelity。
- 不得发送 response_format。
- 统一局部修改固定发送 `background=opaque` 与 `output_format=png`，将返图当作完整编辑结果。
- 本项目不再请求透明增量图层；PNG 用于保证蒙版与最终合成格式稳定。

可发送 size、quality、output_format 和 output_compression。quality 仅允许 auto、low、medium、high；output_format 仅允许 png、jpeg、webp。

蒙版请求必须显式发送与原图比例最接近的合法 `size`，禁止依赖 `auto`：两边均为 16 的倍数、最长边不超过 3840、总像素在 655,360–8,294,400 之间且宽高比不超过 3:1。模型返回后将完整画面无裁切映射回原图坐标，再执行本地合成。

## 蒙版与合成语义

- 用户涂抹的区域是“修改意图核心”，不是新图案的裁切框。提示词必须要求模型结合完整画面决定图案尺寸、透视、光影和位置，不得把主体缩在用户涂抹边界内或沿该边界截断。
- 发送给模型的 provider mask 可在意图核心外扩展，为完整图案、边缘、阴影和反射保留创作空间。GPT Image 的 mask 本身是引导，不是 Photoshop 式的硬裁切。
- provider mask 与最终像素保护必须分离：最终合成使用本地计算的自适应融合窗口，核心区使用编辑结果，外围使用有限范围的渐变融合，窗口之外恢复原图。不得把上游模型的 mask 遵循当作像素级保证。
- 上游返回完整编辑图，但项目只通过本地融合窗口写回：核心与完整延展区采用连续生成画面，最外圈羽化，窗口之外恢复原图像素。
- 旧项目中的 `maskMode` 只作为 V2 兼容输入读取，迁移到 V3 后必须剥离；新任务固定携带 `maskPipelineVersion=3`。V3 的区域引导图使用不透出旧内容的纯色核心，并要求替换/删除时先重建被旧物遮挡的服装或背景，避免残留旧包带、暗斑和颜色污染。

## 响应

- 图片位于 data[0].b64_json，为不带 data URI 前缀的纯 Base64。
- `/v1/images/edits` 的响应是完整画布尺寸的图像，不是蒙版区域的裁切小图。
- 解析器可兼容意外带前缀的历史形态，但请求侧不得依赖该形态。
- 建议调用超时 360 秒。

## 本地校验

- 原图与蒙版尺寸差 1 像素也必须在调用前拒绝。
- 蒙版没有 Alpha 通道、完全不透明或完全透明时给出明确提示；前两项分别意味着无有效编辑区或整图重绘风险。
- 蒙版节点至少提供画笔、橡皮擦、撤销、重做、清空和反选，并把画布坐标精确映射到原图像素。
- 为严格保留融合窗口外的像素，必须在模型输出后用原图和本地融合蒙版做像素合成；不得向用户承诺模型自身会保持蒙版外逐像素不变。
- 透明图必须同时校验文件格式与实际 Alpha 通道；不得把白底、棋盘格或仅由提示词声称的“透明背景”当作真透明。

## 复核依据（2026-09-01）

- OpenAI Image generation 指南：https://developers.openai.com/api/docs/guides/image-generation
- OpenAI Images edits API：https://developers.openai.com/api/reference/python/resources/images/methods/edit/
- API易蒙版编辑：https://docs.apiyi.com/api-capabilities/gpt-image-2/mask-editing
- API易图片编辑：https://docs.apiyi.com/api-capabilities/gpt-image-2/image-edit
- API易透明背景：https://docs.apiyi.com/faq/image-transparent-background
