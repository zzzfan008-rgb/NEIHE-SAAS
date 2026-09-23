# 多图换装重试恢复与真实诊断

## 已修复的本地问题

重新打开项目后，文档节点的运行状态归一化为 idle，原重试入口只接受 error，导致历史中有明确失败却不能使用简化重试。
现在 UI 和 runNode 共用 selectCanRetryMultiImage：依据当前项目、当前节点的最新失败恢复入口；只读、其他项目/节点、成功、运行中及结果未知不恢复 idle 节点的重试资格。运行参数仍不进入文档。

变更范围仅四个文件：flowStore、VirtualTryOnNode、多图单元测试、多图桌面 E2E。工作区其他未提交功能未进入隔离构建。

## 验证

- 红灯：1024、1280、1440 均在恢复失败历史后找不到重试按钮。
- 绿灯：相同用例三个宽度通过，验证按钮几何、单次请求参数和普通生成不继承 concise。
- 隔离工作树 npm run check、npm run build、git diff --check 通过；包括 35 项 provider contract、多图 4/5/6/7/20 张模拟请求与权限测试。
- CodeGraph sync / affected 完成。gate:codex 未执行，因仍调用项目禁止使用的 GitNexus。
- Docker 隔离镜像 garment-canvas-app:retry-recovery-20260922，image sha256:fc74033132216f50194324cefc23e7b6eae75dd39bde75786347b61d2b522893；localhost:3002 与局域网入口使用同一健康容器。基于 4522334 加本次未提交补丁。
- Ego TaskSpace 25 刷新后真实重试按钮可见且可提交。最后停在诊断副本的失败记录并交还控制。

## 真实请求结果（Asia/Shanghai）

| 本地 runId | 开始时间 | 输入 | 结果 |
| --- | --- | --- | --- |
| WVz1NIvSDf | 10:28:52 | 原 7 图打包为 6 图，concise | OTHER，零候选 |
| RCys9jxfWH | 10:29:10 | 同上 | OTHER，零候选 |
| Ew04B3DyM3 | 10:30:26 | 姿势、人物、场景、主穿搭 4 张，concise；保留拍摄参数 | OTHER，零候选；10.2 秒 |

前两条原计划只调用一次；Ego 自动滚动与画布缩放冲突，首次点击在终端操作结束后延迟生效，造成额外一次请求。每条 provider_requests=1，不是应用自动重试。已停止后续付费尝试。

四图诊断项目为 -4WRfJ6HNY，名称“诊断副本 · 四张必要参考图”；保存模板 PunCc4d3wO 未修改，原项目未移除参考输入。

## 结论边界

简化文字没有解除拒绝；四图无拼接也失败，所以超过六张或鞋袜拼图不是失败的必要条件。OTHER 未提供具体原因，不能认定安全违规、某张图片违规，也不能宣称生成故障已修复。当前日志未保留上游 responseId 或更详细 promptFeedback，仍需服务方按时间核查原因或用户批准进一步对照实验。

## 关闭第一阶段评审的对照测试

新增仅本次运行可用的 candidateReviewMode=disabled。路由只接受单节点、多图第一阶段、禁止下游联动；参数随运行记录保存，不写入项目。执行器仍先调用 Gemini 生成图片，只有拿到候选图后才根据该参数决定是否调用候选质量与独立姿势评审。

- 本地模拟验证 candidateSelector 调用次数为 0，executionMeta.tryOn.candidateReviewDisabled=true。
- 完整 npm run check、npm run build、git diff --check 通过。
- 真实运行 rsPODty76I：四张必要参考图、concise、candidateReviewMode=disabled；11.4 秒，provider_requests=1，successful_count=0。
- 上游仍返回 307 字节 JSON，candidateCount=0、candidatesTokenCount=0、promptFeedback.blockReason=OTHER。评审发生在候选图返回后，本次没有进入评审代码。
- 将该运行实际发送的 610 字提示词单独提交 API易 /v1/moderations，模型 omni-moderation-latest 返回 HTTP 200、flagged=false、flaggedCategories=[]。

结论：独立文本审核没有判定该提示词违规；当前 OTHER 来自 generateContent 的多模态生成审核路径或其上游未公开规则。现有证据不能再把故障归因于本地候选评审或 API易独立文本审核。
