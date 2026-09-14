# 业务异步运行时契约

最后核对：2026-08-20

## 边界

API易图片端点是同步接口：一次 HTTP 请求持续到生成完成，且没有上游任务 ID、查询接口或取消接口。本项目对前端提供异步任务体验，但 Worker 内部仍执行一次同步上游调用。

推荐链路：

1. API 校验工作流、节点参数、鉴权和素材归属。
2. 在同一数据库事务中创建 run、step 和待执行 job，立即返回 run_id。
3. Worker 使用 PostgreSQL 行锁和有序部分索引领取 job，将状态置为 running 并记录 lease。
4. Worker 同步调用 API易，解析结果并立即转存图片。
5. 在事务中写入输出素材、step 结果、事件和终态。
6. 前端使用已有 SSE 事件流获取进度；断线后按事件序号续传。

## 状态机

- queued：已入库，等待 Worker。
- running：Worker 已领取，尚未得到确定结果。
- retry_wait：明确命中可重试状态；available_at 记录最早可重试时刻，在该时刻之前对所有 Worker 不可见。
- succeeded：结果已转存并落库。
- failed：确定失败且不可重试，或明确重试已用尽。
- outcome_unknown：请求可能已被上游执行和计费，但本项目没有收到可验证结果。
- cancel_requested、cancelled：仅为兼容历史运行记录保留；当前产品不再提供用户取消入口。

终态为 succeeded、failed、outcome_unknown、cancelled。

## 领取与恢复

- 使用 SELECT ... FOR UPDATE SKIP LOCKED 领取 queued 或到期的 retry_wait job；领取条件始终包含 available_at <= 当前时间。
- generation_jobs 冗余不可变的 run_started_at 与 step_index，按 available_at、run_started_at、step_index、id 排序。部分索引只覆盖 queued/retry_wait，避免跨表排序。
- 前置步骤检查使用 generation_jobs(run_id, step_index, status) 索引；同一 run 中前序 step 未 succeeded 时，后续 job 不可领取。
- running job 必须记录 worker_id、lease_expires_at、attempt_started_at。
- Worker 定期续租。进程重启后，仅未开始上游调用的过期任务可重新排队。
- 一旦 attempt_started_at 已记录且进程在没有确定响应的情况下死亡，任务按统一上限最多自动重放 2 次；达到上限后转为 outcome_unknown，并提示核对 API易消耗记录。
- 每个 step 使用稳定 idempotency_key 防止本地重复入队；该键不能被当作上游幂等保证。
- generation_runs.next_event_seq 通过原子 UPDATE ... RETURNING 分配事件序号；事务回滚不会消耗序号，同一 run 并发追加不会重复或产生缺口。

## 重试规则

- HTTP 429：退避后自动重试，最多 2 次。
- HTTP 503：仅在确认属于临时容量或渠道不可用时重试，最多 2 次。
- 已知参数不支持导致的 503 不重试，例如 Grok 的 resolution=4k。
- HTTP 400、401、403、404、415：不重试。
- 超时、连接重置、连接中断、响应体截断：无法证明请求未到达或未计费，但按用户确认的策略最多自动重试 2 次；每次都可能产生重复扣费，达到上限后标记为 outcome_unknown。
- 内容审核拒绝：不原样重试。

固定退避为 5 秒、30 秒，并加入 0-999ms 随机抖动。retry_count 只统计实际重放次数，不包含首次调用，因此最多产生 3 次真实上游请求。每次调度和达到上限都写结构化重试日志。

## 用户运行语义

- 产品不提供取消按钮、客户端取消动作或公开取消 API。
- 用户提交后由队列持续执行到确定终态；刷新页面或断开 SSE 不会中止任务。
- 历史 cancel_requested、cancelled 记录继续可读，避免升级时破坏旧数据。

## 结果持久化

- b64_json 或 Gemini inlineData 必须解码后写入项目存储。
- URL 输出必须由服务端下载；FLUX 约 10 分钟过期，其他 URL 同样视为临时地址。
- 下载前重新校验 worker_id 与 job 状态；失去所有权的 Worker 不得继续落盘。
- 普通队列结果文件使用 runId:stepId:index 稳定幂等键。相同键和相同 SHA-256 内容复用已有文件；同键不同内容使用内容摘要后缀，禁止覆盖。AI 搭配逐套检查点额外加入 Worker 标识作为暂存键，避免接管 Worker 复用仍可能被旧 Worker 补偿删除的文件。
- 网络和磁盘 I/O 不放进持锁数据库事务。落盘函数返回本次是否新建文件的回执；成功事务回滚时，只补偿删除本次新建且未登记、也未被新 Worker 接管的文件。
- 下载成功、文件校验成功、素材记录与 step 结果在同一事务提交后，step 才能标记 succeeded。
- 日志只记录 provider、model、状态码、请求 ID、耗时、重试次数和白名单计费元数据；不得记录密钥、完整提示词、图片数据或完整响应体。

## 运维参数

- GENERATION_WORKER_POLL_MS：Worker 空闲轮询间隔，默认 2000ms，配置范围 100-60000ms。
- 高吞吐部署可降至 500ms；低负载部署可升至 5000ms，以减少空轮询。Worker 每次唤醒会先清空当前可领取任务，再等待下一轮。

## 验收

- 提交 API 在上游调用开始前返回 run_id。
- 服务重启后 queued 任务可继续；不确定的 running 任务不会被重复计费。
- retry_wait 在 available_at 前不可领取，到期后可领取。
- 429、可重试 503 和结果不确定的连接错误最多重放 2 次，退避为 5/30 秒；达到上限后按错误确定性进入 failed 或 outcome_unknown。
- 刷新页面或 SSE 重连不会丢失已提交任务和事件。
- 同一 run 并发追加事件时序号严格递增、无重复、无缺口。
- 所有成功结果使用项目自有 URL，第三方临时 URL 不进入长期历史记录。
- 成功事务回滚不会留下本次新建的孤立结果文件。
