# Feature Specification: 画布工作台 UI 整改

**Feature Branch**: `001-canvas-workbench-redesign`

**Created**: 2026-09-02

**Status**: Draft

**Input**: User description: "参考低噪音无限画布界面，整改 Garment Canvas 的工具栏、节点层级、连线、双模型分步换装、绘画与色彩工具；工具栏采用五个一级分组和悬浮窗口。"

## Clarifications

### Session 2026-09-03

- Q: 当用户把一张通用图片连接到第一轮角色端口时，系统应通过什么方式确定其语义类别？ → A: 每次连接时由用户明确选择或确认角色，并将角色绑定到该连线；角色不一致时阻止连接。
- Q: 用户选中节点并需要编辑完整参数时，详细设置应固定显示在哪里？ → A: 使用可收起的固定右侧设置面板，切换节点时在原位更新内容。
- Q: 用户点击“自动整理”时，系统应重新排列哪些节点？ → A: 只整理当前选中节点所属的完整连通工作流；未选择节点时不执行。
- Q: 用户在画板中连续绘制时，这些修改应以什么粒度进入项目撤销历史并保存？ → A: 画板内逐笔撤销，结束编辑后作为一条项目历史提交，编辑期间自动保存恢复草稿。
- Q: 当用户同时选中了多个节点或多个可配色对象时，从色彩工具选择一种颜色应应用到哪里？ → A: 始终只创建色板节点，不直接修改任何字段。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 通过五组工具快速添加能力 (Priority: P1)

服装设计师在左侧工具栏浏览五个清晰分组，通过悬停、键盘聚焦或点击打开悬浮窗口，
随后点击或拖放所需项目，在当前可见画布中创建正确节点。

**Why this priority**: 工具发现和节点创建是所有画布工作的入口；入口不清晰会阻断后续设计任务。

**Independent Test**: 使用一个空白项目，分别从五个分组打开悬浮窗口并创建所有当前可用的
节点，验证无需阅读教程也能找到目标能力且不会误触其他分组。

**Acceptance Scenarios**:

1. **Given** 用户位于空白画布，**When** 鼠标停留在任一一级分组图标，**Then** 对应悬浮窗口在
   250 毫秒内出现，并只显示该分组项目。
2. **Given** 悬浮窗口已打开，**When** 用户把鼠标从一级图标移动到窗口，**Then** 窗口保持打开，
   不发生闪烁或意外关闭。
3. **Given** 用户使用键盘浏览工具栏，**When** 聚焦分组并按 Enter 或空格，**Then** 窗口打开且
   焦点进入第一个可用项目；按 Escape 后关闭并返回原图标。
4. **Given** 用户选择一个可用项目，**When** 点击项目或拖放到画布，**Then** 系统在可见空白区域
   或指定位置创建且只创建一个正确类型的节点。
5. **Given** 某能力尚未完成独立产品规格，**When** 用户查看对应项目，**Then** 项目明确显示不可用
   及原因，且点击不会创建节点、启动任务或产生费用。

---

### User Story 2 - 清晰完成双模型分步换装 (Priority: P2)

服装设计师可以直接看见第一轮所需和可选的参考角色，完成场景化定版后进行独立人工确认，
确认完成才进入第二轮服装精修；错误连线在运行前即可发现。

**Why this priority**: 分步换装是核心专业工作流，也是当前重复连线、角色误判和运行错误最集中的区域。

**Independent Test**: 从人物、场景、主穿搭和配饰素材开始，完成第一轮生成、确认、第二轮解锁；
随后重新生成第一轮，验证旧确认立即失效且没有付费请求在错误输入下发生。

**Acceptance Scenarios**:

1. **Given** 第一轮节点没有任何输入，**When** 用户查看节点，**Then** 节点逐行显示人物、场景、
   主穿搭、六类配饰和补充结构的连接状态与必填性。
2. **Given** 一个角色已有来源，**When** 用户尝试连接第二个来源到同一角色，**Then** 连接动作立即
   被阻止，并用业务名称说明冲突角色。
3. **Given** 一张通用图片被连接到第一轮角色端口，**When** 用户选择或确认该连线的角色，**Then**
   系统把角色绑定到该连线；确认角色与目标端口不一致时立即阻止连接，且不会发起生成。
4. **Given** 第一轮成功但尚未确认，**When** 用户查看第二轮，**Then** 第二轮保持锁定并明确显示
   “等待确认第一轮基准”。
5. **Given** 第一轮已确认，**When** 第一轮输入、输出或重新生成状态发生变化，**Then** 原确认立即
   失效，第二轮重新锁定。

---

### User Story 3 - 在低噪音画布中理解复杂流程 (Priority: P3)

用户通过紧凑节点、语义端口、路径高亮和按需展开的详细参数理解复杂流程，而不需要在节点中
阅读长篇说明或追踪大量交叉连线。

**Why this priority**: 降低视觉噪音可以提升复杂项目的编辑效率，同时不能牺牲专业参数与 Results。

**Independent Test**: 打开包含两阶段换装、多配饰和最终结果的代表性项目，在三个支持宽度与三种
主题下检查节点密度、路径识别、参数编辑和 Results 完整性。

**Acceptance Scenarios**:

1. **Given** 节点未被选中，**When** 用户浏览画布，**Then** 节点只展示标题、输入摘要、关键状态、
   主操作和最新结果摘要，长篇帮助与高级设置不占用节点主体。
2. **Given** 用户选中一个节点，**When** 查看画布，**Then** 该节点的直接上游与下游路径被突出，
   无关连线弱化但仍可辨认。
3. **Given** 用户需要完整设置，**When** 打开所选节点的可收起固定右侧设置面板，**Then** 可以查看
   和编辑完整参数；切换节点时面板在原位更新内容，画布节点摘要同步更新。
4. **Given** 选中节点所属工作流存在重叠或连线过密，**When** 用户执行自动整理，**Then** 仅该完整
   连通工作流按输入、阶段、确认、结果的方向重新排列；其他独立工作流的位置和全部连接语义保持不变。

---

### User Story 4 - 在画板中创作并快速复用颜色 (Priority: P4)

用户可以创建一个可保存的空白画板，在画板中绘制图案或标注，并从色彩工具快速选择、收藏、
吸取和复用颜色；色彩选择生成独立色板节点，再由用户明确连接到服装设计节点。

**Why this priority**: 绘画和色彩补足从灵感到 AI 生成之间的手工创作环节，但不阻塞基础画布整改。

**Independent Test**: 创建画板，完成简单图案、撤销重做、保存和导出；再选择三个颜色并生成
色板节点，确认任何现有节点均未被直接修改，刷新项目后画板与色板仍可继续编辑和连接。

**Acceptance Scenarios**:

1. **Given** 用户打开“创作工具”，**When** 选择新建空白画板，**Then** 画布创建一个独立、可移动、
   可保存且可连接的画板，而不是改变无限画布背景。
2. **Given** 画板正在编辑，**When** 用户使用画笔、橡皮擦、基础图形、文字、图层和撤销重做，
   **Then** 每项操作按顺序生效且不会修改画板外内容；笔画在画板内部独立撤销，不逐笔进入项目历史。
3. **Given** 用户已经选中一个或多个节点或字段，**When** 从色彩工具选择颜色，**Then** 系统只创建
   独立色板节点，不直接修改任何选中对象；颜色必须通过用户明确连线后才能进入兼容节点。
4. **Given** 用户完成画板，**When** 选择导出为图片节点，**Then** 生成一个保持画面比例的图片输入，
   原画板仍保留且可继续编辑。
5. **Given** 用户在一次画板编辑中完成多次操作，**When** 结束编辑，**Then** 整次编辑作为一条项目
   历史提交；编辑期间异常退出后，可以恢复最近自动保存的画板草稿而不产生重复项目历史。

---

### User Story 5 - 安全发现视频制作入口 (Priority: P5)

用户可以在“视频制作”分组中使用文生视频、首帧生视频、首尾帧生视频、多模态参考生视频、视频编辑和视频延长六种
工作方式；只有已完成独立规格和上线验收的能力才能创建并运行节点。

**Why this priority**: 视频是新增产品能力，必须保持可发现性，同时避免未完成入口误导用户或产生费用。

**Independent Test**: 在不同能力可用状态下打开视频分组，验证名称、状态、禁用原因和可用项目的
创建行为准确，所有不可用项目均无网络或计费副作用。

**Acceptance Scenarios**:

1. **Given** 六种视频能力均未上线，**When** 用户打开视频分组，**Then** 六个项目完整显示且明确
   标记不可用，不创建节点或请求。
2. **Given** 其中一个视频能力已通过独立规格和上线验收，**When** 用户选择该项目，**Then** 只创建
   对应视频节点，其他未上线项目继续保持不可用。

### Edge Cases

- 鼠标快速经过多个分组图标时，只保留最后一个稳定悬停的窗口，不能连续闪烁多个窗口。
- 悬浮窗口接近屏幕顶部、底部或右侧边界时，完整内容仍可访问，超出部分在窗口内部滚动。
- 固定右侧设置面板在 1024 宽度下必须可收起，收起后不能留下阻挡画布操作的透明或空白区域。
- 工具名称在较长语言环境中不能覆盖状态、图标或其他项目。
- 画布已经拥挤时，新节点必须放到当前视口最近的安全空白区域，不能覆盖关键操作按钮。
- 没有选中节点时，自动整理必须保持不可执行并提示用户先选择目标工作流。
- 角色端口达到上限、图片总数达到模型上限或角色不匹配时，必须在连接或运行前给出具体提示。
- 第一轮确认与输入变更并发发生时，以最新输入和输出为准，旧确认不能解锁第二轮。
- 用户在不可运行节点上快速重复点击时，不得创建重复节点、任务或消耗记录。
- 无论当前选择是否兼容，色彩工具都不得静默修改任何现有节点或字段，只能创建色板节点。
- 画板内容较大或包含多图层时，保存失败必须保留当前编辑并允许重试。
- 三种主题、系统减少动态效果偏好和 1024 宽度下，所有核心操作仍必须可见和可操作。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 工具栏 MUST 恰好提供五个一级分组：添加节点、服装设计、模特换装、视频制作、创作工具。
- **FR-002**: “添加节点” MUST 包含文本节点、本地上传图片、本地上传视频、从资产库中选择。
- **FR-003**: “服装设计” MUST 包含草图到效果图、AI 改款、面料配色替换、印花提取、印花裂变；面料配色替换 MUST 支持面料、配色和面料+配色模式。
- **FR-004**: “模特换装” MUST 包含白底图制作、一键换装、风格迁移；双模型分步换装 MUST 作为
  一键换装的高级模式提供，而不是新增第六个一级分组。
- **FR-005**: “视频制作” MUST 包含文生视频、首帧生视频、首尾帧生视频、多模态参考生视频、视频编辑、视频延长。
- **FR-006**: “创作工具” MUST 分别提供绘画工具和色彩工具两个区域。
- **FR-007**: 每个一级分组 MUST 支持鼠标悬停、键盘聚焦和点击打开锚定悬浮窗口；从图标移动到
  窗口期间窗口 MUST 保持稳定。
- **FR-008**: 点击一级分组 MUST 能固定或关闭窗口；Escape MUST 关闭窗口并恢复焦点。
- **FR-009**: 每个工具项目 MUST 显示名称、识别图标、简短用途和可用状态；仅靠图标不得成为
  理解功能的必要条件。
- **FR-010**: 点击可用项目 MUST 在当前视口的安全空白区域创建一个节点；拖放 MUST 在释放位置
  创建一个节点。
- **FR-011**: 未上线或不满足前置条件的项目 MUST 明确显示原因，并 MUST NOT 创建节点、提交任务、
  发送付费请求或改变项目内容。
- **FR-012**: 输入节点、阶段节点、人工确认节点和结果节点 MUST 具有可区分但一致的视觉层级。
- **FR-013**: 常态节点 MUST 只显示标题、角色或输入摘要、关键状态、一个主操作和最新结果摘要；
  详细帮助与高级设置 MUST 按需显示在可收起的固定右侧设置面板，切换节点时面板 MUST 在原位
  更新内容而不是扩展节点或遮挡画布中心。
- **FR-014**: 第一轮换装节点 MUST 逐行显示人物身份、场景或表演、主穿搭、包、鞋、帽子、戒指、
  耳环、手镯和补充结构角色的连接状态与必填性。
- **FR-015**: 每条通用图片连线 MUST 由用户在连接时明确选择或确认角色，并将该角色绑定到连线；
  每个第一轮角色 MUST 最多接受一个来源，确认角色与目标端口不一致或来源重复时 MUST 立即阻止。
- **FR-016**: 第一轮角色 MUST 由连接的语义角色决定，不得依赖连接创建顺序。
- **FR-017**: 人工确认 MUST 是第一轮和第二轮之间独立、明显的流程门槛，不得隐藏在第二轮参数中。
- **FR-018**: 第二轮 MUST 在第一轮成功且经确认之前保持锁定，并明确说明缺少的前置条件。
- **FR-019**: 第一轮输入、输出或重新生成发生变化时，旧确认 MUST 立即失效并重新锁定第二轮。
- **FR-020**: 系统 MUST NOT 自动切换模型、删除超额参考图、改变角色或复用已经失效的确认。
- **FR-021**: 角色行 MUST 显示已连接来源的名称或缩略信息，使用户无需只依赖连线判断来源。
- **FR-022**: 连接线 MUST 支持所选节点上下游路径高亮，并在未选中时降低视觉噪音但保持可辨认。
- **FR-023**: 自动整理 MUST 只重新排列当前选中节点所属的完整连通工作流，并按输入、阶段、确认
  和结果的主流程布局；其他独立工作流的位置 MUST 保持不变，全部节点内容、角色、连线和运行
  状态 MUST 保持不变。没有选中节点时 MUST 不执行并提示先选择目标工作流。
- **FR-024**: 节点 MUST 清楚区分空闲、缺少输入、可运行、排队、运行、自动重试、成功、失败、
  结果未知和需要重新确认状态。
- **FR-025**: 用户可见错误 MUST 使用角色和业务名称说明问题，不得只显示内部字段、枚举或异常文本。
- **FR-026**: Results 的跨项目恢复、成功、失败、未知结果、查看、对比、下载和设为输入能力 MUST
  在整改后保持完整。
- **FR-027**: 绘画工具 MUST 创建独立画板，并支持画笔、橡皮擦、基础图形、文字、图层、画板内
  逐笔撤销和重做、保存以及导出为图片节点；单笔操作 MUST NOT 单独进入项目全局撤销历史。
- **FR-028**: 画板 MUST 可移动、可持久保存、可继续编辑，并可作为其他节点的输入来源。一次画板
  编辑结束时 MUST 作为一条项目历史原子提交；编辑期间 MUST 自动保存可恢复草稿，恢复草稿 MUST
  NOT 重复创建项目历史。
- **FR-029**: 色彩工具 MUST 支持快速色板、自定义颜色、最近颜色、收藏色板、常用颜色格式输入
  和吸管取色。任何颜色选择 MUST 只创建独立色板节点并 MUST NOT 直接修改现有节点或字段；颜色
  只有在用户明确连接色板节点后才能进入兼容节点。
- **FR-030**: 四种视频制作项目 MUST 在其各自独立功能规格、生成契约和上线验收完成后才能启用。
- **FR-031**: 所有分组、悬浮窗口、节点主操作和详细设置 MUST 支持键盘操作、可见焦点、明确名称、
  焦点恢复和减少动态效果偏好。
- **FR-032**: 整改后的工作台 MUST 在 1024、1280 和 1440 CSS 像素宽度下保持核心操作可见，
  且不增加移动端专用流程。
- **FR-033**: 当前、白色和护眼三种主题 MUST 保持相同信息层级、状态语义和可读性。
- **FR-034**: 导航、预览、可用性检查和自动整理 MUST NOT 自行触发真实或付费生成。

#### Deterministic interaction rules

- A saved drawing-board with a committed, authorized `previewImageRef` exposes that preview directly through an `image` output port. Downstream image-compatible nodes may connect to the board without creating a duplicate node. “导出为图片节点” remains an explicit optional action that creates a separate editable workflow input reference; an unsaved board or a board without a committed preview cannot connect.
- Common color text input supports exactly `#RGB`, `#RRGGBB`, `rgb(r,g,b)` with integer channels 0–255, and `hsl(h,s%,l%)` with normalized hue and percentage saturation/lightness. Parsing is whitespace-tolerant and case-insensitive; successful input is stored as uppercase `#RRGGBB`. Alpha-bearing, malformed and out-of-range values are rejected with a Chinese business error and never approximated silently.
- Initial disabled capabilities are local video upload, white-background generation, style transfer and all four video-generation items. White-background generation remains disabled until its image-role, prompt, output and acceptance contract is separately approved; style transfer remains disabled until its reference-role and conflict contract is approved. Disabled items remain discoverable but satisfy FR-011. Standard and staged virtual try-on remain available.

### Scope Boundaries

**In scope**:

- 五组工具栏及其悬浮窗口、键盘和拖放行为。
- 现有节点的视觉层级、摘要、详细参数入口、状态与错误表达。
- 双模型分步换装的角色清单、人工确认和渐进解锁。
- 连线路径高亮、语义显示与自动整理。
- 独立画板、基础绘画和色彩复用体验。
- 视频制作项目的名称、能力状态和安全启用门槛。

**Out of scope**:

- 四种视频生成方式的模型选择、提示词、计费、上传、生成、播放和导出契约。
- 移动端或触摸专用工作台。
- 对 Results、认证、权限、项目数据和付费队列业务语义的重构。
- 与本次信息架构无关的品牌重塑或全站页面改版。

### Key Entities

- **工具分组**: 一个一级工具入口，包含名称、图标、顺序、项目集合和窗口状态。
- **工具项目**: 可创建或打开某项能力的项目，包含用途、可用状态、不可用原因和创建行为。
- **画布节点**: 用户工作流中的输入、处理、确认、画板或结果单元，包含摘要、状态和连接。
- **角色输入**: 阶段节点的具名输入槽，包含角色、必填性、来源、上限和匹配状态；通用图片
  的角色由用户逐连接确认并绑定到对应连线，而不是由素材的永久分类或自动识图决定。
- **阶段确认**: 用户对特定第一轮输入与输出组合的确认；任一基准变化都会使其失效。
- **画板**: 可持久保存和继续编辑的绘画内容，拥有独立笔画历史与编辑期恢复草稿；每次编辑结束
  形成一条项目历史，保存后的已提交预览可直接作为图片输出，也可显式导出为独立图片节点。
- **色板**: 一组可复用颜色及其名称、格式、最近使用和收藏状态；作为独立节点通过明确连线向
  兼容节点提供颜色，不直接改写当前选择。
- **能力状态**: 工具项目是否可用、所缺前置条件以及是否允许创建或运行节点。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 至少 90% 的首次使用者能在不阅读教程的情况下，于 30 秒内找到指定工具并创建节点。
- **SC-002**: 至少 95% 的测试用户首次即可把人物、场景、主穿搭和指定配饰连接到正确角色。
- **SC-003**: 100% 的重复角色、错误角色、超限输入和未确认基准在生成前被阻止，付费请求数为零。
- **SC-004**: 代表性第一轮和第二轮节点的常态高度相对整改前降低至少 30%，同时保留运行必需信息。
- **SC-005**: 用户在 2 秒内能从选中节点辨认其直接上游和下游路径；自动整理后目标连通工作流
  不存在节点重叠，且其他独立工作流的位置变化为零。
- **SC-006**: 在 1024、1280 和 1440 三个验收宽度及三种主题下，全部核心操作均无需横向页面滚动。
- **SC-007**: 鼠标和键盘打开悬浮窗口的可见反馈均在 250 毫秒内出现，图标到窗口移动过程无意外关闭。
- **SC-008**: 用户可在 2 分钟内创建画板、绘制简单图案、保存并导出为可连接图片节点。
- **SC-009**: 不可用视频项目的误创建、误运行和误计费次数在全部验收场景中为零。
- **SC-010**: Results 现有恢复、查看、对比、下载和设为输入回归场景保持 100% 通过。
- **SC-011**: 所有核心交互可仅用键盘完成，并在减少动态效果模式下无依赖动画才能理解的状态。
- **SC-012**: 全部色彩工具验收场景中，颜色选择创建色板节点的比例为 100%，直接修改现有节点
  或字段的次数为零。

### Measurement Protocol

- Before any compact-node implementation, capture `getBoundingClientRect().height` for fixed representative first-round and second-round fixtures at 1024, 1280 and 1440 CSS px in the current theme. Store the fixture content, viewport, browser version and numeric baselines in `implementation-evidence.md`. SC-004 passes only when the same fixtures measure at or below 70% of their matching baselines while all required information remains visible.
- SC-001, SC-002, SC-005 and SC-008 use one moderated first-use study with at least 20 participants who have not used this build or read its tutorial. Allocate widths as evenly as possible across 1024, 1280 and 1440; use a clean seeded project and identical task cards; record anonymized completion time, first action, corrections and pass/fail only.
- SC-001 passes at 18/20 or better within 30 seconds, measured from revealing the named-tool task card until the correct node exists. SC-002 passes at 19/20 or better when all requested roles are correctly bound without first creating an incorrect edge. SC-005 passes at 18/20 or better when the participant identifies the requested direct upstream and downstream nodes within 2 seconds after selection. SC-008 passes at 18/20 or better within 120 seconds, measured from revealing the board task until a saved, connectable image output exists.
- Automated E2E verifies deterministic geometry, timing instrumentation and zero-side-effect rules, but MUST NOT be reported as proof of the human success-rate criteria. Failed or unavailable moderated testing is reported explicitly rather than converted into an automated pass.

## Assumptions

- 目标用户是使用桌面浏览器的服装设计师、设计助理和管理员。
- 当前项目、素材库、权限、生成队列、Results 和三主题继续作为既有能力使用。
- “五个分组”通过把绘画工具和色彩工具合并到“创作工具”实现；二者仍在窗口内保持独立区域。
- 双模型分步换装继续遵守现有参考角色、最多参考图、人工确认和面料工艺规则。
- 视频制作本次只定义入口与安全启用门槛；每种视频生成能力需要单独功能规格后才能启用。
- 画板第一阶段以服装图案、标注和简单构成为目标，不替代专业矢量或图像编辑软件。
- 工具栏采用悬停延迟以减少误触，同时必须提供点击固定和完整键盘替代方式。
