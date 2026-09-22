# 侧栏对话修改技术设计

状态：P0 已确认，作为 C01–C41 / A01–A65 的实现约束。

依据：

- [侧栏对话修改 PRD](../侧栏对话修改PRD.md)
- [开发计划](./2026-09-21-chat-edit-development-plan.md)
- [图片对话归属 ADR](../adr/0002-image-conversation-ownership.md)
- [项目规则](../../AGENTS.md)

## 1. 设计边界

本功能是已有画布的图片修改入口，不是通用聊天系统。对话历史、轮次、结果意图和生成尝试属于独立的图片对话领域；`ProjectTab[]` 仍是画布文档唯一来源，`DocumentSnapshot` 不增加对话历史、运行状态、面板开关或本页草稿。

复用现有：

- `files`、`assets`、`generation_runs`、`generation_run_steps`、`generation_jobs`、`generation_outputs`、`usage_events`；
- 图片归一化、引用权限、蒙版处理、持久队列、SSE、Results 和 ImageViewer/Compare；
- `image-input` 节点承载用户明确执行“加入画布”的结果。

不新增：历史会话列表、分支树、第二套文件/计费/生成队列、视频编辑、语音输入、移动端布局、历史删除或清空接口。

## 2. P0 决策

### D01：图片对话身份

对话身份由 `ownerId + projectId + sourceRef` 的项目范围来源关系确定；`sourceRef` 必须是服务端认可的规范化本地图片引用或已登记生成输出引用，不能使用 `nodeId`、文件名、图片内容 hash 或客户端任意 URL。

规则：

1. 同一项目复制图片节点时，复制后的节点保留同一个 `sourceRef`，解析到同一对话。
2. 节点重新上传或替换图片后，`sourceRef` 改变，解析到新对话；原对话不改写。
3. 跨项目复制只把图片引用带入目标项目；由于 `projectId` 改变，目标项目创建独立对话。
4. 多图融合的第 1 张底图决定对话归属；其余图片只作为本轮有序参考，不改变归属。
5. 生成结果通过 `generationOutputId` 与对话建立来源关系。结果加入画布后仍使用该来源关系；不自动创建新对话。
6. 本地上传或素材库的“开始新修改”显式创建新对话；“添加参考图”只加入当前轮输入，不改变当前对话。
7. 规范化前的 data URL 不能作为身份。上传先走既有 `/api/files`，获得本地引用后再创建对话或加入输入。

数据库使用以下增量实体（具体 SQL 名称和字段约束以迁移实现为准）：

| 实体 | 作用 |
| --- | --- |
| `image_conversations` | 项目范围的对话身份、起始来源、创建时间；不提供删除接口 |
| `image_conversation_sources` | 将项目内图片来源引用绑定到对话，支持同项目复制和跨项目隔离 |
| `image_conversation_rounds` | 原始指令、模式、底图、输入快照、参数快照、有效要求快照和轮次状态 |
| `image_conversation_intents` | 每个结果意图的稳定顺序、意图描述、独立增量要求和状态 |
| `image_conversation_attempts` | 每个意图的生成尝试、既有 `generationRunId`、幂等号和重试关系 |
| `image_conversation_outputs` | 将具体 `generationOutputId` 与对话、轮次、意图关联 |

对话读取始终同时校验 `ownerId` 和 `projectId`；不存在或不属于当前用户时返回非披露式 404。来源绑定、轮次、意图和既有生成任务在同一 PostgreSQL 事务内建立。

### D02：状态和活动锁

轮次状态：`draft`（仅前端）、`clarification_required`、`queued`、`running`、`partial`、`succeeded`、`failed`、`outcome_unknown`。

意图/尝试状态沿用现有持久队列的终态语义：`queued`、`running`、`retry_wait`、`succeeded`、`failed`、`outcome_unknown`。一个轮次只要存在未终结的意图、尝试或结果待核对，就保持活动锁；`outcome_unknown` 不能直接手动重试或解除锁。

服务端提交事务按以下顺序执行：

1. 锁定并确认用户仍有效；
2. 锁定项目并确认当前用户可访问；
3. 锁定并验证图片、资产和蒙版引用；
4. 对 `ownerId + projectId + conversationId` 获取事务级对话锁；
5. 校验 `clientRequestId` 与请求指纹，拒绝同一幂等号的语义冲突；
6. 写入轮次/意图/尝试并调用既有队列入队；
7. 同一事务提交后才向客户端返回已受理。

相同请求号重放返回原轮次/任务；不同内容复用旧请求号返回 409。手动失败重试使用新的 attempt 请求号，关联原 intent，不覆盖原失败记录或成功输出。

### D03：有效要求与来源链

每个已提交轮次保存不可变的 `inputManifest`、`sourceResultId`、`effectiveRequirements` 和 `incrementalRequirements`。选择旧结果继续修改时，只沿该结果的来源链读取快照，不读取之后轮次或其他分支。

有效要求合并由纯逻辑模块完成：

- 未冲突的保持要求继续继承；
- 最新明确要求替换对应的冲突要求；
- 已执行的相对动作写入来源链标记，不因拼接历史文本而重复执行；
- 无法判断覆盖关系时返回澄清，不提交图片任务。

图片结果不是隐式历史记忆；每轮实际发送的文字、图片顺序、蒙版和参数都必须持久化。

### D07：结构化多意图规划

规划器使用可注入的文本模型适配器，生产调用经现有 API 易网关；自动化测试全部使用确定性 mock，不携带真实密钥、不调用付费模型。

规划输入包含：模式、原始指令、当前底图、来源链有效要求、参考图清单和用户选定参数。规划输出为严格 JSON：

```ts
type ImageConversationPlan =
  | {
      kind: "ready";
      outputCount: number; // 1–8，任意整数
      intents: Array<{
        ordinal: number;
        label: string;
        instruction: string;
        requirements: Record<string, unknown>;
      }>;
    }
  | {
      kind: "clarification";
      question: string;
      reason: "count_mismatch" | "ambiguous_requirement";
      requestedCount?: number;
      specifiedIntentCount?: number;
    }
  | {
      kind: "rejected";
      code: "count_exceeded" | "invalid_plan";
      message: string;
    };
```

约束：

- 未表达多方案时默认 1；列出 N 个独立效果且未写数量时生成 N 个意图；
- 明确数量和意图数量不一致时先澄清，不补足、不截断、不自动分批；
- 用户明确授权“其他由你安排”后，规划器只能在授权范围内补足；
- 一项图片的多个修改要求仍是一个意图，不按短语数量拆分；
- `outputCount` 必须是 1–8 的整数；服务端再次校验，不能信任模型输出；
- 规划器超时、结构化响应无效或注入内容绕过校验时不创建生成任务。

规划器请求最多一次，超时和成本上限由配置控制；解析失败不能自动重复付费请求。图片生成只有在规划状态为 `ready` 后才创建。

### D06：与画布共存的前端状态

`imageConversationStore` 只保存当前页面的对话选择、三种模式草稿、输入图片、蒙版编辑状态和请求游标，键为 `projectId + conversationId + mode`。它不接入 `flowStore` 的文档历史，不进入 session 文档快照，不改变撤销/重做。

所有网络回写携带发起时的 `DocumentTarget`；如果 `tabId`、`projectId` 或 `documentEpoch` 任一不匹配，则只保留服务端对话结果，不写入当前画布或当前草稿。

### 结果未知恢复

`outcome_unknown` 只允许“核对状态”操作。核对读取既有 durable run 状态和事件，不重发上游调用；只有服务端确认明确失败后，用户才可选择失败意图手动重试。刷新、关闭侧栏、切换项目和 SSE 重连都不得自动生成。

## 3. API 契约

第一版不提供会话列表；以下接口只按当前项目/来源定位或操作已知对话：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/image-conversations/resolve?projectId=&sourceRef=` | 解析项目图片来源的当前对话；无记录返回 404 |
| `POST` | `/api/image-conversations` | 创建“开始新修改”对话并登记来源 |
| `GET` | `/api/image-conversations/:id` | 读取历史、轮次、意图、输出和状态 |
| `POST` | `/api/image-conversations/:id/rounds` | 原子校验、规划、创建轮次并入队；返回 202、澄清或校验错误 |
| `GET` | `/api/image-conversations/:id/rounds/:roundId` | 查询轮次和意图终态，用于响应丢失恢复 |
| `POST` | `/api/image-conversations/:id/rounds/:roundId/reconcile` | 核对结果未知，不触发上游请求 |
| `POST` | `/api/image-conversations/:id/intents/:intentId/retry` | 只重试明确失败意图，创建新的 attempt |

生成任务仍通过既有 `/api/run-plan/:id/events` SSE 订阅；对话 API 返回 `runId`、轮次和意图映射，前端按 `intentId` 而不是完成顺序归并结果。

## 4. 安全与数据边界

- 所有新路由挂在 `requireAuth` 和 `requirePasswordChanged` 后；管理员只能按现有规则查看，不绕过所有者写入。
- 图片引用必须经 `isLocalImageReference`、文件所有权/项目引用和蒙版底图校验；拒绝任意 URL、路径遍历和跨项目猜测。
- 对话历史、输出和任务查询使用 owner/project 双重过滤，资源不存在时返回 404。
- 轮次输入快照只记录已校验的本地引用，不记录 API key 或完整上游敏感响应。
- 迁移增量、可重复执行；项目回收和引用保护沿用现有事务与保留窗口。

## 5. 实施与验证顺序

1. P0：本设计和 `chat-edit-ui-spec.md`。
2. P1：共享类型、数量/模式/参数/来源链纯校验和单元测试。
3. P2：迁移、存储、授权 API 和 PostgreSQL 测试。
4. P3：结构化规划器、澄清和要求继承。
5. P4：意图级队列、SSE 映射、未知结果和失败项重试。
6. P5/P6：右侧侧栏、三模式草稿、四类图片来源和蒙版。
7. P7/P8：恢复、结果操作、三档桌面 E2E、全量回归和交付证据。

每批先运行 CodeGraph impact（修改既有符号时）、失败测试，再运行聚焦测试；交付前执行 `codegraph sync .`、`codegraph affected`、`npm run lint`、`npm run test`、`npm run check`、`npm run build`、指定 E2E 和 `git diff --check`。不运行仍依赖 GitNexus 的 `gate:codex`。
