# TiAngelNode — 开发 TODO

## 2026-09-21 兼容批次（优先于下方历史完成记录）

- [x] 接入 local 已提交版本 `8fdbf3c923e9e6c5414d7688d627e085ded1f0c1`，不读取主工作区未提交改动作为实现基线。
- [x] 内置模板移除角度节点及默认边，侧栏创建保持无自动连线。
- [x] 增加 Gemini 3 Pro 适配，保留第一轮四模型准入。
- [x] 兼容 composed-person 和独立姿势评审；启用角度时按目标镜头投影，关闭时保留 local 原行为。
- [x] 完整 `pnpm run check` 通过（类型检查、前端构建、隔离 PostgreSQL 全套测试）；`pnpm run build` 前后端构建通过；`git diff --check` 通过。
- [x] CodeGraph sync/affected 已执行，覆盖 108 个源码及测试文件（包含本次从 local 接入的新文件），关联 90 个测试文件；图结果非穷尽证明。
- [x] 1024/1280/1440 专项 Playwright 回归 31 项通过：侧栏添加、手动拖线与角色确认、模型切换、折叠及恢复、Three.js 拖动隔离、资源异步隔离、正式保存重开、只读与焦点、多目标输出、子图复制撤销、原换装上传链路。
- [x] 补充 local 预合成、可选姿势/精修、异步风格预设隔离及模板克隆角色回归：16 项通过，覆盖三种桌面宽度。旧断言已按当前端口与模型控件更新，未改动这些产品行为。
- `gate:codex` 仍依赖 GitNexus，遵循项目禁用规则未运行，不宣称完整本地审查门禁通过。真实生成效果未验证。
- 未授权且未执行：真实 AI 生成、提交、合并、部署。

以下为初版模板绑定版本的历史证据，不代表本兼容批次已完成。

日期：2026-09-18。基线：[PRD v0.2](TiAngelNode-PRD.md)。配套：[开发计划](../docs/plans/2026-09-18-tiangel-node.md)、[开发周期](TiAngelNode-Schedule.md)。

状态：**T00–T08 工程开发与自动化验收已完成，T09 真实效果尚未完成**。TiAngelNode 的模型文本、文档持久化、端口与计划、运行提示词、队列快照、Three.js 控件、侧栏入口、一键换装模板和完整结果链路均已有可复核证据；PRD A01–A14 的工程验收矩阵已汇总。当前仅剩需用户另行确认素材、模型矩阵、调用量和费用上限后才能执行的 T09 真实生成效果验收。真实生成、提交、合并、发布和部署各自遵循授权边界。

## T00 — 开发前基线

- [x] 收到功能开发授权；记录 base/head、工作树已有变更和环境版本。
  - 当前 worktree：`/Users/neihe/.codex/worktrees/f1d7/NEIHE-AI`；base/head：`2e274e4`；Node `v24.20.0`；pnpm `11.19.0`。
  - 工作树既有未跟踪文档、`.pnpm-store/` 和其他用户变更均保留，未修改主工作区。
- [x] 复核 PRD 和具体 UI 尺寸/位置提案；仅对未确认布局取得确认。
  - PRD v0.2 已确认 Three.js 控件布局、折叠输出、侧栏创建和桌面宽度范围；后续 UI 仍按已确认方案实现。
- [x] CodeGraph status/sync，现有符号 impact；图缺口用源码和测试补齐。
  - 已初始化并完成同步；当前索引 378 files / 6450 nodes / 24285 edges，状态为 up to date。
  - 已对 `NodeKind`、`WorkflowNodeData`、`NODE_SPECS`、快照、Schema、Store、DAG、Runner 等现有符号完成 impact。
- [x] 核实服务端基准确认/运行输入指纹链，记录是否需补元数据。
  - 已确认可复用现有 `generation_runs.request_fingerprint`，无需新增数据库列；`server/lib/executionInputFingerprint.ts` 统一入队和第二轮校验的 SHA-256 输入边界。
- [x] 核实测试 runner、本地 shadcn 原语、节点注册及创建入口。
  - 测试 runner 和现有 shadcn 原语已盘点；TiAngelNode 已注册到 React Flow、旧节点库和实际 ToolRail 添加目录。文本折叠使用项目本地 `src/components/ui/collapsible.tsx` 原语。

## T01 — 参数与模型文本

- [x] 三轴、启用开关、1°提交、范围和方向测试先失败后通过。
- [x] ±180°、-0、半档边界、NaN/Infinity/字符串/缺字段校验。
- [x] 共享纯语义编码器和版本化适配器不依赖 DOM/Three.js。
- [x] 8 个 ImageModelId 均显式注册并有快照测试；未知 ID 拒绝。
- [x] 禁用为空、启用全零为明确视角；不输出 Qwen token，不增加 Provider 参数。
- [x] 新测试加入既有测试清单；提交参数、语义和每模型输出一致。

## T02 — 文档、恢复与历史

- [x] kind、默认数据、NODE_SPECS、快照及服务端 schema 全链路支持。
- [x] 使用下一个可用 schema 版本，旧文档不插节点/连线、不自动启用。
- [x] 保存、重开、草稿恢复、复制粘贴、模板克隆、边 ID 重映射通过。
  - 文档快照、Schema、默认数据和旧文档兼容已完成；模板克隆与选中子图复制均已覆盖节点/边 ID、内部边和 `autoConnectTargets`、`resultNodeId` 重映射。`tests/ti-angle-persistence.test.ts` 实测会话分片写入→读取保留协议字段、排除 `dragState/compiledText/collapsed/renderer`；`e2e/workbench.spec.ts` 通过真实 PostgreSQL 与 HTTP 链路保存 `123°/-17°/12°`、显示图/文本边和 `autoConnectTargets`，关闭页签后从项目中心重开并刷新，确认数据与连线不变，运行时字段未落盘且文本输出恢复为默认折叠。
- [x] 一次拖动一次历史记录，无变化不记录；撤销重做恢复一致。
  - `e2e/workbench.spec.ts` 在三桌面验证同值重置不新增历史、一次拖动只新增一条历史，并验证撤销/重做恢复角度。
- [x] 折叠、纹理、renderer、拖动临时值不进入文档/会话/业务 Store。
  - 文档快照对 TiAngelNode 角度字段使用五项显式白名单；会话分片 JSON 实测不含 `dragState`、`collapsed`、`compiledText`、`renderer`。纹理生命周期和拖动事务仍由 T06 的浏览器证据覆盖。
- [x] tabId/projectId/documentEpoch 绑定及迟到回调丢弃测试通过。
  - `tests/project-tabs.test.ts` 覆盖旧保存响应、旧上传回写与运行预检不得穿透同页签新 `documentEpoch`；`tests/project-tabs-session.test.ts` 覆盖页签绑定的运行结果与恢复。与 T04 冻结队列快照和 T06 延迟 TextureLoader 丢弃的已有证据合并，已覆盖 TiAngelNode 的文档、运行与纹理回写边界。

## T03 — 端口与计划

- [x] 可选 preview-image 只接图片类来源（图片输入或人物板输出）；单一 angle-direction 只接 ti-angle。
- [x] 多来源、错误类型、第二阶段、非法环前后端一致拒绝。
- [x] 显示图边不增加 Provider 图片、生成依赖和图片配额；缺图不阻断文本。
- [x] 服务端从保存文档按目标模型重新编译并冻结 angleControl。
- [x] 单节点运行无需先运行角度节点；整图数据步骤无图片、无费用、无 AI 请求。
- [x] 8 模型适配保持，但一键换装仍只允许原 3 模型。
- [x] 图/提交计划不一致拒绝；鉴权、原必需图及图序不变。
  - `tests/authorization.test.ts` 将已保存 TiAngel 方位角只在客户端提交计划中改为 `-55°`，服务端返回现有 409 冲突且未创建 Run；其他账号仍在计划比较前返回 403。`tests/ti-angle-ports.test.ts` 证明接入角度前后四张必需图、顺序和上游依赖完全一致，文本边不计图片配额；非法第四种换装模型仍在 Provider 前拒绝。

## T04 — 运行与基准保护

- [x] 场景/姿势/样式镜头冲突按维度消除，保留身份和服装约束。
  - `server/engine/runner.ts` 在角度开启时明确由 TiAngel 独占相机环绕、俯仰和 roll；场景仅控制空间/材质/色彩/光线并允许重建透视，姿势只保留动作与关节相对关系后按目标镜头重投影，身份和服装锁定规则保持。`server/lib/tryOnCandidateSelection.ts` 同步调整候选评审，避免把正确的新镜头误判为偏离原场景构图。
- [x] 正常、关闭增强、安全回退的最终 mock 请求保留相同角度。
  - `tests/ti-angle-execution.test.ts` 覆盖正常 edit、增强成功、增强失败回退及 content_refused 安全回退；所有最终生成/评审提示均保留同一冻结角度。
- [x] 仅改角度不触发额外增强请求；关闭分支与原行为一致。
  - `tests/ti-angle-execution.test.ts` 在 `promptEnhancement=true` 且只有角度时断言增强器调用数为 0、Provider 请求数仍为 1；移除 angleControl 后继续使用原场景镜头/二维姿势措辞且不出现 TiAngel 文本。
- [x] 有效角度修改原子更新 basisRevision；显示图变化不单独失效。
  - `tests/ti-angle-basis.test.ts` 覆盖 TiAngelNode 配置变更、单次历史记录和第一轮场景基准递增，并验证撤销精确恢复角度、基准输出、版本与审批，重做再次令旧审批失效；连线增删复用既有 Store 原子路径，展示图不进入 angle-direction 路径。
- [x] 旧图不能仅凭客户端审批字段重新确认；第二轮服务端校验完整运行输入指纹。
  - `server/routes/runPlan.ts` 按 owner/project/node、完整执行计划指纹、成功 Run 和成功输出图片共同核验；缺少第一轮成功执行或指纹不匹配时 fail-closed。`tests/authorization.test.ts` 已验证伪造 `approvedBaselineRef/approvedBasisRevision` 且没有第一轮 Run 时被拒绝；补齐匹配的第一轮成功 Run 后第二轮可入队，TiAngel 方位角变化并伪造新版审批字段后，旧成功图仍因指纹不匹配被拒绝。
- [x] 运行期间改值、重试/重启仍使用旧快照，旧结果保留且正确标识。
  - `tests/run-queue.test.ts` 在入队后两次修改内存角度，注入首轮 503、数据库关闭重连和队列重试，两个 mock Provider 请求均使用入队时原始角度文本，持久化 `step_json` 也保持原快照；既有结果生命周期测试继续覆盖旧结果保留和终态标识。
- [x] 已入队第二轮不被改写；撤销按完整输入匹配；跨项目恢复正常。
  - 授权集成已验证第二轮入队后保存新角度不会改写该 Run 的 `plan_json` 或 `request_fingerprint`；角度漂移被拒绝后恢复原始完整文档可重新通过门禁；相同文档保存到另一项目时不能复用原项目第一轮成功记录。既有结果回归继续覆盖跨项目跳转与恢复。

## T05 — 节点与文本界面

- [x] 侧栏可点击/键盘创建；默认关闭、无连线、无 AI 运行按钮。
  - ToolRail/ToolFlyout 工具目录与静态节点渲染测试通过；浏览器键盘与焦点恢复留 T08。
- [x] 本地 shadcn 参数控件、预设、重置、开关及可访问折叠原语。
  - 已接入本地 Button、Input、Slider、Switch 和新增 `src/components/ui/collapsible.tsx`；六个 PRD 预设、重置三轴、关闭时禁用编辑、`aria-expanded`/`aria-controls` 均已实现。
- [x] 默认只有“查看输出文本”，无正文、首行和摘要；展开可复制。
  - `e2e/workbench.spec.ts` 的 TiAngelNode 输出交互用例在 1024/1280/1440 验证默认折叠、展开、复制成功和复制失败后的可选文本保留。
- [x] 未连接明确显示未绑定模型描述；多目标分别显示模型及输出。
  - 同一用例验证两个下游分别显示接收节点、当前模型和各自文本；无连接路径仍显示通用未绑定模型描述。
- [x] 切下游模型同步更新，不展示旧适配文本、不自动展开。
  - 输出面板按当前边目标实时从节点 `modelId` 编译，模型变更不会写入文档或自动打开面板。
- [x] 键盘、焦点恢复、复制失败及只读状态验证通过。
  - 同一用例验证折叠关闭后触发器恢复焦点、复制失败不隐藏文本；只读项目中开关/预设/数值输入/3D 预览均禁用，但查看和复制仍保留。

## T06 — Three.js 控件

- [x] 锁定依赖及 lockfile，3D 模块懒加载，不引入第二套业务状态。
  - `three@0.186.0`、`@types/three@0.186.0` 已写入 `package.json`/`pnpm-lock.yaml`；运行时适配层与 WebGLRenderer 均通过动态 import 加载，拖动草稿只保存在组件本地。
- [x] 中心图片 contain、轨道/弧线、相机球、方向线和方位标记。
  - `TiAnglePreview.tsx` 使用 `containImageRect`、轨道/俯仰弧线、相机球、方向线和 roll 取景框；`ti-angle-geometry.test.ts` 与三桌面 Playwright 用例通过。
- [x] 外部观察相机固定，roll 仅改变取景框；明确约定正面与非生成预览。
  - 固定 OrthographicCamera；角度球使用统一正面/+X 人物左侧坐标，roll 仅更新 frame marker；预览标注“示意参考图”，不宣称生成结果。
- [x] 球/单轴手柄拖动、抓取偏移、背面遮挡和 ±180°接缝通过实测。
  - `TiAnglePreview.tsx` 使用 Three.js `Raycaster` 对相机球、方位角手柄和俯仰角手柄做显式命中；中心图片平面参与最近交点判定并遮挡背面球/手柄，空白区域不启动拖动。拖动继续使用相对位移，保留抓取偏移且不吸附；纯函数覆盖 `170° + 14° → -176°` 接缝。三桌面 E2E 验证斜向拖动方位角/俯仰角手柄只改变对应单轴，roll 保持独立参数控件。
- [x] React Flow 手势隔离、滚轮行为、pointer capture、取消手势正确。
  - 预览 canvas 使用 `nodrag nopan`、事件停止传播、pointer capture、pointercancel/Escape/失焦取消；浏览器回归确认拖动不移动节点。滚轮未被预览拦截，保留画布原行为。
- [x] 图片鉴权读取、缺图占位、异步换图/切页/删节点无迟到资源污染。
  - `e2e/workbench.spec.ts` 已用延迟失败响应覆盖异步换图、切页、删节点的迟到回调丢弃；真实浏览器路由响应验证鉴权 cookie、加载中→已加载状态及成功换图；缺图占位与 TextureLoader/renderer teardown 已实现，背面命中专项确认图片平面同时承担正确遮挡。
- [x] 静态预览、单个活跃 renderer、按变化渲染、DPR 限制与资源释放。
  - `ti-angle-preview.test.ts` 覆盖懒加载、ResizeObserver、DPR 上限 2、context 事件和 dispose；构建包体门禁通过，最大异步 chunk 约 406 KB。
- [x] WebGL 失败/context loss 后参数可用；可重试且不重置文档。
  - 组件提供错误状态和重试按钮，参数控件独立于 renderer；三桌面真实浏览器回归确认正常 WebGL 路径，并注入 `WEBGL_lose_context` 验证错误提示、重试入口和角度文档不丢失。

## T07 — 模板联调

- [x] 原一键换装 ID/节点身份不变；新增角度节点、显示图边和文本边。
  - `tests/workflow-schema.test.ts` 验证内置模板仍为 `builtin-tool-one-click-try-on`，并包含 `view-angle`、`preview-image` 和 `angle-direction`；`e2e/workbench.spec.ts` 在三桌面项目中验证 24 节点和新增连线。
- [x] 托管模板刷新检测同步更新内置模板。
  - 旧内置模板移除 `socks` 后运行 `ensureBuiltinTemplates()`，会补回 `socks`、`view-angle` 及两条角度边；刷新范围仍限定在 managed builtin 目录。
- [x] 旧用户项目/模板不被改写；上传自动连接、模板克隆、第一轮→确认→第二轮 mock 链路完整通过。
  - `tests/authorization.test.ts` 通过真实项目 API 和用户模板 API 建立旧数据，在两次托管内置模板刷新及主动破坏/修复内置一键换装模板后，逐字段确认项目 `name/flow_json/lifecycle/draft_revision/updated_at` 不变、用户模板文件字节完全不变，且其他账号仍返回 404。`e2e/ti-angle-workflow.workbench.spec.ts` 通过真实上传、角度编辑、第一轮 mock、鼠标人工确认和第二轮 mock，并断言运行计划保留角度快照、角度边和审批基准。
- [x] 1024/1280/1440 实测无页面溢出、控件截断及新增节点遮挡。
  - 新三桌面 E2E 首次捕获 TiAngle 输出展开后与第一轮节点重叠 `28.875px`，将内置模板 `view-angle` 从 `y=-800` 调整为 `y=-1000` 后消除；随后捕获动态结果节点覆盖审批按钮，将 `approval` 从 `y=-120` 调整为 `y=-600`。最终 setup + 三桌面 `4/4` 通过展开几何、页面溢出和真实鼠标审批断言。
- [x] 结果查看、比较、下载、继续处理、成功/失败/未知和跨项目恢复不退化。
  - 同一完整浏览器链路实际执行查看大图、两图比较、下载、设为输入，随后切换到另一项目并刷新，确认两条成功结果及注入的失败/未知记录全部恢复；既有结果状态单测继续覆盖活动任务恢复和跨项目引用边界。

## T08 — 回归与工程交付

- [x] 新纯函数与几何 focused tests 通过，新增测试进入主测试清单。
  - `ti-angle-geometry.test.ts`、`ti-angle-preview.test.ts` 已加入 `test:suite` 并通过。
- [x] 隔离 PostgreSQL 单测通过；不得直连生产或自行管理测试 Compose。
- [x] 桌面 E2E 用真实渲染几何/交互断言，不仅源码或 className 检查。
  - `e2e/workbench.spec.ts` 的 TiAngelNode 用例和一键换装模板用例均在 1024/1280/1440 运行；前者验证预览尺寸、折叠文本、预设/重置、Shift+方向键、WebGL 正常路径、context loss/重试、历史撤销重做、拖动角度提交和 React Flow 节点位置不变，后者验证模板 24 节点、上传自动连接及两条角度边；本批中心球既有用例和 Raycaster 单轴/背面用例为 setup + 三桌面两用例共 7/7 通过。
- [x] `npm run lint`、`npm run test`、`npm run check`、`npm run build` 结果记录。
  - `APIYI_BASE_URL=https://127.0.0.1:9 pnpm run check` 已完整通过 lint、Web 构建、包体/CSS 门禁和隔离 PostgreSQL 全量测试；`pnpm run build` 的 Web 与 server bundle、`git diff --check` 也已通过。
- [x] 实施差异（含本批新增源码/测试）已审查，`git diff --check` 通过；未发现本批敏感信息或无关源码改动。工作树中既有 `doc/`、`docs/`、`CONTEXT.md` 和 `.pnpm-store/` 未跟踪项按规则保留。
- [x] CodeGraph 已在最新源码变更后 `sync`，并对全部改动源码/新文件运行 `affected`；图外风险用 focused tests 和桌面 E2E 补充。
  - 完整功能差异审查曾遍历 217 个依赖；第十七批新增的模板、授权测试和 E2E 文件再次同步后遍历 13 个依赖，受影响测试均由完整 `check` 与三桌面 E2E 覆盖。
- [x] 明确记录 `gate:codex` 因项目脚本仍依赖 GitNexus，按项目规则未运行且未宣称通过。
- [x] 汇总所有 PRD A 项证据及未验证项，交付工程验收报告。
  - 下方 A01–A14 表已全部关联 focused、PostgreSQL、三桌面 E2E 或构建证据；工程范围无未验证 A 项。T09 真实模型效果是独立授权阶段，不以 mock/自动化结果冒充完成。

## T09 — 真实效果（另行授权，非自动执行）

- [ ] 用户确认素材、模型、角度矩阵、调用量和费用上限。
  - 2026-09-19 无费用预检：建议固定同一组人物、无人场景、姿势、主穿搭四张参考图，先用 `fast`、2K、忠实还原、无补充提示词完成 3 个换装模型 × 10 个视角的筛查矩阵：关闭、正面 `0/0/0`、左前 `45/0/0`、右前 `-45/0/0`、侧面 `90/0/0`、背面 `-180/0/0`、俯拍 `0/30/0`、仰拍 `0/-30/0`、顺时针 roll `0/0/20`、逆时针 roll `0/0/-20`。
  - 上述筛查为 30 个结果样本；固定素材首次运行预计另有场景、姿势、人脸三次分析，因此缓存命中且无重试/回退时约 33 次 Provider 请求。建议把首轮硬停止上限设为 40 次，为单次任务自动重试留余量；达到上限即停止新样本，不自动进入 `best` 档。
  - 若直接按模板默认 `best` 全量运行，每个样本为三次候选生图加一次自动评审，连同首次三项分析，在缓存命中且无重试/回退时约 123 次 Provider 请求；内容安全回退或传输重试可能继续增加，因此不得默认执行。
  - 当前仓库没有可直接替代上述四类固定参考图的完整验收素材，当前 Codex 进程也未检测到 `APIYI_API_KEY` 或 `APIYI_BASE_URL`。需用户指定素材路径/画布项目，配置凭据，并明确首轮请求上限与金额上限后才可开始。
- [ ] 工作流 3 模型完成约定样本；另外 5 模型不越权扩入口/调用。
- [ ] 原图、结果、最终提示词、模型版本、调用量和人工结论可追溯。
- [ ] 明确大角度/背面/roll 的局限，不宣称逐度准确。
- [ ] 用户确认效果结论；如需改范围，先修订 PRD 与排期。

## 第十批执行记录 — 2026-09-19

- 任务：T02 严格文档边界与草稿恢复证据；T07 结果恢复回归复核。
- 变更：`src/lib/documentSnapshot.ts` 的 TiAngelNode 序列化改为显式保存 `version`、`enabled`、`azimuthDeg`、`elevationDeg`、`rollDeg` 五项协议字段，阻止角度对象内嵌的拖动运行时字段落盘；`tests/ti-angle-persistence.test.ts` 新增嵌套运行时字段红灯用例，以及真实会话分片写入→读取、保存 JSON 过滤和折叠态不恢复断言。
- 红灯→绿灯：新增用例先因 `dragState` 穿透快照失败；最小白名单修复后 `pnpm exec tsx tests/ti-angle-persistence.test.ts` 通过。
- 已通过：`tests/ti-angle-persistence.test.ts`；`tests/recent-results.test.ts`（21 项）；`tests/project-tabs-session.test.ts`（28 项）；`tests/template-launch.test.ts`；均未调用真实生图 Provider。
- 审查结果：会话恢复继续使用现有 `tabId/projectId/documentEpoch` 绑定；结果恢复单测确认孤儿运行态解除、活动 Run 保留、同节点旧 Run 不覆盖新 Run、跨项目结果引用清理；本批未改变结果业务逻辑。
- 剩余风险：服务端用户模板隔离尚未在本批重新运行授权集成测试；完整保存重开、鉴权图片成功换图、T04 重试/重启输入指纹、T06 单轴/背面命中、完整 `pnpm run check` 仍待后续专项。

## 第二批执行记录 — 2026-09-18

- 任务：T03 端口/执行计划实现、T04 运行提示词与基准版本最小保护、T05 节点外壳与侧栏入口首版。
- 变更：`src/lib/workflowPorts.ts` 增加 `preview-image` 与 `angle-direction` 的类型化约束；`server/engine/dag.ts` 排除显示/文本边对图片上游的污染并冻结 `angleControl`；`server/engine/runner.ts` 在正常与安全回退请求中保留冻结角度文本；`src/store/flowStore.ts` 角度配置变更递增场景基准；新增 `TiAngelNode`、React Flow 注册、旧节点库与实际 ToolRail 工具目录入口。
- 红灯→绿灯：先运行 `tests/ti-angle-ports.test.ts` 验证缺失端口契约；先运行 `tests/ti-angle-execution.test.ts` 验证角度文本在正常/回退请求中缺失；先运行 `tests/ti-angle-basis.test.ts` 验证基准版本未递增；先运行 `tests/ti-angle-node.test.ts` 验证组件尚不存在；先运行 `tests/tool-catalog.test.ts` 验证侧栏目录尚未包含节点。对应实现后均通过。
- 已通过：
  - `pnpm exec tsx tests/ti-angle.test.ts`
  - `pnpm exec tsx tests/ti-angle-persistence.test.ts`
  - `pnpm exec tsx tests/ti-angle-ports.test.ts`
  - `pnpm exec tsx tests/ti-angle-execution.test.ts`
  - `pnpm exec tsx tests/ti-angle-basis.test.ts`
  - `pnpm exec tsx tests/ti-angle-node.test.ts`
  - `pnpm exec tsx tests/tool-catalog.test.ts`
  - `pnpm exec tsx tests/dag.test.ts`
  - `pnpm exec tsx tests/workflow-schema.test.ts`
  - `pnpm exec tsx tests/document-snapshot.test.ts`
  - `pnpm exec tsx tests/staged-try-on-ui.test.ts`
  - `pnpm run lint`
- 全量门禁：`pnpm run check` 已通过 lint、Web 构建、隔离 PostgreSQL 启动及前置测试；在既有 `tests/try-on-quality-pipeline.test.ts` 处因环境缺少 `APIYI_BASE_URL` 停止，未将其记为 TiAngelNode 回归。
- 尚未完成：T05 的复制/多目标文本、预设/重置、浏览器键盘/焦点与 1024/1280/1440 几何验收；T06 Three.js renderer；T07 一键换装内置模板联调；T04 完整 inputFingerprint/重试重启/第二轮确认专项。
- 风险边界：本批未调用真实生图 Provider，未安装 Three.js，未改动原一键换装模板身份；`gate:codex` 仍因项目脚本依赖 GitNexus 不运行。

## 第三批执行记录 — 2026-09-18

- 任务：T06 Three.js 预览实现与 T08 首轮浏览器/包体验收。
- 变更：新增 `src/lib/tiAngleGeometry.ts`、`src/components/nodes/TiAnglePreview.tsx`、`src/lib/tiAngleThreeRuntime.ts`、`src/lib/tiAngleThreeRenderer.ts`；TiAngelNode 改为使用懒加载 WebGL 预览；新增几何/预览契约测试和三桌面宽度 Playwright 回归；锁定 `three@0.186.0`、`@types/three@0.186.0`。
- 红灯→绿灯：几何模块缺失、预览组件缺失、初始 Three.js 动态 chunk 超过 500 KB 均先形成失败证据；改为 `three/src` 按需模块和渲染器异步分块后通过包体门禁。
- 已通过：`pnpm exec tsx tests/ti-angle-geometry.test.ts`、`pnpm exec tsx tests/ti-angle-preview.test.ts`、`pnpm exec tsx tests/ti-angle-node.test.ts`、`pnpm run lint`、`pnpm run build`；`pnpm run test:e2e -- e2e/workbench.spec.ts -g "TiAngelNode preview"` 通过 setup + desktop-1024/1280/1440，共 4/4。
- 浏览器证据：预览尺寸、默认折叠与展开文本、真实 WebGL 正常路径、拖动角度提交、React Flow 节点位置不变均通过；未调用真实生图 Provider。
- 剩余风险：预设/重置/复制文本、多目标文本、单轴/背面遮挡真实命中、异步换图/切页/删节点迟到资源、模板联调及完整 `pnpm run check` 仍未完成。

## 第四批执行记录 — 2026-09-18

- 任务：T07 一键换装内置模板联调与 T08 模板浏览器回归。
- 变更：`server/routes/templates.ts` 在原 `builtin-tool-one-click-try-on` 中预置 `view-angle`，保留原节点身份并增加 `person → view-angle:preview-image`、`view-angle:text → stabilize:angle-direction`；托管内置模板刷新检测同步校验节点默认值和两条边；更新 Schema/模板迁移断言与一键换装 E2E。
- 红灯→绿灯：先把模板契约断言提升为 24 节点/5 条边，缺少新节点时由 `tests/workflow-schema.test.ts` 失败；补齐模板和刷新逻辑后通过。随后三桌面 E2E 先验证模板启动、上传自动连接和新增角度边，最终 setup + desktop-1024/1280/1440 共 4/4 通过。
- 已通过：`pnpm exec tsx tests/workflow-schema.test.ts`、`pnpm run lint`、`pnpm run test:e2e -- e2e/workbench.spec.ts -g "one-click try-on uploads auto-connect"`；后者使用隔离 PostgreSQL，未调用真实生图 Provider。
- 剩余风险：第一轮执行/确认/第二轮 mock、结果恢复与用户模板隔离仍待专项；完整 `pnpm run check` 仍在既有 `APIYI_BASE_URL` 缺失处停止。

## 第五批执行记录 — 2026-09-18

- 任务：T05 参数/预设/文本交互补齐与 T08 UI 回归。
- 变更：TiAngelNode 增加六个约定视角预设、三轴重置、shadcn 数值输入与 Shift+方向键步进；关闭时锁定预览/参数编辑但保留值；未连接显示未绑定模型的通用描述，多个文本边分别按接收节点模型编译；新增本地 `Collapsible` 原语、复制文本回退逻辑和多目标输出面板。
- 红灯→绿灯：先扩展 `ti-angle.test.ts`、`ti-angle-node.test.ts` 与桌面 E2E 断言未绑定模型、预设、重置和数值步进；实现后 focused 测试与三桌面浏览器回归通过。
- 已通过：`pnpm run lint`、`pnpm run build`；TiAngelNode 相关 10 项 focused tests 全部通过；`pnpm run test:e2e -- e2e/workbench.spec.ts -g "TiAngelNode preview"` setup + desktop-1024/1280/1440 共 4/4；未调用真实生图 Provider。
- 剩余风险：系统剪贴板失败/焦点恢复/只读和多目标浏览器专项仍待；完整 `pnpm run check` 仍在既有 `APIYI_BASE_URL` 缺失处停止。

## 第六批执行记录 — 2026-09-18

- 任务：T05 复制/焦点/多目标/只读专项验收与 T07 首轮→确认→二轮 mock 链路。
- 变更：`TiAngelNode` 读取当前文档只读状态；只读时禁用开关、预设、三轴输入和 3D 预览，并阻止角度提交；查看文本和复制仍可用。新增浏览器用例覆盖系统剪贴板成功/失败、多下游模型文本、折叠焦点恢复和只读不改文档；新增 `tests/ti-angle-execution.test.ts` 链路覆盖首轮角度冻结文本、mock 首轮结果、审批节点传递和第二轮 GPT mock 精修。
- 红灯→绿灯：浏览器回归先在只读开关仍可用处失败；修正 `TiAngelNode` 的只读门禁后，三桌面回归通过。mock 链路先因测试输出使用非合法 data URL 被运行时校验拒绝，改为合法本地图片引用后通过；未调用真实生图 Provider。
- 已通过：`pnpm exec tsx tests/ti-angle-execution.test.ts`；`pnpm run test:e2e -- e2e/workbench.spec.ts -g "TiAngelNode output supports"` setup + desktop-1024/1280/1440 共 4/4。
- 审查结果：保持复制为非文档修改；只读状态不进入 TiAngelNode 本地折叠状态或输出编译；二轮计划不携带首轮角度文本，仅使用已确认基准图与二轮模型。
- 剩余风险：T02 迟到回调/完整历史边界、T04 `inputFingerprint`/重试重启、T06 context-loss/异步切页删除注入、T07 结果恢复与用户模板隔离仍待；完整 `pnpm run check` 仍受既有 `APIYI_BASE_URL` 缺失阻断。

## 第七批执行记录 — 2026-09-18

- 任务：T02 角度控件历史专项与 T06 WebGL context-loss 浏览器验收。
- 变更：扩展 `e2e/workbench.spec.ts`，验证同值重置不写历史、一次 3D 拖动只写一条历史、撤销/重做恢复角度；通过 `WEBGL_lose_context` 注入 context loss，验证错误提示、重试入口和文档角度值保持。扩展 `tests/ti-angle-preview.test.ts` 的 `webglcontextrestored` 源码契约断言。
- 红灯→绿灯：本批没有新增生产缺口；新增回归直接验证既有历史事务和 renderer 清理路径，setup + desktop-1024/1280/1440 共 4/4 通过。
- 已通过：`pnpm run test:e2e -- e2e/workbench.spec.ts -g "TiAngelNode preview"`；未调用真实生图 Provider。
- 剩余风险：图片鉴权与异步换图/切页/删节点迟到资源仍需专项注入；T04 `inputFingerprint`/重试重启、T07 结果恢复/用户模板隔离和完整 `pnpm run check` 阻断仍未解决。

## 第八批执行记录 — 2026-09-18

- 任务：T02/T06 3D 预览异步资源生命周期专项。
- 变更：新增 `e2e/workbench.spec.ts` 回归用例，使用被延迟的失败图片响应覆盖同页文档替换、切换到新页签、删除 TiAngelNode 三条边界；释放旧响应后确认当前文档、空白页签和节点删除结果不被旧 TextureLoader 错误回调污染。
- 已通过：`pnpm run test:e2e -- e2e/workbench.spec.ts -g "ignores late reference-image callbacks"`，隔离 PostgreSQL runner 下 setup + desktop-1024/1280/1440 共 4/4；未调用真实生图 Provider。
- 本批没有新增生产代码缺口；现有 `cancelled` 回调保护与 renderer teardown 获得真实浏览器专项证据。
- 剩余风险：鉴权图片成功读取/换图、单轴/背面命中、T04 `inputFingerprint`/重试重启、T07 结果恢复/用户模板隔离及完整 `pnpm run check` 仍未完成。

## 第九批执行记录 — 2026-09-19

- 任务：T02 模板克隆 ID/引用重映射与 T07 多模板回归。
- 变更：`src/lib/templateLaunch.ts` 为模板节点和边生成独立 ID，并重映射 `autoConnectTargets` 以及以 `*NodeId` 表示的节点引用；`App.tsx` 与 `flowStore.addExistingNodes` 现在复制/粘贴选中子图的内部边，并在同一文档提交中重映射节点引用。TiAngelNode 的 `preview-image`/`angle-direction` 端口和模型配置保持不变。新增 `tests/template-launch.test.ts`，并将直接启动模板的 E2E 定位改为按节点语义读取运行时 ID，避免依赖模板源 ID。
- 红灯→绿灯：先运行模板克隆契约测试，原实现因保留 `person` 等源节点 ID 失败；再运行子图复制测试，原 `addExistingNodes` 丢弃传入边；实现后均通过。随后完成以下隔离 PostgreSQL E2E：一键换装上传/历史 `4/4`，异步风格预设与用户分步模板 `7/7`，AI 搭配/面料替换/草图优化 `13/13`，TiAngelNode 子图复制 `4/4`，合计 `28/28`；未调用真实生图 Provider。
- 已通过：`pnpm exec tsx tests/template-launch.test.ts`、`pnpm exec tsx tests/project-tabs.test.ts`（57 项）、`pnpm run lint`、上述 E2E；`git diff --check` 待本批交付前再次执行。CodeGraph impact 已覆盖模板启动与复制路径，确认模板调用方和全局快捷键为主要影响面。
- 剩余风险：保存/重开/草稿恢复、跨项目粘贴时外部引用清理、鉴权图片成功换图、T04 `inputFingerprint`/重试重启、T07 结果恢复/旧用户数据隔离和完整 `pnpm run check` 仍未完成。

## PRD 验收追踪

以下状态初始均为“未验证”；实施后填写测试文件/用例、实际命令、结果和截图路径。不以任务勾选代替验收证据。

| PRD ID | 主要任务 | 当前状态 |
| --- | --- | --- |
| A01 | T07 | 一键换装内置模板身份、24 节点、新增显示图/文本边及真实上传→角度→首轮 mock→人工确认→二轮 mock 完整执行链路已在三桌面验证 |
| A01b | T05 | 侧栏创建入口、节点注册、键盘创建、焦点恢复和撤销均由节点契约、Store 历史及三桌面 E2E 验证 |
| A01c | T05 | 三桌面 E2E 已验证默认折叠、点击展开、`aria-expanded`、复制成功/失败、多目标输出与焦点恢复 |
| A01d | T03、T06 | 中心图/外部轨道、文本不增加图片执行依赖、WebGL 正常路径、鉴权 cookie、纹理成功加载和成功换图均已验证；显式 Raycaster 命中与图片平面背面遮挡通过三桌面专项 |
| A02 | T01、T06 | 几何契约、Three.js 预览与三桌面 WebGL 正常路径已验证；球面、方位角和俯仰角手柄均使用独立命中面，空白拖动无效 |
| A03 | T01、T06 | 三轴范围/方向纯函数、固定外部相机、独立单轴手柄、背面遮挡、±180° 接缝与 roll 取景框已验证 |
| A03b | T01、T03、T04 | `tests/ti-angle.test.ts` 覆盖 8 个模型适配、边界、版本、未知 ID 和禁用输出；`tests/ti-angle-execution.test.ts` 逐一验证三种换装模型从编译文本到最终 mock Provider 请求 |
| A03c | T05 | 三桌面 E2E 已验证未连接时通用描述、多目标分别编译、模型切换后文本同步更新且保持折叠，预览选择和折叠不进入文档 |
| A04 | T02、T06 | 文档快照、会话分片写入/读取、Three.js renderer 生命周期及延迟失败回调在文档替换/切页/删除后丢弃已验证；鉴权成功读取已由三桌面 E2E 验证 |
| A05 | T02、T05、T06 | TiAngelNode 运行时字段不入项目快照或会话 JSON、预览拖动与文本折叠已验证；延迟失败纹理替换不污染当前文档，加载中→成功换图状态已由三桌面 E2E 验证 |
| A06 | T02、T07 | 默认数据/Schema、模板克隆与子图复制的节点/边 ID、角度边及 `autoConnectTargets`/`resultNodeId` 重映射、草稿角度恢复已验证；真实保存、项目中心重开和页面刷新后角度/连线/自动连接保留，运行时字段排除且输出默认折叠；托管内置模板刷新不改写旧用户项目与用户模板已由授权集成验证 |
| A07 | T03 | 前后端拒绝错误类型、第二阶段、重复角度来源与非法环；`tests/ti-angle-ports.test.ts` 验证正确文本边不增加图片配额、输入图、顺序或执行依赖 |
| A08 | T03 | 单独运行第一阶段可直接消费保存文档编译的角度，无需先运行 TiAngel；客户端角度计划与保存计划不一致时返回 409 且不入队，权限门禁保持 403 |
| A09 | T04 | 正常、增强成功/失败、安全回退均保留冻结角度；角度单独变化不调用增强器且 Provider 仍为一次；关闭角度沿用原提示词分支 |
| A09b | T01、T03 | 8 模型纯函数适配均通过；一键换装仍仅允许 Sunburst、GPT Image 2、Gemini，Flare 强提交通道在 Provider 前拒绝，其他生成节点未开放角度端口 |
| A10 | T04 | 第二轮已拒绝缺少第一轮成功 Run 或不匹配的完整输入指纹；覆盖匹配角度可继续、TiAngel 方位角变化并伪造新版审批后拒绝、撤销式完整输入恢复后重新放行，以及跨项目不可复用成功记录 |
| A11 | T04 | 持久队列已验证入队后内存角度变化、503 重试和数据库重连均继续使用原始角度快照；已入队第二轮计划/指纹不可变，结果生命周期回归覆盖旧结果保留与终态标识 |
| A12 | T05、T06 | 三桌面预览尺寸、WebGL、折叠、拖动隔离、单轴命中、背面不响应、空白不响应、数值键盘、只读、复制失败和 Three.js context-loss 注入已验证 |
| A13 | T06、T07、T08 | `pnpm run build`、TiAngelNode 三桌面 E2E、一键换装模板及完整 mock/结果链路三桌面 E2E 和 `APIYI_BASE_URL=https://127.0.0.1:9 pnpm run check` 已验证 |
| A14 | T04、T07、T08 | 结果状态单测、授权集成、持久队列及完整一键换装浏览器链路均通过，覆盖查看、比较、下载、设为输入、成功/失败/未知、跨项目切换与刷新恢复 |

## 第十一批执行记录 — 2026-09-19

- 任务：T06 鉴权参考图成功读取/换图专项；T02 迟到纹理回调状态复核。
- 变更：`src/components/nodes/TiAnglePreview.tsx` 增加本地纹理状态机（`empty/loading/loaded/error`），只有 TextureLoader 成功回调后才标记“已加载”；换图时先回到 loading，失败保留可用空场景并显示错误。状态只存在组件运行态，不进入文档或会话。
- 测试：`e2e/workbench.spec.ts` 新增鉴权图片成功换图用例，Playwright 路由返回隔离 PNG 并断言请求携带 cookie、A 图加载完成、B 图延迟期间为 loading、B 图完成后为 loaded；既有迟到失败用例改为先断言 loading。
- 红灯→绿灯：修复前既有迟到用例仍显示“已加载”，新增用例因缺少 `data-ti-angle-image-state` 失败；最小状态机实现后，`pnpm run test:e2e -- e2e/workbench.spec.ts -g "TiAngelNode (ignores|reads authenticated)" --project desktop-1280` 为 setup + 2 项 `3/3`，全桌面同命令为 setup + 1024/1280/1440 两用例 `7/7` 通过。
- 边界：未调用真实生图 Provider；鉴权验证仅确认浏览器向同源项目图片路径发送现有 session cookie，未新增 API 或放宽资源权限。
- 剩余风险：完整保存重开、服务端用户模板隔离、T04 `inputFingerprint`/重试重启、T06 单轴/背面命中、T07 完整结果链路和完整 `pnpm run check` 仍待专项。

## 第十二批执行记录 — 2026-09-19

- 任务：T04 第二轮完整运行输入指纹门禁及输入变更回归；T03 人物板图片来源兼容性回归；授权与持久队列全量回归。
- 变更：新增 `server/lib/executionInputFingerprint.ts`，复用同一哈希边界生成入队 `request_fingerprint` 和第二轮验证指纹；`server/routes/runPlan.ts` 在第二轮入队前按 owner/project/node、执行计划指纹、成功 Run、成功输出及确认图片做服务端核验；`src/lib/workflowPorts.ts` 保留人物板作为真实图片来源接入 `preview-image`，避免破坏既有人物板图片端口契约；授权夹具补齐当前 Schema 必需字段。
- 红灯→绿灯：纯执行测试先因缺少指纹模块失败，新增共享 helper 后通过；PostgreSQL 全量回归先暴露授权夹具缺 `promptEnhancement/safetyFallback/stylePresetId` 及错误状态断言，逐项修正后 `APIYI_BASE_URL=https://127.0.0.1:9 pnpm run test` 全部退出 0，授权测试 45 项、持久队列 30 项均通过；随后补充匹配首轮成功 Run 可继续、首轮 prompt 变更后拒绝的集成断言。
- 已通过：`pnpm exec tsx tests/ti-angle-execution.test.ts`、`pnpm run lint`、TiAngelNode 三桌面专项 E2E、`APIYI_BASE_URL=https://127.0.0.1:9 pnpm run test`；全程仅使用 mock Provider，未调用真实生图服务。
- 审查结果：第二轮不再信任客户端单独提交的 `approvedBaselineRef/approvedBasisRevision`；无匹配第一轮完整输入和成功输出时在付费入队前拒绝。人物板兼容修复只放宽到已有图片类输出，不改变图片顺序、配额或角度文本执行依赖。
- 剩余风险：含 TiAngelNode 角度字段的输入变更集成场景、运行中改值/重试重启快照、T06 单轴/背面命中、完整保存重开、旧用户模板隔离仍待专项；`gate:codex` 依赖 GitNexus，按项目规则未运行。

## 第十三批执行记录 — 2026-09-19

- 任务：T04/A10 角度变化后旧首轮成功图失效；T04/A11 入队快照、503 重试与数据库重连；已入队第二轮不可变。
- 测试：`tests/authorization.test.ts` 的第一轮成功计划接入真实 TiAngel 节点和 `angle-direction` 边，验证匹配角度可进入第二轮；随后把方位角从 `35°` 改为 `-55°`、递增基准版本并伪造新版审批字段，服务端仍按完整输入指纹拒绝旧图。已入队第二轮在项目保存新角度后保持原 `plan_json` 与 `request_fingerprint`。
- 队列证据：`tests/run-queue.test.ts` 新增角度快照用例，入队后修改内存角度，第一次 mock Provider 返回 503，再关闭并重连数据库后重试；两次最终请求和持久化 `step_json` 均保留入队时角度文本。
- 验证结果：新增专项首轮即通过，说明现有完整输入指纹和持久 `step_json` 已满足契约，无需修改生产代码；`pnpm run lint` 与两次 `APIYI_BASE_URL=https://127.0.0.1:9 pnpm run test` 均退出 0，授权 45 项、持久队列 31 项通过，全程未调用真实 Provider。
- CodeGraph：同步 2 个测试文件后索引为 378 files / 6443 nodes / 24226 edges；`affected` 仅返回两项被修改测试，无新增生产依赖风险。
- 剩余风险：撤销后的完整输入匹配、T06 单轴/背面命中、完整保存重开、旧用户项目/模板不改写和完整一键换装浏览器结果链仍待专项；`gate:codex` 依赖 GitNexus，按项目规则未运行。

## 第十四批执行记录 — 2026-09-19

- 任务：收口 T04 的撤销后完整输入匹配、已入队第二轮不可变与跨项目隔离。
- 客户端证据：扩展 `tests/ti-angle-basis.test.ts`，从已确认的 `35°` 基准修改为 `-55°` 后，第一轮 `basisRevision` 从 1 增为 2 且旧审批失效；撤销精确恢复角度、输出、版本和审批，重做后再次失效。
- 服务端证据：扩展 `tests/authorization.test.ts`，确认另一项目不能复用原项目第一轮成功记录；保存漂移角度并伪造审批仍被拒绝；恢复原始完整文档后，同一第一轮成功指纹可再次授权第二轮入队。先前已入队 Run 的 `plan_json` 与 `request_fingerprint` 在项目变更后保持不变。
- 验证结果：`pnpm exec tsx tests/ti-angle-basis.test.ts`、`pnpm run lint`、`pnpm run build`、`APIYI_BASE_URL=https://127.0.0.1:9 pnpm run test` 和同环境的 `pnpm run check` 均退出 0；授权 45 项、持久队列 31 项及完整本地套件通过。全程使用 mock 或不可达网关，未调用真实/付费 Provider。
- 实现结论：新增验收断言直接通过，现有文档历史与完整输入指纹门禁已满足契约，本批无需修改生产代码。
- CodeGraph：同步 2 个测试文件后索引为 378 files / 6448 nodes / 24261 edges；`affected` 仅返回 `tests/ti-angle-basis.test.ts` 与 `tests/authorization.test.ts`，无生产依赖被遍历到。
- 剩余风险：T06 单轴/背面命中、T02 完整保存重开、旧用户项目/模板不改写和完整一键换装浏览器结果链仍待专项；`gate:codex` 依赖 GitNexus，按项目规则未运行。

## 第十五批执行记录 — 2026-09-19

- 任务：T06/A01d/A02/A03/A12/A13 的 Three.js 单轴手柄、背面遮挡、空白命中与 ±180° 接缝专项。
- 红灯→绿灯：新增桌面 E2E 首次运行时，在方位角手柄位置做斜向拖动得到 `elevationDeg: -13`，证明旧二维方向启发式会串轴；改为 Three.js `Raycaster` 显式命中后，同一断言通过。首个绿灯运行遇到 Vite 对新增 `Raycaster/Vector2` 的一次性依赖预构建重载，未改代码直接重跑即通过，随后三桌面完整专项稳定通过。
- 变更：`TiAnglePreview.tsx` 增加可见方位角/俯仰角手柄及透明扩大命中面；把图片平面与相机球/单轴手柄一并加入最近交点判定，图片命中优先时不启动拖动，从而阻止空白和背面对象响应。相机球保留真实 z 坐标，拖动仍按 pointer 相对位移提交以保留抓取偏移；移除画布边缘 roll 启发式，roll 继续由独立 shadcn 参数控件承担。`tiAngleThreeRuntime.ts` 按需导出 `Raycaster` 与 `Vector2`。
- 测试：`tests/ti-angle-geometry.test.ts` 新增方位角/俯仰角单轴隔离和 `170° + 14° → -176°` 接缝断言；`e2e/workbench.spec.ts` 新增斜向拖动两种单轴手柄、空白区域不响应、`-180°` 背面相机球不响应，并保留成功截图。中心球既有用例与新专项在 setup + desktop-1024/1280/1440 共 `7/7` 通过，截图人工检查确认中心球和两个单轴手柄未越出节点边界。
- 验证结果：`pnpm exec tsx tests/ti-angle-geometry.test.ts`、`pnpm exec tsx tests/ti-angle-preview.test.ts`、`pnpm run lint`、`APIYI_BASE_URL=https://127.0.0.1:9 pnpm run check`、`pnpm run build` 均退出 0；Web 初始 JS gzip `169768 / 210000` bytes，最大异步 chunk `406.10 kB / 500 kB`，隔离 PostgreSQL 已正常清理。全程未调用真实/付费 Provider。
- CodeGraph：`sync` 后索引为 378 files / 6450 nodes / 24272 edges；`affected` 遍历 8 个依赖，建议覆盖 `workbench` E2E、`flow-history`、`ti-angle-geometry`、`ti-angle-node` 与 `ti-angle-preview`，本批完整 `check` 和桌面专项已覆盖这些路径。`gate:codex` 依赖 GitNexus，按项目规则未运行且未宣称通过。
- 剩余风险：T02 完整保存重开/业务迟到回调边界、旧用户项目/模板不改写和完整一键换装浏览器结果链仍待专项；T09 真实模型效果需另行授权。

## 第十六批执行记录 — 2026-09-19

- 任务：收口 T02/A06 的正式保存重开、项目中心恢复、刷新持久化与文档目标绑定证据。
- 变更：仅在 `e2e/workbench.spec.ts` 增加验收用例，未修改生产代码。用例通过实际 `/api/projects` 保存 TiAngelNode `123°/-17°/12°`、显示图/文本边和 `autoConnectTargets`，同时故意注入 `dragState/compiledText/collapsed/renderer`；服务端读回、关闭页签后从项目中心重开、以及整页刷新后，协议字段和连线保持一致，运行时字段不存在，文本输出 `aria-expanded=false`。
- 验收测试调试：首次单宽度运行因夹具调用 `loadFlow` 未显式传入项目 ID，请求发往 `/api/projects/undefined`；修正夹具后 desktop-1280 `2/2` 通过。首次三宽度运行中 1024 通过，1280/1440 因隔离数据库在同次运行中共享已保存项目，关闭后启动项目可复用相同节点 ID，导致“节点 ID 完全不存在”的夹具断言过严；改为校验活动 `projectId` 已离开被关闭项目后，setup + 1024/1280/1440 为 `4/4` 通过。两次失败均为新验收夹具问题，未发现生产行为缺口。
- 验证结果：`tests/ti-angle-persistence.test.ts`、`tests/initial-draft-client.test.ts`（24 项）、`tests/project-tabs-session.test.ts`（28 项）、`tests/project-tabs.test.ts`（57 项）、`pnpm run lint`、`APIYI_BASE_URL=https://127.0.0.1:9 pnpm run check`、`pnpm run build` 与 `git diff --check` 均退出 0；三桌面 E2E 为 `4/4`，Web 初始 JS gzip `169768 / 210000` bytes，最大异步 chunk `406.10 kB / 500 kB`，隔离 PostgreSQL 已正常清理。CodeGraph 同步后为 378 files / 6450 nodes / 24285 edges，索引 up to date；`affected` 仅返回 `e2e/workbench.spec.ts`，未遍历到新的生产依赖。全程使用 mock 或不可达网关，未调用真实/付费 Provider；`gate:codex` 依赖 GitNexus，按项目规则未运行且未宣称通过。
- 剩余风险：T07 旧用户项目/模板不改写与完整一键换装结果浏览器链路，T03/T04 尚未勾选的验收项，以及需另行授权的 T09 真实模型效果。

## 第十七批执行记录 — 2026-09-19

- 任务：收口 T07/A01/A06/A13/A14 的旧用户数据隔离、三桌面模板几何、完整两阶段 mock 与结果恢复链路。
- 服务端隔离：`tests/authorization.test.ts` 新建旧用户项目和用户模板，主动删除托管内置一键换装模板的 `view-angle` 及两条相关边后执行刷新；内置模板恢复完整，而用户项目数据库快照和用户模板文件字节均保持不变，跨账号读取继续返回非披露 404。完整授权套件由 45 项增至 46 项并通过。
- 浏览器链路：新增 `e2e/ti-angle-workflow.workbench.spec.ts`，从侧栏启动一键换装，编辑 `45°/15°/-10°`、展开模型适配文本、上传四张必需图、执行第一轮 mock、真实鼠标确认、执行第二轮 mock，并验证查看、双图比较、下载、设为输入、跨项目切换、刷新后成功/失败/未知记录恢复；`/api/run-plan` 与历史接口均为本地 mock，未调用真实或付费 Provider。
- 红灯→绿灯：desktop-1280 首次测得展开 TiAngle 与第一轮节点重叠 `28.875px`，将 `view-angle` 从 `{x:650,y:-800}` 移到 `{x:650,y:-1000}`；随后第一轮动态结果节点覆盖审批按钮，将 `approval` 从 `{x:980,y:-120}` 移到 `{x:980,y:-600}`。修复后真实鼠标审批可用，1024/1280/1440 setup + 三用例 `4/4` 通过。
- 验证结果：`pnpm exec tsx tests/workflow-schema.test.ts` 36 项通过；`pnpm run test:e2e -- e2e/ti-angle-workflow.workbench.spec.ts` 为 `4/4`；`APIYI_BASE_URL=https://127.0.0.1:9 pnpm run check` 完整通过 lint、Web 构建、包体/CSS 门禁和隔离 PostgreSQL 全量测试；`pnpm run build` 的 Web 与 server bundle 通过。首次完整 `check` 仅因新增测试误用不存在的 `projects.revision` 列失败，改为当前真实 `lifecycle/draft_revision` 列后通过，未发现生产逻辑缺口。CodeGraph 最终索引 379 files / 6464 nodes / 24343 edges，`affected` 遍历本批 13 个依赖。
- 剩余风险：T03/T04 尚未勾选的专项、T08 最终验收汇总，以及需另行授权的 T09 真实模型效果；`gate:codex` 仍依赖 GitNexus，按项目规则未运行且未宣称通过。

## 第十八批执行记录 — 2026-09-19

- 任务：收口 T03/A03b/A07/A08/A09b 的计划与模型准入证据、T04/A09 的镜头冲突和请求计数，并完成 T08 工程验收汇总。
- 红灯→绿灯：`tests/ti-angle-execution.test.ts` 首先因最终提示仍要求固定原场景镜头和二维姿势投影而失败；`tests/try-on-quality-pipeline.test.ts` 首先因候选评审仍按原 scene 镜头/构图与逐点姿势判定而失败。最小实现后，开启角度时由 TiAngel 独占相机环绕/俯仰/roll，场景仅保留环境材质色光并允许透视重建，姿势按动作和关节关系重投影；关闭角度继续使用原分支。
- 运行证据：`tests/ti-angle-execution.test.ts` 覆盖增强成功、增强失败、content_refused 安全回退、角度单独变化零增强及关闭分支，并逐一验证 Sunburst、GPT Image 2、Gemini 三模型编译文本进入最终 mock 请求；`tests/try-on-quality-pipeline.test.ts` 验证角度感知候选评审不惩罚正确的新镜头；`tests/ti-angle-ports.test.ts` 验证图序/依赖/配额不变及第四种换装模型在 Provider 前拒绝。
- 授权证据：`tests/authorization.test.ts` 将 TiAngel 角度只改在客户端提交计划中，服务端返回现有 409 且数据库无对应 Run；其他账号仍返回 403。保存文档、原必需图和图片顺序未被改写。
- 验证结果：三个聚焦测试、`pnpm run lint`、`APIYI_BASE_URL=https://127.0.0.1:9 pnpm run test`、同环境的 `pnpm run check`、`pnpm run build` 与 `git diff --check` 均退出 0；Web 初始 JS gzip `169768 / 210000` bytes，最大异步 chunk `406.10 kB / 500 kB`，server bundle 成功，隔离 PostgreSQL 已正常清理。全程使用 mock 或本地不可达网关，未调用真实/付费 Provider。
- CodeGraph：最终索引为 379 files / 6487 nodes / 24418 edges且 up to date；`affected` 对完整 TiAngel 源码与测试差异遍历 220 个依赖，列出的非 E2E 回归由完整 `check` 覆盖，相关 TiAngel/模板三桌面 E2E 已在前批通过。`gate:codex` 仍依赖 GitNexus，按项目规则未运行且未宣称通过。
- 交付结论：T00–T08 和 PRD A01–A14 工程验收已完成；唯一未完成项是需用户另行确认素材、模型矩阵、调用量和费用上限的 T09 真实生成效果，不以自动化结果替代。

## 首批执行记录 — 2026-09-18

- 任务：T00、T01、T02 基础实现。
- 负责人：Codex；开发范围限定为当前 worktree，未调用真实生图 Provider。
- 变更：新增 `src/lib/tiAngle.ts`、两个 TiAngelNode focused tests；接入 `NodeKind`、默认数据、Schema 18、文档快照、Session 清洗、DAG/Runner 本地数据分支和模型适配测试清单。
- 红灯→绿灯：先添加 `tests/ti-angle.test.ts`，缺少实现时失败；先添加 `tests/ti-angle-persistence.test.ts`，快照不支持 `ti-angle` 时失败；补齐实现后两者通过。
- 已通过：`pnpm exec tsx tests/ti-angle.test.ts`、`pnpm exec tsx tests/ti-angle-persistence.test.ts`、文档快照、Schema、画布创建、历史、页签会话 focused tests；`pnpm run lint`。
- 构建：`pnpm run build` 通过（Web 与 server bundle）；`pnpm run check` 的 lint/Web build/隔离 PostgreSQL 启动清理通过，但全套测试因既有 `try-on-quality-pipeline` 缺少 `APIYI_BASE_URL` 环境变量停止。
- CodeGraph：已执行 `sync` 和 `affected`；变更依赖包含新增角度纯函数/测试及类型、Schema、Store、DAG、Runner、面板映射。
- 剩余风险：完整运行输入 `inputFingerprint`、角度端口计划、Three.js renderer、UI 折叠、模板联调和真实效果均未完成/未验证。

## 执行记录模板

每完成一个任务追加：任务 ID、负责人、开始/结束日期、实际人日、变更文件、失败→通过测试证据、审查结果、剩余风险。等待外部授权的时间单列。
