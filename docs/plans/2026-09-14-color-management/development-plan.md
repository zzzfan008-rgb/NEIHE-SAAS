# 主库品牌 API 与管理员管理：分阶段开发计划

> 执行时使用 `executing-plans`，一次推进一个小任务；项目 `AGENTS.md` 和最新用户授权优先。子代理只读，提交、推送、发布、部署另行授权。

**Goal:** 将已经实现的色彩后端接成可用、可校准、可恢复的管理员色彩管理流程，而不是继续以一个大任务交付。

**Architecture:** PostgreSQL 保存主库版本与已发布品牌色组；Express 负责权限、校验、事务和 revision。前端复用本地 shadcn，编辑状态留在管理组件内，导入预览与正式色组分离。

**Tech Stack:** TypeScript、React、项目本地 shadcn/Base UI、Express、PostgreSQL 18；沿用已有 ACB/ASE、ZIP/XML、色彩转换实现，不在浏览器引入解析器。

**基线：** 2026-09-14，`ui-design`，HEAD `14be0b4e7b28087cc9031ddb3e7c96de51f67060`。本文基于该 HEAD **加当前未提交工作区**，不是仅基于已提交代码。

## 文档导航

- [周期与里程碑](./schedule.md)：工作量估算，不是交付承诺。
- [架构与接口边界](./architecture.md)：现有实现与拟新增模块。
- [TODO / 验收台账](./TODO.md)：任务状态的维护入口。
- [原始产品总计划](../2026-09-14-pantone-color-management-fabric-analysis.md)：保留原需求；本文仅细化原任务 2 / 会话任务 #7。

## 1. 当前状态与边界

### 已实现后端与历史验证记录

- ACB/ASE 解析、颜色转换、稳定身份与来源冲突处理、受限 XLSX/ASE 预览。
- 迁移 19：四张主库版本表；受控清单初始化，默认 dry-run；登录只读目录 API。
- 迁移 20：品牌、系列、主题色组、成员、私有导入记录、确认回执六张表。
- 品牌/系列/主题 CRUD；人工映射、部分确认、重复确认幂等、旧主库版本保护。
- CM-00～08 已完成并通过完整 check/build、隔离 PostgreSQL 与三档桌面 E2E；详细证据见 TODO 第 6～13 节。
- 只预置 NEIHE Color、Chloé、Ralph Lauren 品牌名称，没有发布真实品牌色，没有将真实 Pantone 资料导入业务数据库。

### 前端当前状态

- `src/lib/colorManagementClient.ts` 与 `ColorManagementSession.tsx` 已完成请求和身份作用域。
- `AccountMenu.tsx` 已挂载管理员专用色彩页签；账户容器使用本地 shadcn Dialog/Tabs。
- `ColorManagementPanel.tsx` 已完成目录、色组、上传/导入页签接线；`ColorImportPanel.tsx` 与 `ColorImportReview.tsx` 已完成私有预览、人工决定、部分确认及恢复。

本专项 CM-00～08 已完成；下一阶段是原始总计划任务 3（色板身份与收藏迁移）。

### 本次拆分包含

管理员入口、品牌/系列/主题维护、色号编排、引用版本与比例、Excel/ASE 上传预览、逐行人工校准、部分确认及恢复、错误与权限验证。

### 明确不包含

- 普通用户色彩工具的 Pantone 一级页签、整组加入、收藏与工作流身份迁移：仍属于后续任务 #8。
- 图片裁切、模型选择、面料分析、共享素材权限与入库：仍属于后续任务 #9。
- 主库在线编辑、自动 HEX→Pantone 确认、比例归一化、移动端、真实模型调用。
- 生产数据导入、部署或版权判断。真实资料准备不阻塞合成数据开发验收。

## 2. 拆分与依赖

| ID | 独立交付项 | 前置 | 预计人日 |
| --- | --- | --- | --- |
| CM-00 | 冻结工作区与接口基线 | 无 | 0.5–1 |
| CM-01 | 前端请求与异步状态边界 | CM-00 | 0.5–1 |
| CM-02 | 管理入口、账户弹窗与桌面布局 | CM-01 | 1–1.5 |
| CM-03 | 品牌/系列/主题目录维护 | CM-02 | 1–1.5 |
| CM-04 | 色组编辑、排序、比例与保存 | CM-03、CM-05 | 1.5–2 |
| CM-05 | 可复用主库选择器 | CM-01 | 1–1.5 |
| CM-06 | 上传及导入预览页面 | CM-01 | 1–1.5 |
| CM-07 | 人工校准、部分确认与恢复 | CM-03、CM-05、CM-06 | 1.5–2 |
| CM-08 | 组合回归与交付核验 | CM-04、CM-07 | 1.5–2 |

推荐顺序：`00 → 01 → 02 → 03 → 05 → 04 → 06 → 07 → 08`。依赖图允许独立调查并行，本会话写操作仍由主代理串行执行。

每个任务执行节奏：读取当前实现与调用方 → CodeGraph impact → 先补对应回归 → 最小修改 → 目标验证 → 更新 TODO。只有通过本任务验收才打勾；“代码已写”不能代替验收。

## 3. 各任务实施与验收

### CM-00：冻结基线

**文件：** 当前分支全部未提交色彩文件、`package.json`、`pnpm-lock.yaml`、本目录四份文档。

1. 记录 HEAD、暂存/未暂存/新文件边界；保留既有 `compose.yaml`、LAN 测试和 `backups/`。
2. 对照架构文档检查 API、DTO、错误、分页、revision 和主库版本；有差异以源码为证据更新文档。
3. 核对锁文件的大幅文本 diff：区分格式变化与依赖语义变化，不根据行数推断升级，不回滚已有格式化。
4. 对前端草稿进行类型/静态检查，列出接线、草稿丢失、排序、分页版本、焦点和导入 UI 缺口。
5. 恢复开发后重跑最近后端修正的测试/check/build，建立当前工作区的真实基线；失败先修正直接问题，不能沿用旧通过记录。

**验收：** 基线和范围可复核；后端已验证与前端待验收明确分离；不重新开发已完成后端。

### CM-01：请求与异步边界

**修改：** `src/lib/colorManagementClient.ts`。**拟新增测试：** `tests/color-management-client.test.ts`。

1. 复用现有鉴权 fetch 行为，统一 JSON 错误、非 JSON 错误、204、网络失败、401/403/409。
2. 固化查询取消和路径/revision 隔离；A 请求晚于 B 返回不能覆盖 B。
3. 保存携带发起时的资源 ID 与 revision；组件卸载、账号切换后不把响应写入新编辑上下文。
4. 为上传/确认使用类型化 DTO，不从 DOM 拼接未校验的业务身份。

**验收：** 失败能定位 HTTP 状态；取消不是业务报错；旧响应被忽略；服务器 409 不触发自动覆盖重试。

### CM-02：入口与弹窗

**修改：** `src/components/panels/AccountMenu.tsx`、`ColorManagementPanel.tsx`。**拟新增测试：** `e2e/color-management.workbench.spec.ts`。

1. 新增仅管理员可见的“色彩管理”页签及入口，使用登录用户身份隔离组件。
2. 触及的账户弹窗、页签使用项目已有 `ui/dialog.tsx`、`ui/tabs.tsx`；保留消耗、用户和诊断功能，不重写不相关页面。
3. 色彩页使用已确认的较宽桌面工作区；左侧品牌/系列，右侧主题与编辑；内部滚动、底部保存操作可见。
4. 验证嵌套弹窗层级、Esc、键盘切换、焦点圈定、关闭后返回账户触发器及 reduced-motion。

**验收：** 1024/1280/1440 实测无横向溢出和遮挡；非管理员无入口且服务器仍拒绝写入；原账户功能无回归。

### CM-03：目录维护

**修改：** `ColorManagementPanel.tsx`、`ColorMetadataDialog.tsx`；复用 `brandColors.ts`、`brandColorStore.ts`。**测试：** CM-02 的 E2E 文件、必要时扩充 `tests/brand-color-management.test.ts`。

1. 验证品牌/系列/主题分页、选中态、空态、重试和刷新；新增/删除后不能停在无法恢复的空分页。
2. 完成品牌与系列新增、重命名、删除；年份/季节允许空；保存成功同步本地 revision。
3. 删除使用 AlertDialog；保护 NEIHE 根目录和非空父目录；409 保留可操作的错误与刷新路径。
4. 与 CM-04 约定未保存改动的导航/关闭确认，避免切品牌、切系列或刷新直接丢失编辑内容。

**验收：** 单独完成目录 CRUD；未标注年份不被补造；部分更新不清空其他字段；父子关系与跨品牌限制有效。

### CM-04：主题色组编辑

**修改：** `ColorGroupEditor.tsx`、必要的父组件导航协议。**测试：** E2E 及现有品牌后端测试。

1. 接入 CM-05 选择器；按 catalogId 去重，同 HEX 不同身份可共存；提交只包含 API 接受的引用字段。
2. 增删、调整顺序并持久化；优先提供键盘可操作的上移/下移，不把拖拽作为唯一操作。
3. 比例空值保持 null，数值范围 0–1；不归一化、不改变逐色生成；维持原始 HEX 的后端保留行为。
4. 编辑已有色组必须保留原 seriesId（包括 null）、releaseId 和完整成员；分页编辑不能只提交当前页。
5. 添加脏状态、放弃/继续编辑/保存路径；处理中阻止重复提交；409 不丢草稿。

**验收：** 9 色同 HEX 可保存并重载；超过一页时仍保留全部成员及顺序；新建、重命名、比例、移除与失败恢复均有证据。

**状态：已完成。** 完整成员/排序/比例、dirty 导航保护、409 与结果未知核对、重复提交锁已通过合成 E2E 和完整门禁；证据见 TODO 第 10 节。

### CM-05：主库选择器

**已实现：** `src/components/panels/ColorCatalogPicker.tsx`；从 `ColorGroupEditor.tsx` 提取直接需要的选择逻辑，并以 `libraryKey`、`releaseId` 固定参数保留 CM-07 复用边界。

1. 提供色库筛选、色号查询和分页，只允许 ready 条目确认；展示色库、色号、HEX。
2. 首次查询取得 releaseId 后，后续分页固定该 release；查询条件变化时明确重置快照和页码。
3. 处理空主库、无结果、活动 release 变化和历史引用；不得用当前 HEX 替换旧引用。
4. 普通编辑使用当前可用目录；导入校准必须能传入导入记录的 libraryKey + releaseId 限制。

**验收：** 翻页时主库切换不会混页；同 HEX 不同库/号均可识别；近似候选只能经显式选择建立映射。

**范围提醒：** 当前目录 q 搜索是色号搜索，不宣称已实现名称检索；完整用户侧名称/色相浏览仍随任务 #8 核对。

**状态：已完成。** 三档桌面 E2E 验证 release 固定、活动版本切换、筛选/搜索重置、同 HEX 不同身份、ready 防线、严格响应版本校验、请求重试与空主库；完整 `check`、`build` 通过。

### CM-06：上传与预览

**拟新增：** `src/components/panels/ColorImportPanel.tsx`。**复用：** `colorManagementClient.ts`、`src/types/brandColors.ts`、`colorImport.ts`、`colorImportStore.ts`。

1. 管理员选定目标色组和色库后上传 XLSX/ASE；前端先检查扩展名/大小，服务端验证仍是事实源；不接受图片或 ACB。
2. 编码并提交现有 base64 JSON 协议；显示处理中，防止重复上传；不在前端解析文件。
3. 展示逐行原始色号/HEX/比例及 matched、missing-code、unmatched、conflict、duplicate、invalid 状态；最多渲染一页，不截断后台保存的行。
4. 上传完成全部 decisions 保持 pending；此阶段不向正式色组添加颜色。

**验收：** 合成 HEX-only ASE、带空比例 XLSX 可预览；坏文件、超限和资源预算拒绝均可恢复；上传不等于发布。

**状态：已完成。** 上传/预览、六状态、25 行分页、5000 行有界渲染、私有记录分页及未知创建指纹核对均已验证。

### CM-07：人工校准与恢复

**拟新增：** `src/components/panels/ColorImportReview.tsx`；复用 CM-05/06，不增加另一套匹配算法。

1. 逐行维护 pending / skip / confirm；confirm 显式指定 catalogId 与 ratio（可为 null），保持原始行可复查。
2. 缺失色号显示近似候选且标明不精确；限定导入色库/版本；管理员可确认或继续待查，不能跨库静默替代。
3. PATCH 保存 decisions 后使用返回的 import revision；确认时同时发送 import revision 与 groupRevision。
4. 支持“先确认已核对行，余行待查”，显示 added 与已确认行；读取管理者自己的导入列表恢复操作。
5. 确认超时先重放相同请求或读取记录/回执状态，不重新上传，也不换 revision 盲目再提交。
6. 已发布行不可在原导入记录改写；主库更新导致旧预览不可继续确认时说明重新导入，不改变既有已发布成员。

**验收：** 两次部分确认不重复追加；未匹配行仍保留；相同确认请求可安全重放；另一管理员不能读取他人预览；正式色组对其他用户可见。

**状态：已完成。** 全量决定、版本固定候选、部分确认、409/未知结果恢复、历史 exact 身份补全及重复成员事务保护均已验证。

### CM-08：组合验收

**修改/新增测试：** `e2e/color-management.workbench.spec.ts`、`tests/color-management-client.test.ts`、现有品牌/导入测试；仅在必要时向 `package.json` 注册新增单测，不改测试隔离基础设施。

1. 串联目录→选色→顺序/比例→保存→导入→校准→部分确认→恢复；全部使用合成数据。
2. 三种桌面宽度验证几何、滚动、可访问名称、键盘、焦点恢复；验证账号/角色切换与并发编辑。
3. 检查账户旧页签与用户侧既有选色行为未被本批破坏；不趁机实现任务 #8/#9。
4. 完成下列门禁与完整 diff 复查，包括新文件；更新 TODO 和剩余风险。

**验收：** 所有本范围任务有证据，未解决问题不打勾；未运行的门禁明确记录。

**状态：已完成。** 两个专项 E2E 在三档桌面共 92 项通过，完整 check/build 通过；CodeGraph/diff 证据记录于 TODO。

## 4. 验证命令与授权边界

以下命令用于各执行批次；CM-05 已按此流程取得新鲜证据，后续任务仍须各自重跑：

```bash
# 先做目标 LSP/静态核查，再运行项目入口。
npm exec --yes --package=pnpm@11.19.0 -- npm run check
npm exec --yes --package=pnpm@11.19.0 -- npm run build

# 新增 E2E 文件后，用隔离 runner，配置自动覆盖三种桌面宽度。
npm exec --yes --package=pnpm@11.19.0 -- npm run test:e2e -- color-management.workbench.spec.ts

git diff --check
codegraph sync .
# affected 参数填入本批实际改动的全部源文件（含新文件），不把图覆盖当成完整证明。
```

`check` 当前包含 `lint`、`build:web`、隔离 PostgreSQL 全量测试；`lint` 当前实际是 `tsc --noEmit`，不是 ESLint。临时 pnpm 包装沿用本会话已验证的工作方式，不全局安装，也不改变锁文件来绕过环境。

不能直接启动测试 Compose，不能调用真实 AI。`gate:codex` 仍依赖 GitNexus，禁止运行并记录未迁移。每次正式批次交付依项目规则验证；一次只交付可验收的小批次，不以“整个大任务完成”作为唯一检查点。
