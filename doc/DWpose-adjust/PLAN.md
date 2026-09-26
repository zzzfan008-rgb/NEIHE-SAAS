# DWPose 骨骼关节点编辑实施计划

## 文档状态

- 状态：用户已授权实施并确认 2D 交互及先 2D 后 3D 的顺序，P4 3D IK 交互提案已确认并已接入；P0–P4 的阶段验证见 TODO 与 DEVELOPMENT-CYCLE。M2 聚焦闭环已验收；六项 1024px 额外目标已完成 baseline 对照、修正和复验，其中人物板小地图已在 1024px 收缩到 128×96 并恢复鼠标点击，五项测试断言已与当前行为对齐。P5 集中回归与 M4 范围内交付验收已完成，未迁移的 GitNexus gate、真实付费模型质量和无筛选全量浏览器 E2E 仍明确不在本批覆盖范围。当前代码变更仍以工作区既有差异为基线。
- 目标：在现有「人物姿势参考图」节点提供 2D 关节点编辑，并接入 3D IK 辅助调整；编辑结果继续作为原有换装流程的骨骼参考图。
- 顺序：先完成 2D 编辑、保存和下游使用闭环，再加入 3D IK。
- 技术栈：React、项目本地 shadcn 控件、React-Konva/Canvas、Node.js/Sharp、现有 Python DWPose 服务、PostgreSQL；不新增依赖，3D IK/投影由纯 TypeScript 数学和现有 Canvas 实现。
- [开发周期](./DEVELOPMENT-CYCLE.md)与 [TODO](./TODO.md)使用相同阶段编号 P0–P5。
- 本文是实施依据，不代表代码已实现或测试已通过。实施前核对当前源码与项目规则的变化。

## 1. 范围与成功标准

### 包含

1. 姿势节点和骨骼对比结果中的编辑入口。
2. 身体关节点、手部和脸部点的 2D 分层编辑。
3. 原图叠加、缩放平移、键盘微调、撤销重做、镜像和重置。
4. 结构化姿势数据、OpenPose JSON 导入导出及骨骼 PNG 渲染。
5. 应用到当前姿势、另存为骨骼节点、持久化和再次编辑。
6. 手臂与腿部双骨 IK、骨长约束、肘膝弯曲方向和 3D 到 2D 投影预览。
7. 旧骨骼结果兼容、项目权限、异步文档隔离及桌面端回归验证。

### 不包含

- 另行部署 ComfyUI，或将用户图片发送到外部在线编辑器。
- 完整人体蒙皮、自动避碰、手指 IK、动画时间轴。
- 宣称单张照片/骨骼 PNG 能唯一恢复真实 3D 姿势。
- 自动触发付费生成、提交、推送、合并、部署或 Docker 重建。
- 移动端适配，以及与本功能无关的节点、结果系统或架构改造。

### 成功标准

拖动关节后，编辑预览、保存 PNG 和重新打开的坐标一致；项目刷新、复制、撤销重做和切换项目不会丢失或串写姿势；下游仍识别为 skeleton。3D IK 不改变链段骨长，不产生异常坐标。1024、1280、1440 CSS 像素宽度下的布局和交互通过实测。

骨骼可编辑不等于生成模型必然精准遵循。真实换装效果需另行授权生成验证，不属于零付费回归测试的保证。

## 2. 现有事实与上游选型

### 本项目

- `scripts/pose/service.py` 的 `predict()` 已得到 `points/scores`，但随后只调用绘制并返回 PNG；原始关节点没有返回或保存。
- `server/lib/dwposeAnalysis.ts` 的适配器目前只接受 PNG，校验模型标识、checkpoint、大小和图像尺寸。
- `server/routes/poseReferences.ts` 将分析结果保存到 `pose_references.result` JSONB，可作为结构化数据扩展的起点。
- 现有入口链路为 `ImageInputNode` → `PoseReferenceComparison` → `poseReferenceRuntime` → 姿势服务。
- `addPoseReferenceImageNode` 已有文档目标检查和新增图片节点能力；默认不创建连线。
- `poseReferenceSource` 与具体图片引用绑定；DAG 使用有效的 `kind: skeleton` 选择骨骼提示词分支。
- React-Konva、Konva、Sharp 已由 lockfile 固定；`package.json` 另声明 `three@0.186.0`，但 lockfile 缺少 `node_modules/three`。本功能不依赖 Three.js、不新增包；该 manifest/lock 差异留作 P4 前的明确检查项。

以上为计划编制时的源码观察，实施前复核。CodeGraph 已检查相关符号影响；文档持久化、权限和跨语言服务仍须由源码及测试补足覆盖。

### 上游项目

| 来源 | 许可核对与用途 | 采用边界 |
| --- | --- | --- |
| [huchenlei/ComfyUI-openpose-editor](https://github.com/huchenlei/ComfyUI-openpose-editor) | GPL-3.0 ComfyUI 包装仅作交互参考 | 不复制包装或源码，不把它作为运行依赖 |
| [huchenlei/sd-webui-openpose-editor](https://github.com/huchenlei/sd-webui-openpose-editor) | MIT 源码仅作 OpenPose JSON 行为参考 | 本实现独立编写，不复制其 Vue/Fabric 代码，无需引入其运行依赖 |
| [Havlight/ComfyUI-3D-OpenPose-Editor2026_IK](https://github.com/Havlight/ComfyUI-3D-OpenPose-Editor2026_IK) | 仓库 pyproject 标 MIT，但 README 许可证仍是占位文字且无独立 LICENSE；仅研究 IK/投影思路 | 不复制代码；IK、求解器与投影独立实现。尚未选定或引入上游版本 |

已完成所列仓库许可元数据核对，但没有源码复用，也不新增依赖；因此无需因上游源码复制附加版权文件。选择原生 React 编辑器，不嵌入 ComfyUI 或远程 iframe。

## 3. UI 与交互方案

### 入口

- 「人物姿势参考图」节点工具条增加「编辑骨骼」。
- 姿势对比窗口的 DWPose 骨骼结果增加「编辑关节点」。
- 已有有效骨骼来源标记的图片节点可再次编辑，不要求先接入下游。
- 普通图片节点不因名称相似就获得骨骼身份；按语义标记和 pose 端口识别。
- 保留现有反推、深度图、查看、下载和添加到画布功能。

### 布局

采用桌面大弹窗，避免在小节点内堆叠编辑控件：

```text
骨骼编辑                              2D 编辑 / 3D IK
----------------------------------------------------
撤销  重做  重置  镜像  适应画布           导入/导出 JSON
----------------------------------------------------
                              | 当前人物 / 关节点
      原图叠加 + 骨骼画布        | 坐标 / 可见状态
                              | 背景透明度 / IK 设置
----------------------------------------------------
取消                  另存为骨骼节点     应用到当前姿势
```

- 所有通用控件复用 `src/components/ui/`，沿用 `data-theme` 与 `--gc-*`。
- 1024px 下编辑区可缩放、属性区内部滚动；底部确认操作始终可达，不增加页面横向溢出。
- 编辑器事件不传播给 React Flow；Delete、方向键、撤销和 Escape 不误操作画布节点。
- 支持关节列表选择和坐标输入，不能仅提供鼠标拖动；关闭后恢复入口焦点。
- 有未应用修改时关闭需确认；确认弹窗使用本地 AlertDialog。
- 编辑器按需加载，关闭时清理监听器、渲染循环及 Canvas 资源。
### 2D 行为

- 身体、左右手、脸部分层显示，选择一个人物进行编辑，其余人物数据不被丢弃。
- 身体点自由拖动；手腕移动时允许手部点整体跟随。
- 显示低置信度/缺失点，人工补点是显式操作，不自动补全未知姿势。
- 支持平移缩放、透明背景叠加、键盘微调、镜像、重置、撤销重做。
- 镜像须正确交换左右语义和点序，不只是反转 PNG。
- 编辑器局部历史按一次拖动/键盘操作组提交，不能每个 pointermove 写项目历史。

### 3D 行为

- 手腕为肩—肘—腕链的目标，脚踝为髋—膝—踝链的目标。
- 支持调整肘/膝弯曲方向；处理不可达目标、共线、零长度、缺失关节等退化输入。
- 提供正面/侧面/俯视、适应和复位；实时显示最终输出的 2D 投影。
- 初始 3D 骨架是人工调整的起点，界面明确其不是由单张图恢复出的真实深度。
- 3D 状态只有在用户确认应用时作为姿势业务数据保存；临时观察视角和面板状态不写入项目。
- 3D 后继续手改 2D 时，显式作废不再对应的 3D 状态或要求确认转换，不能无损往返的假象下覆盖用户修改。

### P4 具体交互与实现结果（已确认，已接入）

- 沿用现有骨骼编辑大弹窗、主题与本地 shadcn 控件；顶部切换「2D 编辑 / 3D IK」，不新增页面或导航。图像仅使用现有原图和骨骼数据，不生成或下载新素材。
- 1280/1440px：左侧为主要 3D 线框操作区，右侧 300px 属性栏上部展示固定输出相机的 2D 预览，下部展示人物、目标关节、目标 XYZ 和肘/膝弯曲方向；1024px 改为上下排列，内容内部滚动，底部取消/另存/应用操作固定可达。
- 仅当前人物参与 IK；拖手腕驱动肩—肘—腕链，拖脚踝驱动髋—膝—踝链。拖动位于当前观察平面，深度通过 XYZ 数值输入调整；同时支持键盘微调，不依赖鼠标。不可达目标截断到可达范围并提示；缺失或零长度链禁用对应目标，不自动补点。
- 观察区提供正面、侧面、近俯视（受 pitch ±89° 契约约束）、适应与视角复位；转动观察视角不改变输出。单独提供「将当前视角设为输出投影」，实时 2D 预览始终使用输出相机。
- 初次进入 3D 先提示这是人工调整起点，不是照片深度重建；按现有 2D 数据初始化平面骨架，不自动生成缺失关节。手部点随投影后的手腕整体平移，脸点随鼻点整体平移，不作伪 3D 旋转；六个足点通过 BODY_25 映射投影，缺失点和其他人物保持不变。依赖锚点缺失且会造成附件脱离时阻止应用并说明原因，不静默删点。
- 3D 修改保留在局部草稿；「应用投影到 2D 草稿」明确执行转换，可局部撤销；只有底部「应用到当前姿势 / 另存为骨骼节点」才写项目。2D 手改导致旧 3D stale 后，再进入时要求选择基于当前 2D 重建或取消，绝不直接恢复旧状态覆盖新编辑。
- 加载失败或 Canvas 不可用时提示原因并保留 2D 编辑；关闭时清理资源并恢复入口焦点。确认方案后依次覆盖 IK 退化输入、投影/附件、保存恢复和三个桌面宽度交互。

## 4. 数据与服务设计

### 数据流

```text
原始姿势图 → DWPose 结构化关节点 → 编辑草稿
         → 确认后的姿势数据 → 骨骼 PNG
         → 原有 pose 输入 → 多图编辑换装
```

### 姿势文档契约

新增版本化姿势文档 `PoseDocumentV1`，统一 TypeScript、Node 与 Python 边界：
- 顶层必填 `version: 1`、`canvas: {width,height}`、`people`、`source`、`imageBinding`；可选 `pose3d`。`imageBinding` 只允许本地图片引用或 `null`；新渲染尚未上传时为 `null`，持久化编辑稿必须等于节点当前图片引用。
- 坐标统一为原始分析图的像素坐标（原点左上、X 向右、Y 向下）；整数宽高 1–8192、面积不超过 40,000,000 px。服务归一化坐标在进 TypeScript 前按该画布还原。
- `people` 限 1–8 人，每人有稳定 UUID 和拓扑标识。`body` 固定 COCO-WholeBody-17；`feet` 为 6 点（左大趾/小趾/脚跟、右大趾/小趾/脚跟）；`face` 固定 70 槽；左右 `hand` 各固定 21 槽。
- 点类型为 `null | {x,y,confidence,origin}`；`origin` 为 `detected | manual`。检测点置信度保留 `[0,1]` 原值；人工点置信度固定为 1。置信度为 0 或源值缺失时转成 `null`；非有限/画布外坐标拒绝。低置信点保留供编辑，不因预览阈值而丢失。
- 每人拓扑字段精确标记 `coco-wholebody-133`、`openpose-body-18` 或 `openpose-body-25` 来源。3D 可选 `pose3d.body25`（BODY_25 固定 25 槽，含 neck/midHip/feet），每点为带置信度的 3D 点或 null；`x` 向右、`y` 向上、`z` 朝观察者，单位为人体身高。根为 midHip；3D 只解算身体，脸/手/足 2D 数据不丢弃。
- `pose3d.camera` 固定正交相机字段 `target:{x,y,z}`、`yawDeg[-180,180]`、`pitchDeg[-89,89]`、`scale[0.25,4]`；编辑器临时 orbit/zoom 留在局部状态，只有显式投影应用后才写入项目。body25 投影回原始画布后重建 COCO-17 body 与六个 feet 点。2D 身体被改动时旧 pose3d 标记失效；重建/丢弃须显式确认，绝不静默覆盖。
- `source` 保存本地 `analysisImage`、来源类型、模型/checkpoint 和可选分析记录 ID；不得放入远程 URL、文件内容或认证凭证。编辑稿大小限 512 KiB，导入 JSON 限 1 MiB。
- 服务原始 DWPose WholeBody 顺序固定 body[0..16]、feet[17..22]、face[23..90]、left hand[91..111]、right hand[112..132]；每人点数总计 133。
- OpenPose `BODY_25` → COCO-17 固定索引 `[0,16,15,18,17,5,2,6,3,7,4,12,9,13,10,14,11]`；`BODY_18` → COCO-17 固定索引 `[0,15,14,17,16,5,2,6,3,7,4,11,8,12,9,13,10]`。BODY_25 的 neck/midHip 用源索引 1/8；BODY_18 的 neck 用源索引 1、midHip 由双髋均值派生。
- OpenPose 导入仅接受 BODY_18 54 值或 BODY_25 75 值的 body 数组，face 204/210 值、每只手 63 值；可缺省/空数组的脸手足转成固定长度 `null` 槽。68 点 face 补两个缺失槽并标记原拓扑；导出固定 BODY_25 与 70 点 face，缺失点写 `[0,0,0]`。不支持的数组长度、压平错误、未知拓扑或远程资源引用整份拒绝；不静默忽略。
### 提取接口与兼容

- 保留现有 Python `POST /pose` 的 PNG 响应、token、超时和错误语义。新增 `POST /pose/v1`：同一请求体 `{image}` 与同一次规范化/推理，JSON 返回 `schemaVersion: 1`、宽高、模型/checkpoint、PNG base64 与 `people` 的 133 个归一化点；图像与坐标必须来自同次推理、尺寸一致。
- Node 适配器优先请求 `/pose/v1`；仅在其返回 404 时退回旧 `/pose`，该结果明确标记 `pose: null`、继续提供 PNG 并隐藏编辑入口。其他错误不降级。`DWPoseAnalysisResult.pose` 与 `PoseReferenceRecord.result.pose` 可选，旧 PostgreSQL JSONB 记录继续可读。
- `configuration`/缓存标识加入结构化协议版本；PNG-only 老结果不得伪装成结构化数据，也不得被编辑覆盖。新分析可重新提取结构化结果。
- 新增鉴权路由 `POST /api/pose-references/render`，请求 `{projectId,nodeId,source,poseDocument}`，返回 `{image: PNG data URL, poseDocument}`，返回文档 `imageBinding: null`，由客户端上传图片后绑定再应用。
- 路由要求登录，校验已保存项目、owner/admin、当前节点图片与 `source` 一致、源图本地可访问；校验完整 PoseDocument、512 KiB 文档和 40 MP 画布上限。源图/项目失效返回非泄露 404 或 stale-source 409；非法结构 400/422，超限 413；不接受任意 URL、SVG、文件路径或可执行内容。旧结果无 `pose` 仍可查看/下载，不需要迁移数据库表。
### 渲染与保存

- 共用拓扑、固定 18 色调色板及坐标变换；后端只从校验后的 PoseDocument 生成固定 SVG/PNG，SVG 模板/颜色/线型由服务端控制，前端预览按相同拓扑绘制，不接受用户 SVG。
- `POST /api/pose-references/render` 只负责规范化和生成未绑定 PNG；客户端按现有安全上传链上传，再用原有项目保存流程一次性应用图片与 PoseDocument，失败/取消不改项目历史。
- 图片与姿势版本绑定，避免 JSON 对应 A 姿势而 PNG 对应 B 姿势。
- 原始提取结果与人工编辑版本分离，不覆盖分析缓存。
- 新增来源图片引用须进入现有权限、引用收集和删除保护链路。

### 旧图片处理

- 有原始分析图：用户明确操作后重新提取结构化数据。
- 仅有骨骼 PNG：导入配套 OpenPose JSON，或提供人工描点。
- 不以 DWPose 对彩色骨骼 PNG 的再识别冒充原始关节点恢复。

## 5. 文档与下游接入

### 应用动作

- 「应用到当前姿势」：一次性更新当前节点的骨骼图与编辑数据，保留连线和原始图来源。
- 「另存为骨骼节点」：创建独立节点，不自动连线或触发生成。
- 「取消」：丢弃草稿，不改文档。

### 不变量

1. `ProjectTab[]` 与 `DocumentSnapshot` 仍是业务文档边界；只有已确认姿势进入持久化。
2. 原图、输出图、坐标数据、可选 3D 状态之间的对应关系可校验；替换图片后旧编辑绑定失效。
3. 保存绑定 `tabId + projectId + documentEpoch + nodeId + source + editRevision`；迟到响应不能覆盖新编辑或另一个文档。
4. 应用只增加一次项目历史记录，取消不增加历史；现有已生成结果不删除或隐藏。
5. 旧 `posePrompt` 不自动绑定到新骨骼图；避免旧的反推描述再次覆盖修改后的几何。
6. 输出保留 `poseReferenceSource.kind = skeleton` 并绑定新图片，下游沿用已有骨骼分支。
7. 临时关节选择、编辑器开关、缩放与观察状态留在局部 UI，不污染项目保存。
8. 读写检查 owner/admin、项目状态和文件访问权限；按现有策略返回非泄露性错误。

## 6. 实施阶段与文件范围

| 阶段 | 交付内容 | 主要文件（根目录相对路径） |
| --- | --- | --- |
| P0 | 契约、许可策略、用户交互确认和固定 JSON 样本 | `tests/fixtures/dwpose-adjust-contract.ts`；`doc/DWpose-adjust/PLAN.md`、`TODO.md`、`DEVELOPMENT-CYCLE.md` |
| P1 | 结构化提取、缓存兼容与保存渲染接口 | `scripts/pose/service.py`、`server/lib/dwposeAnalysis.ts`、`server/routes/poseReferences.ts`；拟新增 `server/lib/poseEditing.ts` |
| P2 | 2D 编辑器及入口 | 拟新增 `src/components/pose/PoseEditorDialog.tsx`、`PoseEditor2D.tsx` 和编辑历史模块；`ImageInputNode.tsx`、`PoseReferenceComparison.tsx` |
| P3 | 应用/另存、持久化和下游闭环 | `src/store/poseReferenceRuntime.ts`、`src/store/flowStore.ts`、`src/types/workflow.ts`、`src/lib/documentSnapshot.ts`、`server/lib/workflowSchema.ts`；沿实际引用链补齐权限/文件引用处理 |
| P4 | 3D IK 与投影 | `src/components/pose/PoseEditor3D.tsx`、`src/lib/poseIk.ts`、`src/lib/pose3dModel.ts`、`tests/pose-ik.test.ts`；复用现有 PoseEditorDialog、PoseDocument 和 Canvas，不新增依赖 |
| P5 | 集中回归和交付 | 姿势相关单元/API/运行时测试、三视口编辑器 E2E、六项 1024px 目标修正与复验、`check`/`build`、CodeGraph 和完整 diff 检查；未覆盖事实与 GitNexus gate 状态已记录；`gate:codex` 仍依赖 GitNexus 未执行，真实付费模型质量、无筛选全量浏览器 E2E、提交/部署不在本批范围 |

新文件名是计划名称，实施时若已有对应抽象则优先复用。DAG/runner 优先只验证骨骼契约；只有直接必要时才修改，不顺带重构生成链路。

## 7. 验证与门禁

### 分层验证

- 数据：点序、坐标变换、镜像、缺失点、68/70 点、JSON 往返和异常输入。
- 服务：PNG 兼容、结构化协议、模型/尺寸校验、缓存版本、权限和文件引用保护。
- 编辑器：真实拖动、键盘、缩放命中、撤销重做、取消、焦点恢复和事件隔离。
- 文档：刷新、复制、项目撤销重做、只读、切项目、换图、保存失败与迟到响应。
- IK：骨长、不可达目标、肘膝方向、退化输入、投影及 2D/3D 状态切换。
- 下游：DAG 收到新骨骼图片和 skeleton 标记，不携带旧图的反推提示词。

优先扩展 `tests/dwpose-service.test.py`、`tests/dwpose-analysis.test.ts`、`tests/pose-references-api.test.ts`、`tests/pose-reference-runtime.test.ts`、文档/schema/DAG 测试，并新增编辑数据、IK 和桌面 e2e 覆盖。禁止真实付费 provider 调用，使用现有隔离测试方式。

### 交付检查

- 修改前重新运行相关 CodeGraph impact，保留现有未提交改动。
- 运行相关聚焦测试、`npm run check`、`npm run build`、`git diff --check`。
- PostgreSQL 测试与 e2e 由项目既有隔离 runner 管理生命周期。
- 编辑器 e2e 在 1024/1280/1440 下验证真实几何和交互，不以类名匹配代替。
- 交付前 CodeGraph sync/affected 包括新增源码文件，并检查完整 diff。
- 当前 `gate:codex` 仍依赖 GitNexus，不运行，不宣称完整 gate 通过。
- 每个失败都记录本次影响或既有问题证据；未解决的阻塞不得标记为通过。

## 8. 风险与停止条件

| 风险 | 处理 |
| --- | --- |
| 上游授权不明确 | 不复制相应源码；独立实现或取得明确授权后再评估 |
| 2D 无法确定 3D 深度 | 显式提示、人工调节；不承诺自动真实重建 |
| 老缓存只有 PNG | 继续支持查看/下载，用户主动重提取或导入数据 |
| 坐标与图片错位 | 同一次规范化、统一映射、尺寸/方向/缩放回归 |
| 手脸点被 3D 转换丢弃 | 保留分层数据，显式变换；不支持时阻止破坏性转换 |
| 保存越界/迟到覆盖 | 目标文档与编辑版本校验，失败保留草稿，不替换旧结果 |
| UI 或资源泄漏 | 桌面宽度实测、按需加载、关闭后清理监听器/GPU资源 |
| 人物板未提交改动冲突 | 基于当前工作区实施，仅编辑本任务直接必要范围，不 stash/reset 覆盖 |

若需改变已确认交互、引入新依赖、复用授权不明确源码、扩大到其他功能或执行外部写操作，先报告并取得确认。
