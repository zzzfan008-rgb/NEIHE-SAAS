# DWPose 骨骼编辑开发 TODO

关联：[实施计划](./PLAN.md) · [开发周期](./DEVELOPMENT-CYCLE.md)

## 使用规则
- 本轮已获授权并进入实现；P0/M0、P1/M1、P2 已验收，P3/M2 聚焦验证有通过记录；P4 具体交互提案已确认并已接入。六项 1024px E2E 失败已在 HEAD clean baseline 与当前工作树复现并归类：五项为测试断言与现有行为不匹配；人物板按钮另暴露小地图遮挡鼠标点击，已获用户确认在 1024px 视口将小地图缩至 128×96 并保留导航能力，人物板点击与 1024/1280/1440 三视口尺寸回归已通过。
- `[ ]` 为未完成，`[x]` 为已完成；执行中的项附注「进行中」，有阻塞的项附注阻塞原因。
- 每项保留稳定编号；只有实现和对应验证都完成才勾选，不能将跳过/不可用写成通过。
- 同时仅一个主要任务进行中。常规依赖顺序为 P0 → P1 → P2 → P3 → P4 → P5；本轮 P4 经用户明确授权先行实现。六个 baseline 失败归因与修正证据仅覆盖所选 1024px 用例，不得据此宣称全量 E2E 通过。
- 证据记录命令、退出码、测试结果、路径或关键 diff；不得记录密钥、真实用户图片或数据库转储。
- 本次新增固定契约样本 `tests/fixtures/dwpose-adjust-contract.ts` 与三份开发计划文档；原有人物板相关 8 个已修改文件及 `tmp_gc_records.tsv`、`tmp_gen_dump.json` 保持原状。

## P0 — 契约与准备（D1–D2）

前置：用户明确授权实施并确认过交互方案。
- [x] P0-01 冻结已确认的 2D 编辑器布局、入口、应用/另存行为及先 2D 后 3D 的分阶段方案。
- [x] P0-02 读取项目规则和现有差异并检查 CodeGraph。`codegraph status .` up to date：460 files/8,101 nodes/30,628 relations；原有 8 个源码/测试改动与两个临时文件均保留。impact 已记录 `analyzeDWPoseReference`（4 nodes/4 edges）、`createPoseReferencesRouter`（5/5）、`PoseReferenceRecord`（14/16）、`createDocumentSnapshot`（69/113）、`createDocumentNodeData`（5/4）；快照序列化影响面较广，后续按实际调用链补充核查。
- [x] P0-03 核对三个上游仓库许可元数据；不复用任何上游代码，无新增运行依赖。3D IK 独立实现；React-Konva/Sharp 使用现有锁定依赖。`three@0.186.0` 虽在 package.json，lockfile 缺 `node_modules/three`，本功能不使用 Three，列为 P4 前核验项。
- [x] P0-04 冻结 `PoseDocumentV1`：画布像素坐标、1–8 人、COCO-17 body、6 feet、70 face、左右各 21 hand、稳定 UUID、`null | {x,y,confidence,origin}`、source/imageBinding、可选 25 点 3D body/camera；画布不超过 40 MP，文档 512 KiB。
- [x] P0-05 冻结 DWPose-133 分组、BODY_18/BODY_25 到 COCO-17 的映射、neck/midHip 规则、face68 补两缺失槽并保留来源标识、OpenPose 导出 BODY_25+face70；未知点序/长度拒绝。
- [x] P0-06 冻结 Python `/pose/v1` 结构化协议、旧 `/pose` PNG 兼容、仅 v1 返回 404 时 Node 回退、缓存版本标记、`POST /api/pose-references/render` 请求/响应/尺寸限制/owner 源图权限/错误行为；老 JSONB 结果无 pose 仍可读。
- [x] P0-07 冻结 `pose3d.body25` 25 槽（含 neck/midHip/feet）、midHip 根、人体身高单位与 x-right/y-up/z-toward-viewer 坐标；固定正交相机 target/yaw/pitch/scale 范围。仅 body25 做 3D IK/投影，脸手足 2D 保留；临时 orbit/zoom 留在 UI，只有显式应用投影时持久化。2D body 改动将旧 3D 状态标 stale，重建或丢弃须确认，不静默覆盖。
- [x] P0-08 新建无私有图的固定样本 `tests/fixtures/dwpose-adjust-contract.ts`，包含 1600×900 双人交叉腿、BODY_25/BODY_18 混合、face68/70、置信度为 0 的缺失脚趾、单手与双手遮挡、900×1600 竖图和非法 JSON/远程图引用。
- [x] P0-09 M0 验收通过：交互获用户确认，数据/映射/API/许可边界无待决歧义，固定坐标样本已落盘。原 16 天基础估算仍成立；P0 计入 2 天，剩余 P1–P5 14 天，另留 3 天缓冲。

## P1 — 提取与保存服务（D3–D5）

前置：P0 完成。

- [x] P1-01 在 DWPose 服务新增结构化结果能力，同时保留 `/pose` PNG 接口。
- [x] P1-02 保留规范化坐标、scores、宽高和模型元信息，确保与同一次推理图像一致。
- [x] P1-03 保持 token、超时、请求限额、模型/checkpoint 校验及无人/过多人物/繁忙错误处理。
- [x] P1-04 扩展 Node 适配器、分析结果类型和现有 result JSONB 的读写；旧记录可正常读取。
- [x] P1-05 更新缓存版本，区分 PNG-only 与可编辑结果；人工编辑不覆盖原始推理缓存。
- [x] P1-06 实现共享点序、颜色与坐标转换规则，以及受控骨骼 PNG 渲染。
- [x] P1-07 实现编辑保存接口；限制大小/人数/点数/坐标，禁止任意远程引用与用户 SVG 执行。
- [x] P1-08 验证项目、源图和文件归属；沿实际引用链完善资产引用与删除保护。
- [x] P1-09 覆盖 PNG 兼容、结构化协议、坐标/尺寸/EXIF、非法输入、缓存和权限测试。
- [x] P1-10 M1 验收：新协议可用、旧路径无退化、保存的图像与姿势版本匹配。

## P2 — 2D 编辑器与入口（D6–D9）

前置：P0 固定契约，集成依赖 P1。

- [x] P2-01 新增懒加载编辑弹窗；通用控件使用本地 shadcn，沿用项目主题。
- [x] P2-02 接入人物姿势节点、对比窗口和有效 skeleton 图片节点入口，不误识别普通图片。
- [x] P2-03 实现原图叠加、透明度、适应画布、平移缩放和正确的屏幕到图像坐标映射。
- [x] P2-04 实现人物选择、身体/左右手/脸部分层显示和点选择，保留未编辑人物与足部数据。
- [x] P2-05 实现身体/手脸点拖动、坐标输入、方向键微调和手腕带动手部点。
- [x] P2-06 明确低置信度/缺失点状态并支持人工补点，不自动猜测不可见姿势。
- [x] P2-07 实现局部撤销重做、重置、语义镜像；拖动只提交一次局部历史。
- [x] P2-08 实现 OpenPose JSON 导入导出及格式错误提示，拒绝未知拓扑和超限数据。
- [x] P2-09 旧 PNG 无坐标时提供重提取、JSON 导入或人工描点；服务未升级时明确说明。
- [x] P2-10 实现焦点恢复、未保存关闭确认和 React Flow 事件隔离；清理监听器。
- [x] P2-11 验证拖动、缩放命中、镜像点序、手部跟随、历史、键盘与导入导出往返。
- [x] P2-12 阶段验收：编辑器可独立操作，1024/1280/1440 下没有工具条或底部操作遮挡。

## P3 — 文档与生成闭环（D10–D11）

前置：P1、P2 完成。

- [x] P3-01 扩展 image-input 数据、DocumentSnapshot 白名单和服务端 schema，保留旧文档兼容。
- [x] P3-02 实现目标感知的编辑会话，绑定 tabId/projectId/documentEpoch/nodeId/source/editRevision。
- [x] P3-03 实现「应用到当前姿势」：图像+坐标一次提交，保留连线和原图来源。
- [x] P3-04 实现「另存为骨骼节点」：保存编辑数据，默认不自动连线、不触发生成。
- [x] P3-05 取消不改项目；应用只增加一次项目撤销项；现有生成结果不删除/隐藏。
- [x] P3-06 处理换图、删节点、切项目、只读、保存失败、重复点击和迟到响应；失败保留草稿。
- [x] P3-07 更新 skeleton 标记与图片绑定，避免旧 posePrompt 绑定到新骨骼图；验证下游失效处理。
- [x] P3-08 验证刷新再编辑、复制、项目撤销重做和序列化往返；UI 临时状态不进入文档。
- [x] P3-09 覆盖姿势 runtime、schema、snapshot、文件权限和 DAG 的聚焦回归，不调用付费 provider。
- [x] P3-10 M2 验收：三个桌面宽度的「打开→拖动→应用/另存→刷新→再次编辑→下游读取」聚焦闭环已有通过记录；HEAD clean baseline 与当前工作树的六项 1024px 额外 E2E 断言失败签名一致（人物板小地图遮挡、绘图抗锯齿像素、通用输入包含隐藏兼容句柄、start-new 上传为 JPG、Gemini 3 Pro 可选、场景输入 12 行），确认与本轮 P3/P4 无关。P5 已逐项修正这些测试与现有行为不匹配之处并通过 6/6 目标用例；baseline 运行非全量通过证据。
## P4 — 3D IK 与投影（D12–D14）

前置：已获用户明确的 P4 3D 交互实施授权；M2 聚焦闭环已验收，六个额外目标失败已归因于 HEAD baseline，P5 继续负责全量残余。

- [x] P4-01 独立实现双骨 IK 纯逻辑，固定骨长、目标可达性和弯曲方向约定。实现位于 `src/lib/poseIk.ts`，由 `tests/pose-ik.test.ts` 覆盖。
- [x] P4-02 覆盖不可达、共线、零长度、缺失点和连续拖动的纯逻辑边界；不可达目标夹紧、退化输入拒绝并检查有限坐标。
- [x] P4-03 新增懒加载 Canvas 2D 线框视图，使用纯 TypeScript 投影数学；显式说明初始 3D 骨架不是照片真实深度重建，不安装 Three.js。
- [x] P4-04 接入手腕/脚踝拖动、肘膝方向、正面/侧面/俯视和复位；目标不可达时显示夹紧状态，缺失链条不自动补点。
- [x] P4-05 建立固定的输出投影及实时 2D 预览，与临时观察相机状态分离；观察视角仅留在编辑器 UI。
- [x] P4-06 保留手脸足数据；3D 投影更新身体与足部，手部随对应手腕平移、面部随鼻尖平移，缺少锚点时保留原始附件。`tests/pose-ik.test.ts` 覆盖跟随与未关联数据保留。
- [x] P4-07 保存已确认 3D 状态及投影；3D 编辑进入草稿历史，应用/另存时才写入项目，手改 2D 会将旧 3D 状态标记为 stale 并在重新进入 3D 时重建。
- [x] P4-08 关闭时由 React/ResizeObserver 清理组件资源，未引入 RAF 或全局监听器；Canvas 不可用时明确提示，2D 编辑路径不受影响。
- [x] P4-09 验证 IK 数学、附件投影、模式切换、视角预设、保存恢复和三个桌面宽度操作；聚焦单元测试与 `e2e/pose-reference.workbench.spec.ts` 记录在阶段证据中。
- [x] P4-10 M3 验收：聚焦数学与 3D 工作台验证确认骨长约束、固定输出投影/实时预览一致、有限坐标和 2D 回退路径；`pnpm run check` 与 `pnpm run build` 均退出码 0。

## P5 — 集中回归与交付（D15–D16）

前置：P0–P4 完成，阶段验证均已通过。

- [x] P5-01 复查原图/骨骼/深度/提示词/查看/下载/添加画布流程，保留已有能力：已沿 `ImageInputNode`、`PoseReferenceComparison`、`poseReferenceRuntime`、`PosePromptInferenceDialog` 及结果操作链核对，未删除或降级既有入口；主闭环三视口 E2E 4/4、六项 1024px 目标 11/11（含 setup）及人物板三视口回归通过。
- [x] P5-02 运行结构化数据、DWPose、API、runtime、schema、snapshot、DAG 和 IK 相关测试：`pnpm run test` 退出码 0；结构化协议、DWPose、pose references、document persistence、runtime/schema/snapshot/DAG、编辑器模型/历史与 IK 相关测试均通过，未调用付费 provider。
- [x] P5-03 运行姿势编辑器与基线目标 E2E：`pnpm run test:e2e -- e2e/pose-reference.workbench.spec.ts` 在 1024、1280、1440 三项目 4/4 通过；六个基线目标文件在 1024px 共 10 项 + setup 复跑 11/11 通过；人物板专用 E2E 跨 1024/1280/1440 为 3 项 + setup 通过。回归覆盖 1024px 小地图 128×96 且按钮可鼠标点击，1280/1440 保持 200×150；其他断言修正覆盖抗锯齿像素、可访问的通用输入、上传合法图片扩展名、Gemini 3 Pro 选项及 12 行场景输入。
- [x] P5-04 执行 `pnpm run check`、`pnpm run build`，记录真实退出码与结果：最终 `pnpm run check` 退出码 0（225 秒），此前独立 `pnpm run build` 退出码 0；check 完成 TypeScript、web build、CSS/bundle 校验和 PostgreSQL 测试。首次 check 的 PostgreSQL 初始化出现一次 `ECONNREFUSED 127.0.0.1:55372`，清理残留进程后重跑通过，未发现产品失败。
- [x] P5-05 执行 CodeGraph sync/affected，包含本轮变更源文件：`codegraph sync .` 完成；基于 51 个变更源文件运行 `codegraph affected ... -p . -j`，得到 120 个受影响测试、318 个依赖遍历节点。
- [x] P5-06 检查完整变更范围与 `git diff --check`：`git diff HEAD --check` 通过；保留已有人物板、服务、store、E2E 和测试差异，`tmp_gc_records.tsv`、`tmp_gen_dump.json` 等运行时产物未纳入本轮文件写入。
- [x] P5-07 主线程做一次集中范围复查；已沿 `PoseReferenceComparison → poseReferenceRuntime → flowStore/documentSnapshot → DAG/runner/schema`，以及 `PoseEditorDialog/PoseEditor2D/PoseEditor3D/poseIk/pose3dModel` 调用链复查；未发现需要扩大范围的问题，修复 1024px 小地图遮挡后已重新执行 check、目标 E2E、CodeGraph affected 和 diff 检查。
- [x] P5-08 记录 GitNexus 迁移前 `gate:codex` 不可用：按项目规则不执行仍调用 GitNexus 的 gate，也不把它算作通过；保留独立的 test/check/build、diff 和 CodeGraph 证据。
- [x] P5-09 M4 验收：本批范围内实现、回归和文档记录完成；六项基线目标已修正并通过，未留下关键未解决失败。未覆盖事实为未执行依赖 GitNexus 的 `gate:codex`、未做真实付费模型质量验证、未跑无筛选的全量浏览器 E2E；提交、推送、合并、发布、部署仍不在授权范围内。

## 另需授权，不计入开发完成

以下不是自动执行的后续步骤，不作为 P0–P5 完成的必需项：

- 真实付费模型换装生成及图片质量对比。
- 提交和推送本批改动。
- 合并、发布、Docker/localhost 同步或部署。

## 阶段证据与阻塞记录

| 阶段 | 当前状态 | 验证证据 | 阻塞 / 未覆盖项 | 实际工作量 |
| --- | --- | --- | --- | --- |
| P0 | 已通过 | `PLAN.md`/`TODO.md`/`DEVELOPMENT-CYCLE.md` 已同步；用户确认交互；姿势/API/许可契约与固定 fixture 已核对 | 无；进入 P1 | — |
| P1 | 已通过 | `node scripts/test-with-postgres.mjs` 退出码 0；结构化协议、旧 PNG 兼容、坐标/尺寸/缓存、权限与受控渲染测试通过 | 无；进入 P2 | — |
| P2 | 已通过 | `node scripts/test-with-postgres.mjs` 退出码 0；编辑器模型/历史回归通过；三视口姿势工作台 E2E 4/4（含 setup）通过 | 无；进入 P3 | — |
| P3 | 聚焦阶段验证已通过；额外目标已完成 baseline 归因 | `node scripts/test-with-postgres.mjs` 退出码 0；runtime/schema/snapshot/DAG/权限等回归通过；主闭环三视口 E2E 4/4（含 setup）通过；追加 4 项直接下游 E2E 在 1024/1280/1440 共 13/13（含 setup）通过；HEAD clean baseline 与当前工作树的 1024px 目标运行均复现六项相同断言失败 | 六项失败是 baseline 既有问题，转入 P5；未执行或未通过的全量 E2E 不作通过声明 | —
| P4 | 已实现并完成 M3 聚焦验收 | `pnpm exec tsx tests/pose-ik.test.ts` 8/8；`pnpm exec tsc --noEmit`、`pnpm run check`、`pnpm run build` 均退出码 0；`pnpm run test:e2e -- e2e/pose-reference.workbench.spec.ts` 在 1024/1280/1440 三项目 4/4 通过；构建产物包含独立 `PoseEditor3D` chunk，3D IK、投影、附件跟随、模式切换、视角预设、输出投影按钮和现有保存恢复路径已覆盖 | M2 聚焦闭环已关闭；六项额外目标与 HEAD baseline 同失败签名，转入 P5；整体交付仍不宣称通过 | —
| P5 | 已完成 | `pnpm run test`、最终 `pnpm run check`、`pnpm run build` 均退出码 0；姿势工作台、六项 1024px 目标和人物板三视口 E2E 通过；`codegraph sync .` 与 51 个源文件的 affected 复核完成；`git diff HEAD --check` 通过；P5-01/P5-07/P5-09 已完成 | 未执行依赖 GitNexus 的 `gate:codex`、真实付费模型质量验证和无筛选全量浏览器 E2E；提交、推送、合并、发布、部署未授权 | — |
