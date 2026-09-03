# Phase 0 Research: 画布工作台 UI 整改

## 1. 工作台外壳与详细设置位置

**Decision**: 左侧仅保留 52px 五组 ToolRail 和锚定浮层；`ContextPanel` 整体迁移到可收起的右侧占位 Dock。中央 `ReactFlowProvider`、CanvasFlow、Properties 和 Results 继续各挂载一次，Dock 开合只改变布局宽度，不重建业务子树。

**Rationale**: 当前 `WorkbenchShell` 把节点库与属性/Results 放在互斥的 320px 左 Dock，和已确认的固定右侧设置面板冲突。现有 `ContextPanel` 已经用 keepMounted 保存 Properties/Results 的滚动与上下文，`CanvasFlow` 也已有 ResizeObserver 处理容器宽度变化，可以迁移而不重写 Results。

**Alternatives considered**:

- 继续共用左 Dock：不符合已确认的信息架构，且工具发现和详情编辑争抢同一空间。
- 使用覆盖式 Sheet/Modal：会遮挡中心画布，也不满足固定 Dock 和上下文连续性。
- 同时保留左右两套面板：增加重复状态和焦点路径，且会破坏低噪音目标。

## 2. 五组工具目录与可用性

**Decision**: 新增纯数据 `toolCatalog`，恰好包含添加节点、服装设计、模特换装、视频制作、创作工具五组。每个项目声明稳定 id、名称、图标、简述、可用状态、禁用原因和 `creationIntent`。现有可执行能力映射到节点或素材选择事件；未形成独立执行契约的本地视频、白底图、风格迁移及四类视频生成项目保持可发现但禁用。

**Rationale**: 可用性门禁若散落在 JSX 中，很容易出现“看似禁用但仍能创建或计费”的旁路。目录作为纯数据可以对组数、顺序、名称、禁用原因和零副作用进行合同测试。视频执行不在本功能规格范围内，宪法也禁止在输入/计费契约不明确时启用付费入口。

**Alternatives considered**:

- 在 ToolRail 中直接写多个 switch：实现快，但可用状态、测试和后续灰度会和视图耦合。
- 为禁用能力创建占位业务节点：会污染项目和撤销历史，并造成错误的“已支持”预期。
- 把绘画与颜色拆成第六组：违反已经确认的恰好五个一级分组。

## 3. 工具浮层交互与可访问性

**Decision**: 基于现有 `@base-ui/react` 增加项目本地 shadcn Popover primitive，并用一个受控状态机管理 `hoveredGroupId`、`openGroupId`、`pinnedGroupId`。悬停延迟 150–200ms，关闭延迟约 150ms；点击固定/取消固定，Escape 关闭并还焦。ToolRail 使用垂直 toolbar 语义和 roving tabindex，项目用普通 button，禁用项目保持可聚焦并能读出原因。

**Rationale**: 工具浮层是包含标题、描述、状态和拖放入口的富内容选择器，不是传统菜单。Base UI 提供定位、Portal、碰撞处理和受控打开能力；toolbar 键盘模式可以支持上下方向键、Home/End、Enter/Space。受控单根节点保证快速经过多个图标时只出现最后一个稳定分组。

**Alternatives considered**:

- DropdownMenu：其关闭和焦点语义不适合富信息卡片和拖放。
- 完全手写浮层定位与焦点管理：会复制底层可访问性和边界碰撞逻辑。
- focus 即自动打开：键盘扫过工具栏时会强制展开，干扰导航；键盘以 Enter/Space 明确打开更稳定。

**Primary references**: [Base UI Popover](https://base-ui.com/react/components/popover), [WAI-ARIA Toolbar Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/), [WAI-ARIA Disclosure Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)

## 4. 节点创建与视口安全落点

**Decision**: 点击和拖放统一传递 `CanvasCreationIntent`，由 CanvasFlow 在 React Flow 上下文内解析。点击时从当前 viewport 中心向外搜索不与已测量节点矩形冲突的最近位置；拖放使用释放点。最终仍只调用 `flowStore.addNode`、`addAssetNode` 或专用原子 action。

**Rationale**: 当前节点库点击位置是“选中或最后节点向右 380px”，在拥挤画布中容易覆盖。CanvasFlow 已拥有 `screenToFlowPosition`、viewport 和节点测量信息，适合计算实际可见安全区域；store 继续作为 revision、dirty 和撤销历史的唯一写入口。

**Alternatives considered**:

- ToolRail 直接调用 `useReactFlow`：需要把 Provider 提升并改变现有挂载边界。
- 继续按最后节点偏移：不能保证当前可见或无重叠。
- 让组件直接拼接 nodes：会旁路统一文档提交和只读校验。

## 5. Typed ports 与角色确认

**Decision**: 将 `NodeSpec.inputs/outputs` 演进为 typed port 描述，值类型至少为 `image | text | colors | video | none`。语义角色继续唯一存于 `PersistedWorkflowEdge.targetHandle`；不新增 `edge.data.role`。通用连接先进入不持久化的 `ConnectionDraft`，用户选择/确认角色后才创建正式边，并在 UI、store、server schema 和 DAG 四层验证类型、允许角色、基数及总上限。

**Rationale**: 当前 DAG 只理解图片，无法安全表达色板、文本或未来视频。角色若同时写在 handle 和 data 中会形成双真相。连接草稿不进入项目，取消确认不会产生撤销记录；用 `DocumentTarget` 绑定草稿可以防止切换页签或替换文档后旧确认误写。

**Alternatives considered**:

- 用图片节点的 `imageRole` 推断所有边角色：同一图片可能在不同边承担不同职责，无法成立。
- 持久化半连接边：取消与超时会污染项目，并使运行前校验复杂。
- 继续用入边创建顺序：已经造成角色错误，且违反参考隔离原则。

## 6. 分步换装的独立确认门

**Decision**: 新增无 provider 的 `stage-approval` 节点。第一轮节点保存 `basisRevision`；第一轮到确认节点使用 `baseline-candidate` 角色，确认节点到第二轮使用 `baseline`。确认事实记录 source node id、当前输出 ref 和 basis revision，三者与实时输入完全一致时才派生为 confirmed。第一轮任何语义输入、参数、输出或重新运行都会原子递增 basis revision，使旧确认立即 stale。

**Rationale**: 当前 `approvedBaselineRef` 藏在第二轮节点且只比较 URL，不能在“输入变化但旧输出仍显示”或“同输入重新运行”时立即失效。独立节点让人工门槛在画布上可见，也允许 DAG 把它作为经过确认才可透传的图片输出。

**Alternatives considered**:

- 保留第二轮内部确认按钮：不符合独立明显的流程门槛。
- 只比较图片 URL：无法覆盖输入变化与重跑开始时的竞态。
- 用户确认后复制图片到第二轮：会产生重复素材和难以追踪的来源。

## 7. 路径高亮与自动整理

**Decision**: 新增无 React 的 `graphLayout` 纯模块。路径高亮从主选节点分别计算上下游边集合；自动整理先以边的无向视图 BFS 得到完整连通分量，再对分量内有向图做 Kahn/longest-path 分层，同层按现有 y、节点阶段优先级和 id 稳定排序，使用实测宽高及固定间距排布。布局保持原分量中心，不自动 fitView；检测到环时整体拒绝，不做部分修改。位置通过一次原子 action 写入，其他分量和 viewport 均不变。

**Rationale**: 现有 React Flow 没有内建自动布局，需求只要求当前连通工作流无重叠和其他工作流零位移。纯函数更容易做确定性测试，也避免引入 Dagre/ELK 的包体和不可预测布局。一次文档提交等于一次撤销。

**Alternatives considered**:

- Dagre：适合简单有向图，但本次规模下依赖收益有限。
- ELK：端口路由和复合图能力更强，但配置复杂、包体较大；等未来确有正交避障或子图需求再评估。
- 整理全画布：会改变用户未选择的独立工作流，违反验收条件。

**Primary reference**: [React Flow layouting guide](https://reactflow.dev/learn/layouting/layouting)

## 8. 画板技术、持久化与恢复

**Decision**: 使用 `konva + react-konva`，仅在打开画板编辑器时动态加载。编辑器状态是版本化的 `DrawingDocument` DTO，不保存 Konva Stage JSON。首版最多 5 层，支持 stroke/eraser/shape/text；原生 textarea 负责文字输入。已提交 DTO 作为 PostgreSQL 中不可变、owner/project/node 绑定的结构化版本，画板节点只保存 `contentRef` 与预览/导出图片引用；预览 PNG 存入 DATA_DIR。成功提交的预览直接作为画板的 `image` 输出，另有显式“导出为图片节点”动作；未保存或预览提交失败时不得连接。编辑期的逐笔 undo/redo 和 500ms 节流恢复草稿留在 IndexedDB，按 owner/tab/project/documentEpoch/node/baseRef 分区。结束编辑时先写内容与预览，再校验 DocumentTarget，最后一次原子提交引用。

**Rationale**: Konva 已覆盖命中检测、图层、变换、橡皮混合和 PNG 导出，能避免自建完整绘图引擎。不可变服务端版本让项目撤销只切换小引用，避免把大量点数据复制到 flow JSON、页签会话和全局历史。恢复草稿不进入 ProjectTab，因此逐笔操作不会污染项目历史；失败时仍可恢复。

**Alternatives considered**:

- 原生 Canvas/SVG：依赖少，但命中、变换、文字编辑、图层、导出和撤销都需自行实现。
- Fabric：对象模型方便，但 React 双状态更重，当前核心不需要 SVG，并需额外处理近期 SVG 安全边界。
- tldraw：能力远超简单嵌入式画板，包体和授权要求不适合本功能。
- 将整个 DrawingDocument 内联进项目 flow JSON：实现简单，但会放大浏览器 session、项目保存和全局历史的容量风险。

**Primary references**: [Konva React free drawing](https://konvajs.org/docs/react/Free_Drawing.html), [Konva state serialization guidance](https://konvajs.org/docs/data_and_serialization/Best_Practices.html), [Konva editable text](https://konvajs.org/docs/sandbox/Editable_Text.html), [Konva layer management](https://konvajs.org/docs/performance/Layer_Management.html)

## 9. 色板数据流

**Decision**: 新增 `color-palette` 节点，保存 1–32 个去重的 sRGB `#RRGGBB` swatch。文本输入只接受 `#RGB`、`#RRGGBB`、整数通道 `rgb()` 和 `hsl()`，统一为大写 `#RRGGBB`；含 alpha、越界或畸形输入明确拒绝。快速颜色、自定义、最近、收藏和吸管只用于形成一次创建意图；选择完成后创建一个独立色板节点，绝不修改当前选中节点。色板通过 `colors` 输出连接到兼容消费者的 `palette` 端口；运行快照以已连接色板为准，断开后才回退节点内颜色。最近/收藏属于按账号隔离的用户偏好，不进入项目快照。

**Rationale**: 这和用户明确选择的“总是创建色板节点”一致，也让撤销、来源追踪和模板复制可预测。typed payload 防止 DAG 把色板误当图片参考。

**Alternatives considered**:

- 直接写入选中节点 colors：会产生隐式副作用，并在多选时不确定。
- 把色板渲染成图片再连接：丢失精确色值，并污染参考图计数。
- 同时保留连接色板和静默同步颜色：形成两个运行真相。

## 10. Schema 迁移、测试与交付切片

**Decision**: 工作流升级为 v5。v4→v5 保留合法 `targetHandle`，不猜测无 handle 的含糊角色；新增节点只在新文档中出现。现有已确认分步流程在读取时确定性插入 `stage-approval` 并转移确认事实，迁移必须幂等。文本节点首版作为项目内可编辑说明并声明 `text` 输出，但不把文本静默注入任何付费节点；本地视频和新付费能力保持禁用。实现按外壳、图语义、分步换装、创作工具、回归门禁五个纵向切片推进。

**Rationale**: 先稳定外壳和 Results，再修改文档契约，可以降低同时破坏 UI 和数据的风险。禁止猜角色、禁止隐式 prompt 注入和禁用无契约能力符合 fail-closed 与付费安全原则。

**Alternatives considered**:

- 一次提交所有 UI、schema、画板和视频：故障面过大，难以定位回归。
- 迁移时按旧连线顺序推断角色：会重新引入本功能要消除的错误来源。
- 为了演示先启用未完成能力：会产生错误项目、网络或计费副作用。

## Resolved Unknowns

- 没有遗留待澄清项。
- GitNexus 索引于 2026-09-02 21:15（Asia/Shanghai 对应时刻）覆盖 236 个文件、24,325 个 symbols、56,986 条关系和 810 个流程，`incomplete_reasons=[]`；检查时 `src/`、`server/`、`tests/`、`e2e/` 没有比索引更新的文件。仓库没有 commit，因此不能用 commit SHA 判断新旧。
- 当前包体门禁为初始 JS gzip 210KB、单 chunk 500KB；画板依赖必须动态加载并分别通过门禁。
