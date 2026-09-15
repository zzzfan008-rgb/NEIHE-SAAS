# Pantone 色彩管理与面料分析 Implementation Plan

> 执行时使用 `executing-plans` 技能，按任务逐项实施与核验；项目 AGENTS.md 和用户最新授权优先。子代理仅用于只读调查与审查。

**Goal:** 在现有色彩工具中增加 Pantone 主库与品牌色组管理，并在素材库中提供“上传图片 → 裁切 → 模型分析 → 人工校准 → 共享面料入库”的独立流程。

**Architecture:** 复用现有 React/shadcn 界面、Express 鉴权、PostgreSQL 持久化和图片存储。Pantone 是只读基础库，品牌色组由管理员维护；面料分析与现有场景分析分离，确认后的裁切样本复用现有共享素材体系。

**Tech Stack:** TypeScript、React、项目本地 shadcn 组件、Zustand、Express、PostgreSQL 18、Sharp、现有 API 网关与 Gemini 图片理解接口。

**状态：** 任务 1～6 与管理员专项 CM-00～08 已完成并通过集中验收：主库/品牌 API、XLSX/ASE 私有预览与人工确认、Pantone 身份色板/收藏、用户色彩工具、材质分析、共享面料保存及历史面料校准查看/编辑均已实现。完整 `check`/`build`、隔离 PostgreSQL 与 1024/1280/1440 桌面 E2E 通过，并完成 ego-browser 实机验收。真实 Pantone 数据未写入业务数据库：专有输入仍在仓库外，须由运营方确认许可和目标数据库后通过受控 CLI/UI 导入。专项证据见[开发计划](./2026-09-14-color-management/development-plan.md)、[周期与里程碑](./2026-09-14-color-management/schedule.md)、[架构设计](./2026-09-14-color-management/architecture.md)和[执行 TODO](./2026-09-14-color-management/TODO.md)。

**日期与分支：** 2026-09-14，`ui-design`。

---

## 1. 已确认的产品范围

### 1.1 色彩工具

- 保留现有基础色系、收藏、自定义色、最近使用、手工输入和吸管功能。
- 新增 Pantone 一级页签，下分“全系列 / NEIHE Color / 参考品牌”。
- 全系列支持色号、名称搜索，以及系列、色相筛选。没有来源名称时不编造名称。
- 品牌按“品牌 → 系列/季节 → 主题色组”组织。
- 色卡显示 Pantone 色号和对应 HEX；保存原始颜色空间、原始色值及来源。
- 品牌色只能引用 Pantone，不直接将自定义 HEX 作为正式品牌色。
- Pantone 按“色库 + 色号”保留身份。不同色号即使 HEX 相同，也不在选色、收藏或项目保存中合并；普通颜色仍按 HEX 去重。
- 支持单色选择和整组加入。品牌色组可超过 8 色，但工具单次创建色板最多 8 色；整组加入会超限时明确提示，不静默截断。
- 保持现有逐色生成，不新增单图多色比例控制。

### 1.2 管理员色彩管理

- 入口：现有账户面板新增管理员专用“色彩管理”页签。
- 管理员维护品牌、系列/季节、主题色组、颜色顺序和参考比例。
- 保存即生效，不增加业务草稿统一发布或定时发布体系。
- Pantone 主库只读，不提供管理员单条增删改，也不在首版后台提供主库整包替换。
- 管理员可自行上传 Excel `.xlsx` 和 Adobe `.ase` 文件导入品牌色组。
- 导入必须先解析预览，再处理异常，最后确认保存；上传不等于发布。
- 无法匹配、缺少色号、重复记录必须展示，由管理员修正或明确跳过。
- HEX 近似匹配仅提供候选，不能自动认定为准确 Pantone 色号。
- 导入待处理记录与正式品牌色组分开；这不是增加“全站草稿后统一发布”功能。

### 1.3 图片与面料分析

入口固定为：**素材库 → 面料 → 上传并分析**。

流程固定为：

1. 上传图片。
2. 人工裁切目标面料区域。
3. 选择视觉理解模型，默认 Gemini，允许每次切换。
4. 分析裁切区域的材质与配色。
5. 人工校准裁切、材质描述、HEX 和 Pantone 候选。
6. 确认后将样本和校准数据保存到团队共享素材库。

约束：

- 不新增左侧独立入口，不新增面料分析画布节点。
- 可复用素材是**原图裁切样本**，不生成纹理、不去褶皱、不改变光照、不透视校正、不制作无缝纹理。
- 改变裁切范围后，旧分析结果不能直接当作新区域的有效分析结果；需要重新分析。
- 模型输出包含材质类型、纹理、光泽等信息与配色；成分、克重等不能仅凭照片可靠确定的内容标为推测或待确认。
- 入库前必须确认素材名称、裁切区域、材质描述及至少一个颜色；材质允许填写“无法确定”。
- 配色可只保存 HEX，Pantone 匹配允许暂缺。
- 全部登录用户可创建共享面料素材；创建者可修改自己的素材，管理员可管理全部共享素材。
- 未确认的分析结果不出现在共享素材库中。
- 校准后的配色默认只随面料样本保存；仅管理员可另外选择归入品牌色组，归组前必须确认 Pantone 色号。
- 图片不是色彩管理的第三种导入文件；其分析链路与 Excel/ASE 导入分开。

### 1.4 模型选择

- 默认使用现有 Gemini 视觉理解模型配置。
- 管理员配置可用模型清单，普通用户每次分析从该清单选择。
- 没有配置其他可用视觉模型时不展示虚假选项。
- 不把生图模型或纯文本模型直接放入图片理解选项。
- 复用现有网关，密钥只在服务端；不向普通用户开放任意网关 URL、密钥或模型字符串。
- 调用前提示将发送裁切图并产生模型调用费用；没有真实价格数据时不编造金额。

## 2. 已核对的输入资料

### 2.1 Pantone 基础库

文件：`/Users/neihe/Downloads/3af99-main.zip`。

外层包含：

- `3af99-main/README.md`
- `3af99-main/LICENSE`
- `3af99-main/潘通色标薄全系列.zip`

内层实际包含 **26 个 ACB 和 3 个 ASE**，不是 README 所称的 `.ai` 文件。

包含 TCX、TCX New Colors、TPX、TPG、TSX、TPM、Solid Coated/Uncoated、Color Bridge、Goe 等系列与不同版本。26 个 ACB 共解析出 35,098 条记录，颜色空间标记为 Lab；这不是去重后的颜色总数，也不包含三个 ASE 的条目数。

- TCX 主文件包含 2,310 条记录，TCX New Colors 包含 175 条。
- 至少存在跨文件重复色号，例如 `15-1114 TCX`。
- 不将文件名“全系列”当作官方完整性、最新版本或准确性证明。
- LICENSE 是含 `[year] [fullname]` 占位符的 MIT 文本，不能据此认定第三方 Pantone 数据的商业再分发授权已确认。
- 保留来源清单、文件哈希、系列/版本和转换算法版本。原始资料、转换产物默认作为本地数据管理，不直接加入代码提交。

### 2.2 Chloé

文件：`/Users/neihe/Downloads/palette.ase`。

实际为 10 个 RGB 颜色，无分组，名称为 HEX，没有 Pantone 色号、年份、季节或主题信息：

```text
#ECDBA5
#F6F6F6
#FAFFE1
#EECDC6
#000000
#D3E0C4
#8CC8D3
#D6B46C
#B9A2B6
#5E3A24
```

**用户决定：** 为这些 HEX 推荐近似 TCX，保留原始 HEX，经人工确认映射后才发布正式品牌色组。不自动将最近色当作准确对应色。

### 2.3 Ralph Lauren

文件：`/Users/neihe/Downloads/Ralph Lauren color matching.xlsx`。

工作表 `Sheet1`，表头为“色号”“比例”：

| 原始色号 | 比例 | 提供的 TCX 库匹配 |
| --- | ---: | --- |
| 13-1007.TCX | 38% | 已找到 |
| 19-4203.TCX | 30% | 已找到 |
| 14-0708.TCX | 11% | 已找到 |
| 11-1111.TCX | 9% | 未找到 |
| 15-1040.TCX | 4% | 已找到 |
| 17-1510.TCX | 2% | 已找到 |
| 11-0606.TCX | 未填写 | 已找到 |
| 15-1114.TCX | 未填写 | 已找到 |
| 11-4201.TCX | 未填写 | 已找到 |
| 18-1553.TCX | 未填写 | 未找到 |

**用户决定：** 已匹配 8 色先进入正式色组，另外 2 色保留待核对记录。不能拿 TPX/TPG 等其他后缀替代 TCX。

比例保留为参考信息，不自动补齐、归一化或驱动生成。原文件 6 项比例合计 94%；先发布的 8 色中已知比例合计 85%，不能误显示为完整配比。

### 2.4 NEIHE 与缺失分类信息

- NEIHE 颜色以后提供，首版目录为空，不生成示例颜色。
- 品牌文件没有提供可靠年份或主题名。建议首批使用“导入色组”，年份/季节留空并显示“未标注”；不猜测 Chloé Spring 的年份。

## 3. 已核对的代码基线与影响面

本次 CodeGraph 状态：索引 up to date，292 个文件、4,686 个节点、17,714 条边。

| 位置 | 当前事实与关联风险 |
| --- | --- |
| `src/components/workbench/ColorToolPanel.tsx` | 现有色彩弹窗；交互最多 8 色。 |
| `src/lib/colorPalette.ts:56` | `normalizeColorSwatches` 按 HEX 去重，会丢失同 HEX 不同 Pantone 色号。 |
| `src/types/workflow.ts:167` | 工作流 `ColorSwatch` 是新增色号身份的目标契约；不要误改 `src/lib/colors.ts` 中同名基础色系类型。 |
| `src/lib/documentSnapshot.ts:312` | 色板进入严格文档快照；只保留颜色业务数据，不加入弹窗、选区或分析过程状态。 |
| `server/lib/workflowSchema.ts:423` | 当前仅接受 paletteVersion 1、1–32 色，按 HEX 判重；必须与前端新身份规则同步。 |
| `src/store/customColors.ts`、`server/routes/auth.ts` | 现有账号隔离、收藏同步、并发和回滚保护必须保留。 |
| `server/engine/dag.ts:381` | 连接色板后将 swatches 的 value 映射为执行颜色数组。 |
| `server/engine/runner.ts:949` | 每个颜色独立调用，保留部分成功结果；不能因比例字段改变执行语义。 |
| `src/components/panels/AccountMenu.tsx` | 色彩管理入口。 |
| `src/components/AssetPickerOverlay.tsx` | 已复用 Dialog、Tabs、Select、Button 等本地组件，适合承接面料流程。 |
| `server/routes/assets.ts:205` | 当前 shared/private 修改仅归属者允许，管理员只对 global 有额外管理权；已确认的新共享管理要求需显式扩展。 |
| `server/lib/sceneAnalysis.ts` | Gemini generateContent 图片理解链路；现有提示词明确禁止描述服装，不可直接套作材质分析。 |
| `server/lib/tryOnCandidateSelection.ts` | 存在 chat/completions 视觉请求实现，可参考协议，不等于已有通用多模型清单。 |
| `server/config.ts` | `SCENE_ANALYSIS_MODEL` 默认 `gemini-3-flash-preview`；本次未读取私密环境变量，未验证实际运行型号。 |
| `server/lib/fileStore.ts` | 原图、缩略图和上传规范化已有实现；规范化路径可能压缩图片，不能直接假定满足原始裁切像素要求。 |

CodeGraph impact 已核对 `ColorSwatch`、`normalizeColorSwatches`、`CustomColorsState`、`Asset`、`assetsRouter`、`AccountMenu`。主要影响包括文档快照、画布创建、flowStore、面料替换、账户界面及授权测试。图谱非穷尽；实现前按准确符号和当时分支重查。

工作区已有暂存改动：`compose.yaml`、`tests/docker-lan-deployment.test.mjs`；未跟踪 `backups/`。不得覆盖、混入当前批次或回退。

## 4. 已批准的界面方案

### 色彩工具

扩大现有弹窗，而非新增独立路由：上方分类、搜索和筛选，中间色卡网格，底部固定已选颜色及确认操作。跨分类保留当前选择；超出 8 色明确提示。

### 色彩管理

账户面板适度加宽，左侧品牌/系列/主题树，右侧色组编辑。导入预览列出原始值、匹配状态、候选、确认色号、参考比例、错误原因。保存后刷新正式列表；待处理记录不能伪装为已发布颜色。

管理员模型配置放在同一管理区域的“分析模型”子区：可用模型显示名、网关型号、受支持的请求协议、启用状态和默认标记；密钥仍由服务端现有配置管理。

### 面料分析

现有素材库面料分类内打开流程，左侧原图裁切/样本预览，右侧模型选择、材质字段及配色校准。底部显示调用、分析状态、错误和共享保存操作。关闭有未保存更改时确认；失败不丢弃人工输入。

全部标准控件使用 `src/components/ui/`，沿用 `data-theme` 和 `--gc-*`。支持 1024、1280、1440 CSS 像素桌面宽度；键盘、可见焦点、焦点恢复与 reduced-motion 必须保留。不扩展移动端范围。

## 5. 数据与接口设计方向

以下为建议实施契约，应在第 9 节技术核对后固定具体 schema，不能直接把整个分析响应透传为业务数据。

### 5.1 色库与色组

- `CatalogColor`：稳定 ID、色库/系列/版本、标准化色号、可选名称、原始颜色空间及分量、显示 HEX、来源文件/哈希、转换版本。
- `BrandColorGroup`：品牌、可选系列/季节、主题名、有序成员、revision。
- `BrandColorMember`：引用 CatalogColor ID、可选参考比例；不复制成可任意编辑的主库色。
- `ColorImport`：管理员归属、原文件哈希、原始行、逐行匹配/跳过/待核对状态及目标色组；确认操作幂等。
- 主库相同身份且值相同的重复可合并来源；相同身份但原始值冲突的记录必须隔离核对，不按文件顺序覆盖。
- HEX 规范化使用现有解析器。`13-1007.TCX` 可标准化为 `13-1007 TCX`；不同系列后缀不能互换。
- 色差计算只给近似候选。建议统一到有明确参考白的 Lab 后使用 CIEDE2000，默认推荐 TCX 前 3 个候选，显示近似性质；原始数据不可被转换值覆盖。
- 所有色号查询、筛选与分页由服务端处理，避免一次将全部色库注入前端入口 bundle。

建议接口分组：

- `/api/colors/catalog`：登录后只读分页搜索与详情。
- `/api/colors/brands`、`/api/colors/groups`：普通用户读，管理员写；写操作携带 revision，冲突返回 409。
- `/api/colors/imports`：管理员上传、预览、修改映射、确认导入；确认时再次检查色号和权限，事务写入。
- `/api/material-models`：普通用户只读启用清单，管理员维护非密钥配置。

### 5.2 色板与收藏兼容

- 为工作流 swatch 增加可选 Pantone 身份快照，至少保存色库、色号、目录 ID 与当时显示 HEX；品牌来源可选。
- 新身份规则必须覆盖选色、收藏、最近使用、画布创建、持久化、恢复和服务端校验。
- 旧 HEX 收藏及历史色板继续可读；不可因主库/品牌色组变化而改写已保存项目颜色。
- 保留历史 1–32 色文档的读取能力，不为了新工具 8 色限制破坏旧项目。
- 色号不同且 HEX 相同的条目保留现有数组顺序传给执行层，不擅自去重或增加单图配比模式；相同 HEX 的执行目标并不意味着模型能产生不同物理专色效果。
- 数据迁移需保留账号隔离、收藏上限、初始化合并、并发锁和切换账号时的过期响应拦截。

### 5.3 面料样本与模型分析

- 使用专门的材质分析结果 schema：材质描述、可观察属性、推测/待确认项、提取颜色、近似 Pantone 候选。
- 分开保存模型原始建议和人工校准结果，记录模型 ID、分析时间、裁切版本、确认者与确认时间。
- 服务器验证裁切坐标与原图尺寸；按图片方向校正后的坐标系裁切，保留样本分辨率，不拉伸或生成像素。
- 只将裁切样本发给模型。默认不将上传的完整原图公开给其他用户，共享库只提供确认后的样本。
- 来源图及裁切版本用于追溯，不能成为绕过文件授权的任意本地路径或远程 URL。
- 分析请求使用幂等标识；重复点击不重复计费。失败、超时与结果未知要区分，不自动重新调用付费模型。
- 裁切更换、账号切换或流程关闭后，迟到响应不得覆盖新的编辑内容。
- 素材保存继续使用 `category=fabric`、`scope=shared`；裁切文件、素材行、元数据和关联更新采用事务与失败清理。
- 管理员对 shared 素材的权限扩展同时覆盖服务端及 `canManage`；不要顺手放宽其他用户 private 素材的权限。
- 保持现有素材删除恢复窗口、项目引用和文件清理保护。已用于项目的样本不得被编辑操作原地替换而静默改变旧项目。

建议接口分组：

- `/api/material-analyses`：创建/读取分析，绑定当前用户、裁切样本和模型快照。
- `/api/assets` 的面料保存/更新契约：增加严格验证的材质与配色元数据；旧素材无此字段时正常展示。
- 管理员从面料加入品牌色组走同一品牌写接口，不能从普通素材保存接口绕过管理员检查。

## 6. 实施顺序与文件范围

所有任务开始前先读取当时的源码、现有 diff 和 CodeGraph impact。新文件名称是计划位置，不代表当前已存在。

### 任务 1：主库解析、归一化与导入验证

涉及：新增 `server/lib/colorCatalog.ts`、`server/lib/colorImport.ts`、`src/types/colorCatalog.ts`；必要的本地数据转换脚本。

1. 用合成 ACB/ASE/XLSX 夹具建立解析与异常回归测试，不提交完整商业色库。
2. 固定 ACB/ASE 的版本、编码、颜色空间和边界检查。
3. 实现有限资源的文件解析；Excel 只读取数据，不执行公式、宏或外部链接。
4. 核对 Lab/RGB 到显示 HEX 的转换，原始值与显示值分开。
5. 构建来源清单、重复/冲突报告和可重复的主库初始化流程。

验收：29 个源色库均得到明确成功或错误状态；不得静默忽略色库；TCX 8 色匹配与 2 色缺失结果可复现。

### 任务 2：数据库与受控 API

涉及：`server/lib/database.ts`、`server/index.ts`；新增 `server/routes/colors.ts`、模型配置路由及对应共享类型。

1. 增加后续编号迁移，不修改已发布迁移，不把本地专有源文件直接嵌入迁移代码。
2. 建立色库、品牌层级、成员顺序、导入待处理状态和模型清单数据。
3. 实现读接口、管理员写接口、事务、revision 冲突、幂等确认及上传限额。
4. 将所有新接口放在正确的登录/改密/管理员边界后，不影响 health、ready、login、session。

测试：编号迁移、重复初始化、非管理员写入拒绝、文件解析超限、伪造目录 ID、并发修改、事务回滚。

### 任务 3：色板身份与收藏迁移

涉及：`src/types/workflow.ts`、`src/lib/colorPalette.ts`、`src/lib/documentSnapshot.ts`、`src/store/customColors.ts`、`src/store/flowStore.ts`、`server/lib/workflowSchema.ts`、`server/routes/auth.ts`，以及已证明直接依赖的画布创建契约。

1. 明确旧/new palette 与收藏 API 的兼容策略，再修改生产类型。
2. 统一身份 key，保留普通 HEX 去重与 Pantone 独立身份。
3. 更新前后端校验及快照边界，迁移旧收藏但不清空历史数据。
4. 验证色板与面料替换 DAG 的传递，不删除或弱化结果恢复、比较、下载和继续处理。

测试：`palette-flow`、`custom-colors`、`workflow-schema`、`document-snapshot`、`canvas-creation`、`active-document-boundary`、`dag`、账号收藏授权与竞态。

### 任务 4：色彩工具与管理员界面

涉及：`src/components/workbench/ColorToolPanel.tsx`、`src/components/panels/AccountMenu.tsx`；新增管理子组件，必要时更新节点/检查器显示 Pantone 元数据。

1. 使用本地 shadcn 实现已批准的布局、搜索筛选和分页状态。
2. 加入品牌色组操作、8 色上限提示、跨分类选择保留。
3. 实现 Excel/ASE 导入预览、候选确认、跳过及待处理恢复。
4. NEIHE 初始化空目录；Chloé 只生成待校准导入记录；Ralph Lauren 8 色发布、2 色待核对。
5. 管理模型清单时不提供密钥明文显示，不接受用户任意 URL。

测试：空库、无搜索结果、全选超限、同 HEX 不同色号、导入报错、比例留空、重复确认、管理员与普通用户视图。

### 任务 5：面料分析服务与保存契约

涉及：新增 `server/lib/materialAnalysis.ts`、`server/routes/materialAnalyses.ts`、`src/types/materialAnalysis.ts`；关联 `server/routes/assets.ts`、`server/lib/fileStore.ts`、`server/config.ts`、`server/lib/database.ts`。

1. 复用图片验证和网关底层能力，新增独立材质提示词和严格结果校验；保持现有场景/换装分析行为不变。
2. 实现原图裁切、模型选择、分析幂等与状态处理。
3. 加入材质/配色人工校准数据、共享保存和引用保护。
4. 对 shared 素材统一归属者/管理员管理规则，保留 private 数据边界。

测试：伪造文件、越界裁切、EXIF 方向、模型错误响应、超时/重复请求、旧响应覆盖、非管理员归组、共享访问、删除引用、保存失败后的文件清理。

### 任务 6：素材库流程与集中验收

涉及：`src/components/AssetPickerOverlay.tsx`、新增面料分析/校准子组件及必要素材详情组件。

1. 在面料分类新增“上传并分析”，不新增全局入口或节点。
2. 串联裁切、模型选择、分析、校准和共享保存。
3. 为已存在的面料素材提供校准数据查看与有权限的编辑入口；历史素材无分析数据时不报错。
4. 集中复查色板、素材库、文件访问、项目绑定和账户切换链路。

## 7. 测试与交付门禁

本次保存文档不运行测试、构建或真实模型。以下属于后续实施验收要求：

- 用合成数据验证解析、色号规范化、重复冲突、色彩转换及近似候选排序。
- 精确覆盖两个真实输入格式：ASE 只有 HEX；Excel 色号带点分隔、比例部分为空。
- 新导入/分析失败不得影响已发布色组或已保存共享素材。
- 旧项目、旧 HEX 收藏、历史超过 8 色的色板继续加载；新工具仍限制 8 色。
- UI 在 1024、1280、1440 验证实际几何、滚动、键盘交互、焦点恢复和主题，不只断言 class 名。
- PostgreSQL 测试使用项目隔离 runner，禁止临时手写 Compose 生命周期。
- 付费模型全部 mock；真实模型验证另行取得明确授权。
- 按项目规则执行相关 focused tests、`npm run lint`、`npm run check`、`npm run build`、`git diff --check`。
- 构建前先运行目标范围静态/LSP 检查；交付前检查完整 diff，并执行 CodeGraph `sync` / `affected`，包括新增源文件。
- `gate:codex` 目前仍调用 GitNexus，不运行、不报告完整 gate 通过；明确报告此门禁未迁移。
- 不提交、推送、合并、发布或部署，除非另获对应授权。

## 8. 非目标

- 不改造结果系统、生成引擎整体架构、账号会话体系或工作流文档来源。
- 不增加移动端、独立面料工具导航或新画布节点。
- 不新增单图按比例多色生成。
- 不自动补齐 NEIHE 配色、不编造品牌季节，不自动确认 Chloé 色号。
- 不将图片分析扩展成纹理生成、去褶皱、平铺或材质物理检测。
- 不让管理员直接编辑 Pantone 主库，也不自动把缺失 TCX 映射到其他介质系列。
- 不改动现有 compose、LAN 测试或 backups。

## 9. 实施前技术复核清单

产品取舍已经确认；下列技术细节尚未通过完整源码/格式验证，执行者应先补齐证据并固化方案：

1. **ACB/ASE 完整格式与转换**：本轮是只读二进制结构核对，尚未完成全部 ASE 条目、ACB 尾部字段、版本冲突及参考白/配置文件验证。确认官方格式依据并建立独立转换样例，不能只凭原始字节到 HEX 的猜测上线。
2. **Excel 解析依赖**：当前生产依赖未见专用 Excel 解析器。只增加解决此次 `.xlsx` 导入必要的服务端依赖，明确 ZIP 膨胀、行数/单元格数、字符串长度和文件大小限额；不将解析器打入前端 bundle。
3. **数据部署与许可**：确定本地色库初始化的受控运维方式及运行时数据位置；未确认再分发权限前不将色库打包到公开仓库或发布资产。
4. **收藏与 palette 版本**：选定具体迁移和兼容契约，覆盖旧客户端写入不会删除新 Pantone 收藏；不得只修改前端类型。
5. **分析生命周期**：核对现有后台任务能力后确定分析任务存储、幂等、超时/中断恢复及临时源图清理，避免把材质分析误装成图片生成任务。
6. **裁切保真**：复核上传规范化的压缩/尺寸行为与原图保真要求，确认服务器裁切坐标、方向及无损样本保存方式。模型输入可按限制缩小副本，但不能覆盖共享样本原图。
7. **模型管理员配置**：固化配置 DTO、默认模型不能被禁用后的处理、仅允许已实现的协议/现有网关、请求快照和后端模型白名单。配置存在不等于外部模型能力已实际验证。
8. **共享与原图引用**：核对素材复制、编辑、删除、账号删除及文件回收调用链，保证仅公开裁切样本、私人原图不泄露，已引用样本不被原地替换或误删。

这些复核不授权扩大产品范围。若证据要求改变已确认的行为，应先说明差异并征求用户决定。

## 10. 实施记录：首批解析基础（2026-09-14）

- 新增 `server/lib/adobeSwatches.ts`、`src/types/colorCatalog.ts` 和 `tests/adobe-swatches.test.ts`；`package.json` 仅追加对应测试到现有 `test:suite`。
- 支持 ACB v1、ASE v1.0，保留原始名称、分组、编码分量、颜色空间、类型和 ACB 元数据；不进行 HEX 转换、Pantone 匹配、去重或数据库写入。
- 限制文件 16 MiB、记录 50,000、字符串 4,096 UTF-16 代码单元、ASE 分组嵌套 8 层；拒绝截断、无效编码/浮点数、不支持的块/版本/颜色空间和未知尾部。
- 验证：16 组合成回归测试通过；实际 29 个主库文件共 37,811 条均解析成功，Chloé 10 色解析成功，Ralph Lauren 8 个 TCX 匹配及 2 个缺失可复现；未写出原始色库或解压产物。
- `npm test`、`npm run lint`、`npm run build:web`、`npm run build:server` 均 exit 0；目标 LSP 无错误。`npm run check` 和 `npm run build` 总入口因系统缺少 pnpm 返回 127，已分别执行相应全部子步骤，但不将总入口本身记为通过。
- CodeGraph sync/affected 已执行；新增测试已被选中。未运行浏览器 E2E（本批未改界面）、真实模型或尚依赖 GitNexus 的 gate:codex。
- 独立只读审查未发现实现缺陷，提出的 Unicode、块长度与记录/trailer 截断测试缺口已补充并通过。
- 下一批：颜色转换与近似候选、受限 Excel 导入和来源冲突处理；全部产品功能尚未完成。

## 11. 实施记录：颜色转换与导入预览（2026-09-14）

- 新增服务端 `colorScience.ts`、`colorCatalog.ts`、`colorArchive.ts`、`xlsxColorRows.ts`、`colorImport.ts`，共享 DTO `src/types/colorImport.ts`；新增两个测试入口和合成 ZIP/ASE 夹具。
- 转换依据为 W3C CSS Color 4 的 D50/Bradford/sRGB 数学模型；明确记录算法版本、假设与出色域截断。Lab 必须由受控来源声明 D50，未知白点或无 ICC 的 CMYK 返回未转换状态，不编造 HEX。未标记 RGB/Gray 按 sRGB 近似并标注假设。
- 采用 CIEDE2000 排序 TCX 前 3 个候选，排除冲突/未转换身份，候选始终标注 approximate。主库身份为 libraryKey+code 的稳定哈希；原值判同只对 Lab 考虑白点，使用 Map/Set 合并来源，保留文件 SHA-256、版本、记录编号与原名。
- 服务端必要依赖仅增加 yauzl 3.4.0、saxes 6.0.0 和开发类型 @types/yauzl 3.4.0，锁文件仅新增相关条目，未升级现有依赖。安装使用与原 node_modules 一致的临时 pnpm 11.19.0，并禁用安装脚本。
- XLSX 支持静态“色号”及可选“比例”列、共享/内联字符串和数值。限制文件 10 MiB、ZIP 条目 200、单条解压 8 MiB、合计 32 MiB、XML 深度 32、每节点属性 64、单字符串 4096、共享字符串 20000、8 个工作表、每表 32 列/20000 单元格、合计 5000 数据行。
- ZIP 流式检查实际解压量与 CRC，不落盘；拒绝宏、外部引用、DTD、重复条目、越界引用及合并单元格。普通公式逐行标为无效且不采用缓存值；数组/范围公式整表拒绝；校验行/单元格父子路径、命名空间和重复值节点。
- 导入预览区分匹配、缺色号、未找到、冲突、重复和无效状态；空比例不补齐，数值不归一化。返回原始行/ASE 色板及文件哈希，不写数据库或发布品牌色。
- 实际验证：29 个源库可构建内存目录；TCX 主/New Colors 的 175 个重复项原值一致，合并后 2310 个身份；Ralph Lauren 8 匹配/2 未找到、4 个空比例、合计 94%；Chloé 10 个原始 HEX、每色 3 候选，确认身份为空。真实色库与候选未输出到代码仓库。
- 独立审查发现的平方级来源查重、数组公式缓存值、XML 扩展注入、非 Lab 白点误冲突、极小数值比例误拒绝均已修正，并补回归测试。
- 新增 9 个源/测试文件 LSP 无错误，独立服务端/测试 TypeScript 检查通过；完整 `check`（含全量隔离 PostgreSQL 测试）及 `build` 均 exit 0。命令：`npm exec --yes --package=pnpm@11.19.0 -- npm run check`，build 同理。这解决了首批验证时 pnpm 不在 PATH 的问题，不是全局安装。
- 旧 adobeSwatches.ts 的 LSP 曾残留超出文件末尾的重复实现诊断；未修改已正确的原文件，独立 tsc 和实际解析测试通过，旧缓存不作为磁盘缺陷。
- 仍未运行真实模型、浏览器 E2E 或尚依赖 GitNexus 的 gate:codex；未提交、推送或改变现有暂存区。下一批接受控来源清单/初始化与数据库 API。

## 12. 实施记录：主库持久化与只读 API

- 迁移 19 `versioned_color_catalog` 新增 `color_catalog_releases`、`color_catalog_identities`、`color_catalog_versions`、`color_catalog_state`。沿用既有迁移事务/锁，编号迁移与 SQLite 后挂恢复测试更新为 1–19。业务数据未迁移，初始主库为空。
- `server/lib/colorCatalogStore.ts` 使用稳定身份与独立 release 快照；只插入版本，不覆盖旧值。状态行锁 + expectedRevision 防止并发覆盖；相同活动 release 重试幂等；全部写入与活动指针切换在单事务中。旧 release 仍可按 ID 查询。
- `server/routes/colors.ts` 接入既有 requireAuth / requirePasswordChanged 之后：`GET /api/colors/catalog`、`/catalog/state`、`/catalog/libraries`、`/catalog/:id`。没有主库 HTTP 写接口。
- 分页支持 `releaseId`、`q`、`libraryKey`、`status`、`hue`、`limit`、`offset`；每页 1–100（默认 50），offset ≤50000；q ≤96，LIKE 通配符按字面转义。返回 releaseId、activeReleaseId、revision、total、nextOffset；后续分页带 releaseId 可固定快照。色相按显示 sRGB/HSL 分组，非物理专色分类。
- 列表只给轻量摘要，详情保留原始分量、转换信息与来源。冲突/未转换条目的列表 HEX、色相为空，不当作可选已确认颜色。统一 no-store；未知版本/色号 404，无效参数 400。
- `server/lib/colorCatalogManifest.ts` 读取目录外部提供的 JSON 清单：版本 1、usageRightsConfirmed=true、1–64 个来源；来源包含 path、libraryKey、version、sha256，可选 labWhitePoint=D50。清单 ≤1 MiB，单源 ≤16 MiB、合计 ≤64 MiB；来源路径相对清单目录，拒绝路径越界、符号链接、非普通文件、哈希不符和未知字段。
- `scripts/import-color-catalog.ts` 默认只执行静态预检，不加载数据库配置。`--expected-revision N --apply` 才启用实际数据库写入。`colorCatalogRelease.ts` 统一 dry-run/apply 的非空、单色变体 ≤64、每变体来源 ≤128、转换 JSON ≤64 MiB 检查，数据库连接之前就拒绝静态无效输入。
- 操作示例（本次没有对真实清单执行）：`node --import tsx scripts/import-color-catalog.ts --manifest /private/catalog/manifest.json`。确认权利、目标数据库及当前 revision 后，追加 `--expected-revision N --apply`。输入清单与专有色库继续放在代码仓库之外；不得用虚构版本或权利声明代替核验。
- 独立审查发现的 FIFO 阻塞和 dry-run 校验不完整问题已修复：非阻塞打开后校验普通文件，共用发布预检；补充合成清单/CLI、特殊文件、空目录、真实会话鉴权、分页、版本保留、幂等、并发、数据库中途失败回滚与迁移重入测试。
- 本批 13 个源/测试文件主 LSP 与沿用项目 strict 模式的独立 TypeScript 检查通过；完整 `check`（含隔离 PostgreSQL 全量测试）与 `build` 均 exit 0，沿用临时 pnpm 11.19.0 包装命令；CodeGraph sync/affected、目标 diff 和未跟踪新文件空白检查均已完成，原有测试命令无删除，暂存区保持原状。
- 本批当时只完成主库持久化/只读 API；后续品牌管理、上传校准、色板身份、用户色彩工具和材质分析均已完成，当前状态与集中证据见文件顶部及第 13～14 节。真实模型、生产导入、部署和 GitNexus 依赖的 gate:codex 未运行。

## 13. 实施记录：色板身份、收藏与用户色彩工具（2026-09-15）

- 工作流色板升级为向后兼容的 `paletteVersion: 1 | 2`。普通颜色继续按规范化 HEX 去重；Pantone 按不可变 `catalogId` 保留独立身份，同 HEX 不同色号可同时选择、收藏、保存、恢复并传给 DAG。服务端在项目、草稿、模板、画板和执行边界校验 release/catalog/library/code/HEX 的 canonical 元组。
- 账号收藏 API 与本地 Store 同时支持旧 HEX 收藏及 typed Pantone 收藏，共享 128 条上限；旧响应缺少新字段时保留本地迁移数据，普通收藏写入携带 Pantone bootstrap 快照，串行写入、回滚和账号隔离不变。
- 色彩工具新增 Pantone 顶层页签及全系列、NEIHE Color、参考品牌；支持色号/来源名称搜索、主库系列与色相筛选、品牌系列/年份/季节层级、版本固定分页、同 HEX 身份选择、整组超 8 色拒绝而不截断。节点与检查器显示色号和库来源。
- 管理端 CM-00～08 已完成目录 CRUD、色组全量排序/比例、脏状态与未知写结果恢复、版本固定选择器、XLSX/ASE 私有预览、人工校准和部分幂等发布。详细状态与验收证据保留在专项四份文档。

## 14. 实施记录：材质分析、共享面料与集中验收（2026-09-15）

- 合并 `main` 既有 AI styling 迁移后，材质分析使用迁移 22；新增受认证材质分析 API、管理员模型 allowlist 和独立 Gemini 材质提示词/严格 JSON 解析。原图与裁片绑定 owner；裁切使用方向感知的归一化坐标，付费分析受既有 AI 限流、每账号并发 2、未入库草稿 20 条/100 MiB 和 7 天清理约束。
- 分析记录使用 revision 锁和显式 `outcome_unknown` 恢复 15 分钟陈旧租约；UI 对分析/保存未知结果先刷新记录，不盲目重试。关闭或替换未入库分析必须确认并删除服务端草稿。模型配置仅接受已实现的 Gemini 协议，不向浏览器返回网关密钥。
- 人工校准要求名称、材质描述与 1～12 个 canonical HEX，可保留主库校验后的 Pantone 身份。保存时只共享原图裁切样本，私人原图不对其他账号公开；创建者可编辑自己的共享面料，管理员可管理全部非 private 素材，收窄可见性和删除均受跨账号项目引用保护。
- 素材库面料分类提供“上传并分析”；已校准面料可查看/编辑材质与颜色，历史面料缺少分析数据时显示空态而不报错。未增加全局工具入口、移动端布局或画布节点。
- 最终验证：目标 LSP 无错误；`npm exec --yes --package=pnpm@11.19.0 -- npm run check` 与同包装的 `npm run build` 均 exit 0；四个专项 E2E 在 1024、1280、1440 共 121 项通过、3 项可选 ego review 窗口跳过。ego-browser 在新建隔离实例验证 Pantone 工具、面料上传/裁切/校准前状态、模型设置、未知主库空态、对话框几何及放弃草稿流程，截图保存于 `/tmp/final-ego-pantone-wide.png`、`/tmp/ego-material-analysis.png`、`/tmp/ego-material-model-settings.png`。
- 最终独立只读审查发现的问题已闭环：每条 Pantone 引用逐项 canonical 校验；旧收藏响应不清空本地 Pantone；目录/删除/模型配置的脏状态、进行中和未知写结果均阻止离开并要求显式刷新；材质人工校准刷新不再覆盖草稿；未知付费分析必须二次确认；陈旧分析租约在全局清理和账号转移前恢复；账号转移同步 `material_analyses.owner_id` 并阻止仍在进行中的分析。合并复审进一步加入 feature 分支材质迁移 21 到迁移 22 的原子让位恢复，并以按账号事务级锁串行化草稿配额检查与写入。对应 PostgreSQL、单元和三宽 E2E 回归已纳入上述 `check`/E2E 结果。
- CodeGraph 已同步并按全部新增/修改源文件选择受影响测试；`gate:codex` 仍调用被项目规则禁用的 GitNexus，未运行且不报告完整 gate 通过。真实 AI 调用、专有 Pantone 数据导入、部署和发布不在本次验证中。
