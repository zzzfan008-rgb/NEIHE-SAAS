# 色彩管理 TODO 与验收台账

相关：[开发计划](./development-plan.md) · [周期](./schedule.md) · [架构](./architecture.md)

**更新时间：** 2026-09-14。
**当前动作：** B1～B5、CM-00～08 已完成；主库品牌 API 与管理员管理任务完成，后续进入色板身份/收藏迁移。
**维护规则：** 本文维护任务状态，开发计划维护范围，架构维护接口，周期维护估算。任务只有验收通过才勾选；失败保留未完成并写明证据。每次只推进一个任务。

## 1. 后端基线与历史验证（不重复开发）

- [x] BL-01 ACB/ASE 解析、颜色转换、来源冲突与候选、受限 XLSX/ASE 预览。
- [x] BL-02 迁移 19、不可变主库版本、受控初始化、登录只读 API。
- [x] BL-03 迁移 20、品牌/系列/主题 CRUD、同 HEX 不同身份、有序引用与比例。
- [x] BL-04 私有导入、显式决定、部分确认、重复请求回执、旧主库保护。
- [x] BL-05 最后一次预览预算调整和系列 PATCH 修正后的完整测试/check/build 重新核验；并覆盖新增前端的构建。纳入 CM-00，不另计开发天数。

证据：既有解析/主库/品牌/导入测试仍保留。CM-00 在后端修正和新增请求层之后重新执行 focused、strict tsc、完整 check/build，全部 exit 0；CM-02 接线及 UI 验收见第 7 节。

## 2. 剩余任务总表

| ID | 状态 | 依赖 | 负责人 | 完成证据 |
| --- | --- | --- | --- | --- |
| CM-00 | 已完成 | 无 | 主代理 | 见第 6 节 B1 |
| CM-01 | 请求层基础已完成 | CM-00 | 主代理 | 见第 6 节 B1；真实组件接线属 CM-02 |
| CM-02 | 已完成 | CM-01 | 主代理 | 见第 7 节 CM-02 |
| CM-03 | 已完成 | CM-02 | 主代理 | 见第 8 节 CM-03 |
| CM-04 | 已完成 | CM-03、CM-05 | 主代理 | 见第 10 节 CM-04 |
| CM-05 | 已完成 | CM-01 | 主代理 | 见第 9 节 CM-05 |
| CM-06 | 已完成 | CM-01 | 主代理 | 见第 11 节 CM-06 |
| CM-07 | 已完成 | CM-03、CM-05、CM-06 | 主代理 | 见第 12 节 CM-07 |
| CM-08 | 已完成 | CM-04、CM-07 | 主代理 | 见第 13 节 CM-08 |

## 3. 执行清单

### CM-00 基线

- [x] 记录当前 HEAD、完整 diff、新文件、暂存边界，保护 compose/LAN/backups。
- [x] 复核锁文件文本变化对应的依赖语义，不回退格式化。
- [x] 确认实际 API/DTO 与架构文档一致。
- [x] 完成 BL-05：重验最近后端修正及当前源码的完整门禁。
- [x] 检查四个前端草稿并记录类型/接线缺口；不把存在文件视为完成。
- [x] 输出本批源文件范围与 CodeGraph 影响结果。

### CM-01 请求与状态

- [x] 非 JSON 错误、204、401/403/409、网络失败可解释。
- [x] 请求作用域模拟 A/B 乱序、取消、销毁及身份隔离有回归；真实 React 挂载/账号切换在 CM-02 验证。
- [x] 写请求绑定原资源与 revision；不自动覆盖重试。
- [x] 新增 client 测试接入现有测试入口。

### CM-02 管理入口

- [x] 绑定 AuthContext 账号/角色 scopeKey，切换和卸载销毁写作用域；用 requestError.status/code 接入已有认证处理。
- [x] 实际渲染验证 revision/scopeKey 切换、取消和卸载；取消写操作后重新查询服务器状态，不视为回滚。

- [x] AccountMenu 添加管理员专用色彩入口与页签。
- [x] 触及的 Dialog/Tabs 使用本地 shadcn，旧页签功能不删除。
- [x] 工作区内部滚动，保存操作在三档桌面可见。
- [x] 嵌套弹窗层级、键盘、焦点圈定/恢复、reduced-motion 通过。
- [x] 非管理员没有管理入口；原认证边界不变。

### CM-03 目录维护

- [x] 品牌/系列新增、重命名、删除联调。
- [x] 空年份/季节、非空父目录、NEIHE 保护与跨品牌限制验证。
- [x] 主题选择、新建入口、分页、末页删除、错误重试验证。
- [x] 保存后本地 revision 更新，删除和元数据 409 均有恢复入口。
- [x] 与编辑器的未保存导航保护边界固化到 CM-04；CM-03 不引入半套 dirty 状态。

### CM-04 主题编排

- [x] catalogId 去重；同 HEX 不同号可同时保存。
- [x] 上移/下移及键盘操作；跨分页排序与重载后顺序一致。
- [x] 比例 null、0、极小数、有效数、非法数有回归；不归一化。
- [x] 保留历史 release、原 seriesId（含 null）、全部分页成员。
- [x] dirty/保存/放弃/取消；切品牌/系列/色组、新建、刷新、关闭、换页签不无提示丢失。
- [x] 9 色和超过一页的色组保存正确；用户工具 8 色限制不改变。
- [x] 保存失败/409/结果未知后保留或显式核对；同步双提交不能重复写入。
### CM-05 主库选择

- [x] 色库筛选、色号搜索、分页、加载/失败/空态。
- [x] 后续页固定 releaseId；活动版本变化不混页。
- [x] ready 才可选择；显示 code + libraryKey + HEX。
- [x] 支持导入场景指定 libraryKey/releaseId；候选必须人工选。
- [x] 不把已有引用 releaseId 写成“未绑定”，补的是查询快照与 UI 呈现。

### CM-06 上传预览

- [x] XLSX/ASE 上传，拒绝图片/ACB；大小预检与编码。
- [x] 不在浏览器引入 ZIP/XML/Adobe 解析依赖。
- [x] 六类预览状态、原始 HEX/比例可见；5000 行仍仅分页渲染。
- [x] 所有初始决定 pending；上传没有发布副作用。
- [x] 非法文件、空文件、超限、未知写结果与历史分页可恢复。

### CM-07 人工校准

- [x] pending/skip/confirm 全量决定数组按原始行对齐。
- [x] exact/approximate 显示 code、libraryKey、HEX；确认带 catalogId 与显式 ratio/null。
- [x] 正确携带 import revision 与 groupRevision。
- [x] 私有导入列表与记录恢复可用，其他管理员访问为 404。
- [x] 部分确认后继续处理，保留未匹配行，已发布行不可改写。
- [x] 请求结果未知时只重放原确认请求，不重复追加。
- [x] 主库切换拒绝旧预览新增确认；已发布色组不变。
- [x] 与已存在组成员重复时保留预览并提示修正，不破坏组。
### CM-08 组合验收

- [x] `e2e/color-management.workbench.spec.ts` 与 `e2e/color-import.workbench.spec.ts` 被现有匹配规则执行。
- [x] 1024×768、1280×720、1440×900 实测布局/滚动/键盘/焦点。
- [x] 覆盖目录→选色→排序→比例→上传→校准→部分确认→恢复。
- [x] 原账户页签、既有选色与身份切换无回归。
- [x] focused tests、check、build、diff 检查有新鲜证据。
- [x] CodeGraph sync/affected 覆盖新增源文件，完整 diff 审查完成。
- [x] 全部测试用合成数据和隔离数据库；无真实 AI、无生产导入。
- [x] 记录 gate:codex 未迁移，不能勾为通过。
- [x] 更新完成证据及后续任务边界；提交/推送留到全部任务最终验收。

## 4. 不阻塞开发、但阻塞真实上线的事项

- [ ] EXT-01 主库受控来源映射、版本与分发权利确认。
- [ ] EXT-02 Chloé 色号人工确认及来源年份核实；不编造 Spring 年份。
- [ ] EXT-03 Ralph Lauren 的两个缺失码保留待查；已有八个匹配码可按已确认产品规则分批维护。
- [ ] EXT-04 NEIHE 真实配色资料待用户提供。
- [ ] EXT-05 生产导入/发布/部署另行授权与检查。

这些项目不计入开发完成百分比。允许基于合成资料完成软件验收，但不能因此声称真实品牌内容已上线。

## 5. 完成证据模板

每完成一项，将总表状态更新并补一条记录：

```text
任务 ID：CM-xx
实际改动文件：
基线 / HEAD / 工作区说明：
验证命令与退出码：
桌面尺寸与交互证据（UI 任务）：
CodeGraph 影响与补充源码核对：
未覆盖范围 / 阻塞：
是否满足本任务验收：
```

主库品牌 API 与管理员管理已完成；下一执行单位为原计划任务 3（色板身份与收藏迁移）。

## 6. B1 完成证据（2026-09-14）

- CM-00：ui-design / HEAD `14be0b4e7b28087cc9031ddb3e7c96de51f67060` 加工作区；最新后端预算和系列 PATCH 修正重验通过。锁文件以 js-yaml 深比较：原 602 项全部未变，仅新增 saxes、yauzl、@types/yauzl、xmlchars、pend，未升级现有依赖，保留已有格式。
- CM-01：修改 `src/lib/colorManagementClient.ts`，新增 `tests/color-management-client.test.ts`，只在 `package.json` 追加测试入口。HTTP status/code、非 JSON/204、未知写结果、取消/迟到响应、请求体快照、类型化导入方法已实现；query 额外保留 requestError，供下一批认证分流。
- RED：原实现首次测试失败 `undefined !== 401`；实现后 focused、strict tsc、完整 check/build 全部 exit 0。完整入口沿用计划中的临时 pnpm 11.19.0 包装。
- 独立只读审查未发现确认缺陷；补充响应体读取失败、4xx/5xx、取消写入和导入方法断言。未增加测试依赖。
- CodeGraph 影响仅指向管理草稿及新测试；未改 AccountMenu、Canvas、收藏或模型链路。scope 取消不是服务器回滚；真实 AuthContext 绑定、React 挂载行为和浏览器几何还需 CM-02/后续验收。
- 未运行 UI E2E、真实模型或 GitNexus 依赖 gate；未导入真实资料、提交、推送或部署。

## 7. CM-02 完成证据（2026-09-14）

- 实际改动：`AccountMenu.tsx` 接入管理员专用色彩页签，并将账户容器迁移到本地 shadcn `Dialog`/`Tabs`；新增 `ColorManagementSession.tsx`，按 `user.id + role + mustChangePassword` 隔离查询和写请求；管理草稿改用会话 query/request。`src/index.css` 为账户弹窗补充局部 reduced-motion 规则。
- E2E：`e2e/color-management.workbench.spec.ts` 在 1024×768、1280×720、1440×900 共 13 项通过、3 项显式跳过的人工窗口；覆盖非管理员隐藏、内部无横向溢出、保存按钮可见、Tabs 键盘切换、焦点圈定与嵌套/外层恢复、旧查询取消、角色变化卸载和在途写取消/重新查询。
- ego-browser：连接同一套隔离 PostgreSQL/HTTP runner，只读打开色彩管理；`/api/colors/catalog/state` 返回 200 和 `{ releaseId: null, revision: 0 }`；三档弹窗均在视口内且保存按钮可见，截图位于 `/tmp/cm02-color-management-{1024,1280,1440}.png`。runner exit 0，task space 已 `done:true` 清理。
- 门禁：focused RED 先证明旧静态 dialog 断言和 reduced-motion 行为不成立；修正后 `npm run check`、`npm run build` 均 exit 0（临时 pnpm 11.19.0 包装），六个 CM-02 文件主 LSP 0 错误，`git diff --check` 与 CodeGraph sync/affected 通过。
- 隔离修正：保留运行时生成且未跟踪的 `data/templates/builtin/builtin-tool-ai-styling.json`，不改写/删除；`workflow-schema.test.ts` 只校验 Git 跟踪的仓库模板，避免运行时数据污染“干净检出”门禁。
- 独立只读审查未发现可确认缺陷；原消耗、用户、AI 诊断和退出功能未删除。未执行真实 AI、真实 Pantone 导入、生产部署或 GitNexus 依赖的 `gate:codex`。该时点 CM-03～08 尚待实施；CM-03 后续证据见第 8 节。

## 8. CM-03 完成证据（2026-09-14）

- 实际改动：`ColorManagementPanel.tsx` 为通用品牌/系列/主题目录增加局部重试、path 重置和空末页逐页回退；删除 409 保留错误并提供“关闭并刷新”。`ColorMetadataDialog.tsx` 为元数据 revision 409 提供同等恢复入口。
- CRUD E2E 使用隔离 PostgreSQL 创建、重命名并删除独立命名的品牌、空年份/季节系列和空色组；验证 NEIHE 删除禁用、品牌/系列非空 409、色组选择/删除、年份/季节保存、保存后的 revision 刷新。既有后端测试继续覆盖跨品牌和事务约束。
- TDD RED：旧界面找不到“重试品牌”；删除唯一末页项后仍停在“暂无品牌”；元数据 409 找不到“关闭并刷新”。实现后 CM-03 四个场景在三档桌面共 13 项（含 setup）通过。
- 完整 `e2e/color-management.workbench.spec.ts` 在 1024×768、1280×720、1440×900 共 25 项通过、3 项显式跳过的人工窗口；`npm run check` 与 `npm run build` 均 exit 0（临时 pnpm 11.19.0 包装）。
- 独立只读审查提出 AlertDialogAction 可能自动关闭；源码核对 `src/components/ui/alert-dialog.tsx` 后确认它只是本地 `Button`，且真实品牌/系列 409 三档 E2E 均通过，因此未作无证据修正。其余未发现确认缺陷。
- CodeGraph sync 处理 3 个变更文件；affected 仅列 `e2e/color-management.workbench.spec.ts`，补充源码核对 `ColorManagementPanel → AccountPanel → AccountMenu`。`git diff --check` 通过。
- 未保存编辑导航保护仍按既定依赖在 CM-04 一次实现；CM-03 未引入半套 dirty 状态。未运行新的 ego-browser 人工窗口、真实 AI、真实 Pantone 导入、生产部署或 `gate:codex`。

## 9. CM-05 完成证据（2026-09-14）

- 实际改动：新增 `ColorCatalogPicker.tsx`，以活动主库 state 建立快照，后续分页固定 releaseId；色库/色号条件变化重新取得快照并回到首屏。`ColorGroupEditor.tsx` 改为按 catalogId 选择，保留同 HEX 不同身份及历史成员 release。`colorManagement.ts` 与 `colorCatalogStore.ts` 固化色库列表 DTO；本地 shadcn `SelectContent` 新增可选 positioner 层级，解决账户 Dialog 内下拉菜单被遮挡。
- TDD RED：旧编辑器翻页请求没有 releaseId，且主库失败没有“重试主库”；畸形 `releaseId: null` 响应未被拒绝。实现后新增 E2E 验证活动版本从 A 切到 B 后翻页仍固定 A，筛选/搜索重新绑定 B、同 HEX 两身份、conflict 禁选、state/catalog 错误重试、严格响应版本检查与空主库。
- 独立只读审查确认两个 P2：固定 release 的 mismatch 重试只刷新 snapshot、truthy 比较放过空 release。现已改为 data/snapshot 分离 revision、固定模式重拉 data，并对存在的 catalog/libraries 响应严格比较 release；对应畸形响应测试先红后绿。
- 三档 E2E：`e2e/color-management.workbench.spec.ts` 在 1024×768、1280×720、1440×900 共 34 项通过、3 项显式跳过的人工窗口；覆盖筛选下拉层级、色号搜索 Enter、分页、活动版本提示、ready 防线和错误恢复。
- 门禁：`npm run check`、`npm run build` 均通过（临时 pnpm 11.19.0 包装）；目标 lens 主 LSP 0 error。CodeGraph sync 处理 6 个文件，affected 指向 color-management E2E、authorization、brand-color-management、color-catalog-store、flow-history、workflow-schema，完整 check 与 E2E 已覆盖。
- CM-05 固定 `libraryKey + releaseId` props 已实现并静态检查；真实导入校准消费者仍属 CM-07，不能把当前证据表述为导入闭环完成。未导入真实资料、运行真实 AI、新 ego-browser 窗口、生产部署或 GitNexus 依赖的 `gate:codex`；未提交或推送。

## 10. CM-04 完成证据（2026-09-14）

- 实际改动：`ColorGroupEditor.tsx` 增加完整有序成员分页编辑、键盘可操作的上移/下移、严格 0–1 十进制/科学计数比例解析、catalogId 去重、dirty 基线、同步提交锁、409 草稿重载和未知写结果核对；`ColorManagementPanel.tsx` 与 `AccountMenu.tsx` 接通内部导航、页签及关闭确认，确认放弃时同步重置真实编辑器。
- E2E 使用合法 64 位 catalog digest 和生产关键写契约校验；覆盖 30 色完整数组、24/25 跨页排序、首尾禁用、保存后重载、移除再加入、9 个同 HEX 不同身份、null/0/0.5/1e-7/非法比例、品牌/系列/新建/刷新/页签/关闭保护、元数据与删除取消、409、同步双提交和新建/已有色组的结果未知核对。
- TDD / 审查：旧实现的 CM-04 三个核心场景先出现 3 个预期失败；新增元数据取消回归再次复现父子 dirty 失同步，未知写结果回归复现只显示服务错误。实现后均转绿。首次独立审查确认 2 个 P1、1 个 P2、1 个 P3；修复后复核仅发现旧 CM-05 catalog mock 使用非法 ID，统一改为合法 digest。
- 三档桌面 E2E：`e2e/color-management.workbench.spec.ts` 在 1024×768、1280×720、1440×900 共 52 项通过，3 项显式跳过的可选人工窗口；色组工作区无横向溢出，按钮、分页和确认弹窗保持可操作。
- 门禁：`npm run check` 与 `npm run build` 均通过（临时 pnpm 11.19.0 包装）；四个目标文件主 LSP 0 error，`npm run lint` exit 0。完整 check 包含隔离 PostgreSQL 的 `brand-color-management.test.ts`，继续覆盖真实 catalog 引用、九色同 HEX、revision 与导入事务。
- 最终 CodeGraph sync 处理 3 个最新变更文件（此前同批次同步 5 个）；affected 对 4 个 CM-04 源/E2E 文件遍历 4 个依赖并选出 `e2e/color-management.workbench.spec.ts`，完整三档 E2E 已覆盖；`git diff --check` 通过。
- 未改变普通用户 8 色上限、画布工作流、收藏或执行路径；未运行真实 AI、真实 Pantone 导入、生产部署或仍依赖 GitNexus 的 `gate:codex`，未提交或推送。下一项是 CM-06 上传/预览，CM-07 校准及任务 #8/#9 仍未实现。

## 11. CM-06 完成证据（2026-09-14）

- 新增 `ColorImportPanel.tsx` 与 `e2e/color-import.workbench.spec.ts`，接入服务端 XLSX/ASE 私有预览；浏览器只做扩展名、空文件、10 MiB 和 base64 边界，解析依赖仍只在服务端。
- 六种状态、原始 HEX、比例、25 行分页、5000 行有界渲染、私有历史分页与空末页回退均覆盖；未知创建保留 SHA-256+groupId+libraryKey 指纹，匹配记录核对前不得重传。
- 独立审查确认的预览高度、未知写提前解锁、历史只读首 25 条缺陷均先补回归后修复。

## 12. CM-07 完成证据（2026-09-14）

- 新增 `ColorImportReview.tsx`：全量对齐 pending/skip/confirm，exact/approximate 展示 code/libraryKey/HEX，严格 ratio/null，release 固定主库选择，部分确认、409 重载和未知确认原请求重放。
- 修复同 ID 新 revision 不同步、busy 确认可被外层关闭、旧记录误解锁；历史 exact 行缺少 `matchedColor` 时由 `readManagedImport` 按原 release 补齐显示身份。重复组成员确认返回 400 且事务不变。
- 独立复核确认前三项已修复；其历史 exact P2 随后增加服务端补全与 PostgreSQL 回归。

## 13. CM-08 完成证据（2026-09-14）

- `e2e/color-import.workbench.spec.ts` 三档桌面共 40 项通过；`e2e/color-management.workbench.spec.ts` 三档桌面共 52 项通过、3 个仅供 ego 窗口的测试跳过。
- 最新完整 `npm run check`（含隔离 PostgreSQL）与 `npm run build` 均通过；上传上限、429、历史 exact 补全、重复成员事务保护均在后端回归中通过。
- 使用合成数据，无真实模型、真实 Pantone 数据或生产部署；`gate:codex` 尚依赖 GitNexus，按项目规则未运行。任务 #8 色板身份/收藏与任务 #9 面料分析仍是后续范围。
