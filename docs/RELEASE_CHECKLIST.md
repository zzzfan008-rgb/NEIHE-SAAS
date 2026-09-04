# Garment Canvas 发布候选清单

只有本清单完成、发布候选精确 SHA 的本地 Codex 门禁通过，且 PR 经用户明确确认合并，项目才进入可发布状态。GitHub Actions 不再作为门禁；打 tag、部署和生产数据操作仍需单独授权。

## 1. 精确版本与范围

- [x] 当前门禁候选分支 `codex/codex-local-gate` 以 `origin/main@d942885c57fcf97c5f18821ee94c7f3f720e6cac` 为精确 base，工作树仅包含本批门禁与证据改动。
- [x] 当前候选固定提交后，已复核 PR #22 head `246a258bdad108c0c49853fb5804e811768c468a`、base `d942885c57fcf97c5f18821ee94c7f3f720e6cac`、分支 `codex/codex-local-gate` 和提交范围。
- [x] `.env`、密钥、数据库 dump、上传文件、`data/`、`dist/`、`dist-server/` 均未进入候选差异。
- [x] PR #22 摘要明确列出功能范围、不做的范围、已知风险和回滚方案。

## 2. 本地门禁

```bash
pnpm install --frozen-lockfile
pnpm audit
pnpm run check
pnpm run test:e2e
pnpm run build
pnpm run test:e2e:production
git diff --check
pnpm run gate:codex -- --base origin/main
```

- [x] 所有测试使用隔离 PostgreSQL、临时 `DATA_DIR` 与 dummy/stub AI。
- [x] 包体预算通过：最新 `main@bb89795` 初始静态 JS gzip 148617 / 210000 bytes，11 个 JS chunk，最大 chunk 194.27 kB。
- [x] production smoke 3/3，真实加载哈希 JS/CSS 和动态 chunk，无 script 4xx/5xx。

## 3. 架构与审查

- [x] GitNexus 索引与当前已提交候选及 `d942885c57fcf97c5f18821ee94c7f3f720e6cac` 对齐，并使用 PDG 构建；最终候选 head 由门禁启动时的 `git rev-parse HEAD` 精确锁定。
- [x] `detect_changes` 已记录：Phase G 候选为 low；后续 PR #19 累计变更为 high（66 个变更符号、11 条受影响流程），CanvasFlow 与初始草稿同步提示的定向影响均为 low，并由完整回归覆盖。
- [x] 本机 Ollama `gemma4:e4b` 对 PR #19 精确 `c23f4174865dda827f969219e035f55c3038a2e8...c8d99866d06468868920b684e90da6e367e66995` 分三组复审，全部 `APPROVED`，无有效 P0–P3 阻断项。
- [x] 不触发或等待 Codex Cloud；本机模型复审绑定精确 PR head SHA。
- [x] 当前候选使用 Codex 配置的默认模型完成 `pnpm run gate:codex`，无 P0-P3 有效问题；未硬编码模型 ID。

## 4. 桌面与恢复验收

- [x] `current / white / eye` × 1024 / 1280 / 1440 共 9 组视觉证据已保存。
- [x] 项目、节点、成功、失败、结果未知和失败原因清晰可辨。
- [x] Results 的跨项目恢复、查看、对比、下载和继续处理无降级。
- [x] Tab、Escape、焦点恢复、Dialog/菜单焦点边界、React Flow 快捷键隔离和 1024 Dock 互斥通过。
- [x] 首次安装、管理员登录/改密、项目保存/恢复、活动任务恢复和失败处理已由隔离测试与恢复场景覆盖。
- [x] PostgreSQL + `DATA_DIR` 同一恢复点的备份/恢复流程已在隔离环境验证。

本地门禁记录（2026-08-30）：Phase G 的 `pnpm install --frozen-lockfile`、`pnpm audit`（0 漏洞）、`pnpm run check`、桌面 E2E 26/26、`pnpm run build`、production smoke 3/3 与 `git diff --check` 通过；恢复演练的一次性容器与临时目录均已清理。随后 PR #19 的完整 `pnpm run check`、桌面 E2E 29/29、生产构建与 `git diff --check` 再次通过；合并后 `main@bb89795` CI 复跑 29/29 桌面回归和 production smoke 3/3，全部成功。

本地门禁记录（2026-09-01）：PR #22 精确 head `246a258bdad108c0c49853fb5804e811768c468a` 相对 base `d942885c57fcf97c5f18821ee94c7f3f720e6cac` 的完整门禁通过：Node.js 22.20.0、`pnpm install --frozen-lockfile`、`pnpm audit`（0 漏洞）、`pnpm run check`、桌面 E2E 30/30、production smoke 3/3、精确 `git diff --check`、GitNexus（8 个索引文件、64 个变更符号、0 条受影响流程、low risk）和 Codex 默认模型结构化复审均通过。合并后 `main@4701280af93cea8a62df6c2799ba5f1b425829ce` 再次完成同一确定性套件；第一次模型结果在人工中断边界返回 `pass`，随后 `--review-only` 补跑以退出码 0 返回 `pass`，无 P0-P3 findings。

本机 `gemma4:e4b` 先对暂存候选完成预提交复审，再对精确 `3dc6a1dc8b54b4ee2596f5f484471328380edafc...fbdff19193bff4dbdbc8b33dc416bcea1aa451d4` 完成最终复审并返回 `APPROVE`；[精确 SHA 复审记录](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/17#issuecomment-5464184334)无有效 P0–P3。

PR #19 另由本机 `gemma4:e4b` 对精确 `c23f4174865dda827f969219e035f55c3038a2e8...c8d99866d06468868920b684e90da6e367e66995` 按状态/异步边界、UI/交互、测试/规则三组复审，全部 `APPROVED`；CodeRabbit 对同一 head 返回成功且无可执行阻塞意见。

## 5. PR、合并与发布

- [x] 当前门禁候选 PR 附测试矩阵、GitNexus、精确 SHA 复审、风险和回滚说明。
- [x] PR #22 精确 head 的本地 Codex 门禁通过；默认模型无 findings，CodeRabbit 状态成功，无待处置审查问题。
- [x] 用户明确授权后才合并；“通过”只授权当前约定的推送与复审，不代替最终合并授权。
- [x] PR #22 已记录 `MERGED` 状态与 main merge SHA `4701280af93cea8a62df6c2799ba5f1b425829ce`，并对该精确提交完成合并后确定性门禁与退出码 0 的默认模型复审补跑。
- [x] 用户另行授权的 `v0.1.0` annotated tag 与 GitHub Release 已发布，tag 解引用后精确指向 `a6282818bf0f29f8217c473e6f1a55a13b58b276`。
- [ ] 生产部署、生产数据库恢复或密钥轮换均取得各自的单独授权。

Phase G 发布候选记录：PR [#17](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/17) 的 base 为 `3dc6a1dc8b54b4ee2596f5f484471328380edafc`，head 为 `fbdff19193bff4dbdbc8b33dc416bcea1aa451d4`；[PR head CI 33268687680](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/33268687680)通过。用户明确授权后，PR 合并为 `c23f4174865dda827f969219e035f55c3038a2e8`，[main CI 33269171028](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/33269171028)再次成功。CodeRabbit 因免费额度限制未产出代码审查，不计作复审证据；有效复审证据为本机 Gemma、GitNexus 与 CI。

最新产品基线记录：PR [#19](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/19) 的 base 为 `c23f4174865dda827f969219e035f55c3038a2e8`，head 为 `c8d99866d06468868920b684e90da6e367e66995`；[PR head CI 33312678619](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/33312678619)和 CodeRabbit 均通过。用户明确授权后，PR 合并为 `bb89795b632af04e48c3246af6ada33245c7fdd4`，[main CI 33313563543](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/33313563543)再次成功。PR #18 仅回填该版本证据，不新增产品行为。

发布收口记录：PR [#18](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/18) 随后合并为 `a6282818bf0f29f8217c473e6f1a55a13b58b276`，[main CI 33315734726](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/actions/runs/33315734726)成功。用户另行授权后，[`v0.1.0` GitHub Release](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/releases/tag/v0.1.0) 于 2026-08-30 发布；annotated tag 解引用后精确指向该 main 提交。生产部署和生产数据操作尚未执行。

门禁替换收口记录：PR [#22](https://github.com/zzzfan008-rgb/kittin-saas-b-v2/pull/22) 的 base 为 `d942885c57fcf97c5f18821ee94c7f3f720e6cac`，head 为 `246a258bdad108c0c49853fb5804e811768c468a`；PR 测试矩阵记录 30/30 桌面 E2E、3/3 production smoke、0 漏洞、GitNexus low risk / 0 affected processes 和默认 Codex 模型 `pass`。CodeRabbit 状态成功。用户明确授权后，PR 于 2026-09-01 squash-merge 为 `4701280af93cea8a62df6c2799ba5f1b425829ce`；合并后对该精确提交再次完成本地确定性门禁与退出码 0 的默认模型复审补跑。GitHub Actions 不再作为当前门禁，未触发或等待 Codex Cloud。

## 6. 回滚信息

最新产品基线已经填写：

- 上一稳定 main SHA：`c23f4174865dda827f969219e035f55c3038a2e8`；候选 head SHA：`c8d99866d06468868920b684e90da6e367e66995`；合并后 main SHA：`bb89795b632af04e48c3246af6ada33245c7fdd4`。
- 代码回滚：将部署检出回上一稳定 main SHA 后重新执行 `docker compose up -d --build --wait`；预计停机时间为部署机器的一次构建与重启窗口，正式数值须在选定生产环境演练后记录。
- 本候选包含桌面工作台 UI、快捷键与节点批量插入行为，但不包含认证/权限、数据库迁移、AI Provider/计费或蒙版算法改动；代码回滚不需要数据库回滚。
- 隔离 PostgreSQL 18 dump/restore 与临时 `DATA_DIR` tar/restore 已通过并清理。真实生产备份位置、SHA-256 校验和与异地副本必须在正式部署前填写，当前未执行生产数据操作。
- 回滚后必须验证 `/api/ready`、登录、项目、Results、文件下载和活动任务；这些生产现场检查将在选定部署目标后记录。

PR #22 只改变门禁脚本、测试、规则与文档，不改变产品行为、认证、数据库结构或 AI Provider 调用。若需撤回门禁替换，以 `d942885c57fcf97c5f18821ee94c7f3f720e6cac` 为上一稳定代码基线，反向提交 PR #22，并在新的门禁方案通过前恢复原 GitHub Actions 工作流；无需数据库回滚。
