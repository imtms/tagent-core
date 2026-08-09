# GitHub Issue #29–#32 独立诊断与验证证据

## 证据范围与来源

- 仓库：`imtms/tagent-core`
- CDP target：`95914B42AFD83DE9E2A44BA13DFC4868`
- 修复前 CDP 快照：`workspace/.tagent/tmp/cdp-open-issues-audit.json`
- 修复前查询时间：`2026-08-09T11:42:58.934Z`
- 修复前查询结果：开放 Issue 恰为 `#29`、`#30`、`#31`、`#32`
- 最终 CDP 复核脚本：`workspace/.tagent/tmp/cdp-final-verify-29-32.mjs`
- 本文把每项 Issue 的 CDP 原始问题描述、独立复现结果、根因、最小修复、专项测试和关闭结果逐项映射，作为 acceptance criteria 2/3 的直接证据。

## #29 — SSE replay can permanently miss events emitted before the live subscription is registered

### CDP 检查记录

- URL：`https://github.com/imtms/tagent-core/issues/29`
- 修复前状态：Open
- CDP 正文记录的复现结果：`persistedSequences: [1, 2]`，但 `receivedSequences: [1]`。
- Issue 指出的触发窗口：读取 `replayHighWatermark` 之后、注册 `service.subscribe()` 之前追加 sequence 2。

### 独立复现

专项测试：`tests/v1-api-differential.test.ts` 中 `subscribes before capturing the SSE replay watermark so gap events are delivered`。

测试构造一个已有 sequence 1 的 TaskRun，并在 SSE 路由第二次 `service.getRun()` 时追加 sequence 2。这正好把事件注入旧实现的 high-watermark/subscription 缝隙。旧实现中 sequence 2 不属于水位内 replay，也因为尚未订阅而不进入 live buffer，结果只收到 `[1]`；修复后断言收到 `[1, 2]`。

### 根因定位

文件：`adapters/http-fastify/src/v1/event-routes.ts`

旧顺序先调用 `service.getRun(taskRunId)!.lastEventSeq` 捕获回放水位，之后才调用 `service.subscribe()`。这是非原子的 snapshot-then-subscribe 顺序，期间提交的事件同时逃逸于 replay 集和 live listener。

### 最小修复

先安装 `service.subscribe()`，让水位读取前后的新事件进入 `buffered`；随后读取 durable high watermark，回放至该水位，最后仅发送 `event.seq > deliveredSequence` 的 buffered 事件以去重并保持顺序。

### 专项验证

- 测试名：`subscribes before capturing the SSE replay watermark so gap events are delivered`
- 关键断言：收到的 sequence 为 `[1, 2]`
- 结果：PASS

### GitHub 结果

CDP 最终复核：存在以 `Fixed in the current workspace.` 开头的处理回复；Issue 状态 Closed。

## #30 — SSE replay closes the stream when ServerResponse.write applies backpressure

### CDP 检查记录

- URL：`https://github.com/imtms/tagent-core/issues/30`
- 修复前状态：Open
- CDP 正文记录的复现结果：`persistedEventCount: 5`，`receivedEventCount: 1`。
- 触发条件：第一条 SSE event 已实际写入，但包装后的 `ServerResponse.write()` 返回 `false`。

### 独立复现

专项测试：`tests/v1-api-differential.test.ts` 中 `does not close an SSE stream when write reports backpressure`。

测试使用真实 HTTP `ServerResponse`，让第一条 `id:` SSE 写入仍调用原始 `write()`，但把返回值强制改为 `false`；同时 spy `ServerResponse.end()`。旧实现收到 `false` 后立即 `closeStream()`，因此 response 被 end；修复后的关键断言是该 SSE response 不出现在 `endSpy.mock.contexts` 中。

### 根因定位

文件：`adapters/http-fastify/src/v1/event-routes.ts`

旧代码把 `response.write(...) === false` 当作 transport failure，并立即关闭 stream。Node 的契约是：`false` 表示 chunk 已被接受，但内部缓冲达到高水位，需要等待 `drain`；它不是写失败。heartbeat 使用了相同的错误判断。

### 最小修复

- event write 返回 `false` 时仅设置 `backpressured = true`，不关闭连接；
- 监听 `drain` 清除背压状态；
- 背压期间跳过 heartbeat 写入；
- 只在编码异常、stale generation、response error 或 client close 等真实终止条件下关闭。

### 专项验证

- 测试名：`does not close an SSE stream when write reports backpressure`
- 关键断言：强制 `write(false)` 后没有调用 `end()` 关闭该 SSE response
- 结果：PASS
- 同一文件的 malformed replay/live stream 测试继续通过，证明真实错误关闭语义未被破坏。

### GitHub 结果

CDP 最终复核：存在修复回复；Issue 状态 Closed。

## #31 — Parallel TaskRun approval is persisted even when the approved launch fails

### CDP 检查记录

- URL：`https://github.com/imtms/tagent-core/issues/31`
- 修复前状态：Open
- CDP 正文记录的复现结果：`approveCall` 抛出 `not_queued`，但 `approvalStatus` 已是 `approved`，且 `taskStarted: false`。

### 独立复现

专项测试：`tests/runtime.test.ts` 中 `keeps a parallel approval pending when the approved launch cannot be claimed`。

测试创建 parent TaskRun 和 parallel inbox item、请求 approval，然后在批准前删除 inbox item，使 claim/launch 稳定返回 `not_queued`。旧实现先 resolve approval 并发布 approved event，再尝试 launch，因此会留下虚假 approved 状态。修复后的测试断言：

1. `approveRunApproval()` 抛出 `could not start: not_queued`；
2. approval 仍为 `{ status: "pending", resolvedAt: null }`；
3. 没有对应 `supervisor.approval.approved` event。

### 根因定位

文件：`packages/admission/src/application/admission-coordinator.ts`

旧 `approveRunApproval()` 的顺序为：`resolveApprovalRequest(... approved)` → publish approved event → `launchSessionInboxNow()`。目标 item 在批准时可能已非 queued，导致 launch 失败，但 approval 的持久状态和审计事件不可回滚。

### 最小修复

对 `start_parallel_taskrun` 分支先校验 metadata 并执行 `launchSessionInboxNow()`；仅在 `launched.status === "started"` 后 resolve approval 和发布 approved event。claim/launch 失败时不消费 pending approval。

### 专项验证

- 测试名：`keeps a parallel approval pending when the approved launch cannot be claimed`
- 关键断言：抛出 + pending 保留 + approved event 不存在
- 结果：PASS

### GitHub 结果

CDP 最终复核：存在修复回复；Issue 状态 Closed。

## #32 — automatic continuation remains running after runtime factory failure

### CDP 检查记录

- URL：`https://github.com/imtms/tagent-core/issues/32`
- 修复前状态：Open
- CDP 正文记录的复现结果：runtime factory 调用 2 次；TaskRun 已 `{ status: "failed", attempt: 2 }`，但 continuation 仍 `{ status: "running", leaseOwner: "still set", leaseUntil: "still active", error: "" }`。

### 独立复现

专项测试：`tests/runtime.test.ts` 中 `fails and releases an automatic continuation when its runtime factory throws`。

测试让第一次 runtime 正常进入 blocked 并排队 automatic continuation，让第二次 runtime factory 抛出 `continuation factory unavailable`。旧路径会终结 TaskRun/Attempt，却遗留 running continuation 和 lease。修复后的测试逐层断言：

1. runtime factory 确实调用 2 次；
2. TaskRun 为 failed、attempt 2；
3. attempt 2 为 failed 且 `active = 0`；
4. checkpoint 为 inactive；
5. continuation 为 failed；
6. continuation error 为 factory 错误；
7. `leaseOwner` 清空、`leaseUntil` 为 null。

### 根因定位

文件：

- `packages/execution/src/application/attempt-executor.ts`
- `packages/execution/src/application/runtime-factory-failure.ts`

ContinuationScheduler 在 runtime construction 前已 claim continuation。factory 抛错时，AttemptExecutor 调用 `settleRuntimeFactoryFailure()`，但旧 input 不携带 `continuationId`、lease owner，也未暴露 continuation persistence，因此 failure settlement 无法终结已 claim 的 continuation。正常 runtime 后路径会 settle continuation，缺口仅存在于 pre-runtime factory failure。

### 最小修复

AttemptExecutor 把 `continuationId` 和 `continuationOwner` 传入 runtime-factory failure settlement；settlement 在 lease ownership 仍有效时调用 `updateContinuation(..., "failed", message, owner)`，由持久层记录错误并清除 lease，之后照常释放 attempt execution lease。

### 专项验证

- 测试名：`fails and releases an automatic continuation when its runtime factory throws`
- 关键断言：TaskRun、Attempt、Checkpoint、Continuation 全部进入一致终态，continuation lease 被清除且记录错误
- 结果：PASS

### GitHub 结果

CDP 最终复核：存在修复回复；Issue 状态 Closed。

## 最终验证汇总

- 逐 Issue 专项测试：上述 4 个测试分别对应 #29、#30、#31、#32。
- 相关测试命令：
  `npx vitest run tests/runtime.test.ts tests/v1-api-differential.test.ts tests/issue-regressions-24-28.test.ts tests/task-run-transition-caller-publish.test.ts --reporter=dot`
- 结果：4 个文件、79 个测试全部通过。
- 类型/构建：`npm run check` 通过。
- 静态检查：`npm run lint` 通过。
- Patch 格式：`git diff --check` 通过。
- 最终 CDP 复核时间：`2026-08-09T11:57:57.562Z`。
- 最终 CDP 逐项结果：#29、#30、#31、#32 均 `closed: true`、`commented: true`。
- 最终开放 Issue 查询：`No results`，`openIssueCount: 0`。
