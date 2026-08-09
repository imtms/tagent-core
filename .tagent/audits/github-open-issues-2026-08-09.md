# GitHub 开放 Issue 审查快照（2026-08-09）

## 快照元数据

- 仓库：`imtms/tagent-core`
- 仓库远端：`git@github.com:imtms/tagent-core.git`
- 审查基线分支：`main`
- 审查基线提交：`02c0e92ca0928ea3affa31e85f21282e34fa790f`
- CDP 浏览器：`Chrome/150.0.7871.181`，CDP `1.3`，`127.0.0.1:9222`
- 首次开放列表读取时间：`2026-08-09T05:09:16.464Z`
- 首次开放列表 URL：<https://github.com/imtms/tagent-core/issues?q=is%3Aissue%20state%3Aopen>
- 首次读取结果：GitHub 页面显示 `0 of 5 selected`；开放 Issue 编号为 `#28`、`#27`、`#26`、`#25`、`#24`。
- 判定口径：属于当前仓库、可在当前代码基线上复核的问题，并且修复有明确、可自动验证的结果，则标记为“应修复”；重复项、外部系统问题、仅咨询/功能提议且不构成当前缺陷的项才标记为“不属于本目标”。

## 审查结论总览

| Issue | 标题 | 结论 | 简要理由 |
|---|---|---|---|
| [#28](https://github.com/imtms/tagent-core/issues/28) | Console message idempotency is non-atomic and conflicting payloads return stale success or HTTP 500 | **应修复** | 当前 admission 检查发生在异步 router 调用前，SQLite 重复插入路径不比较 payload，且普通错误会映射为可重试 500；属于可复现的数据一致性与 HTTP 契约缺陷。 |
| [#27](https://github.com/imtms/tagent-core/issues/27) | Invalid console pagination limit returns 500 instead of a validation error | **应修复** | 当前路由直接对 `Number(query.limit)` 做 clamp，`NaN` 可进入 SQLite；属于明确的输入验证与错误映射缺陷。 |
| [#26](https://github.com/imtms/tagent-core/issues/26) | Runtime factory failure leaves TaskRun stuck running without a cancellable runtime | **应修复** | runtime 创建前已安装 checkpoint/lease，但失败路径仅释放 lease，未终结 Attempt/TaskRun 或清理 checkpoint；违反运行生命周期不变量。 |
| [#25](https://github.com/imtms/tagent-core/issues/25) | Restoring a forgotten Topic leaves its associated memory records deleted | **应修复** | Topic forget 会按 topic 删除记录，但 restore 仅按显式 record IDs 恢复记录；forget/restore 不对称并留下不可用的 active Topic。 |
| [#24](https://github.com/imtms/tagent-core/issues/24) | Empty Memory forget request tombstones every record in the authorized scope | **应修复** | agent tool 与 HTTP 边界均允许空目标，service 无防御性校验，底层空过滤器可匹配整个 scope；属于高风险数据丢失缺陷。 |

本次开放 Issue 中没有“不属于本目标”的条目；5/5 均应进入后续修复 Roadmap 项。

## 应修复 Issue 清单与验收条件

### #28 — Console message idempotency is non-atomic and conflicting payloads return stale success or HTTP 500

**问题描述**

同一 session 与 `requestId` 被复用时，当前行为取决于调用时序：并发的不同 payload 可能都成功并把第二个请求静默重放为第一个 payload；顺序复用则抛出普通 `Error`，最终被 HTTP 层转换为 `500 internal.error` 且 `retryable: true`。这使幂等键不能稳定绑定规范化 payload，也使客户端无法区分冲突与服务端故障。

**代码复核**

- `packages/admission/src/application/admission-coordinator.ts`：初始幂等检查位于 awaited router analysis 之前，存在 check-then-act 竞态。
- `adapters/persistence-sqlite/src/store.ts`：`enqueueSessionInbox` 的重复键路径只返回已有 item，不比较 content/payload。
- `adapters/http-fastify/src/v1/errors.ts`：普通错误默认映射为可重试 500。

**可验证验收条件**

1. 相同 session、相同 `requestId`、相同规范化 payload 的顺序或并发提交均只产生一个 inbox item，并重放同一结果。
2. 相同 session、相同 `requestId`、不同规范化 payload 的顺序提交返回非重试的 HTTP `409`，错误码明确表示 idempotency conflict。
3. 对两个故意交错、不同 payload 的并发提交，恰有一个创建成功，另一个得到同样的非重试 `409`；不得返回旧 payload 的成功响应，也不得返回 500。
4. 上述原子比较在 persistence 边界生效，并有 admission/persistence 与 Fastify 路由回归测试。

### #27 — Invalid console pagination limit returns 500 instead of a validation error

**问题描述**

console messages 与 task-runs 列表路由对 `limit` 使用 `Number(...)` 后直接 clamp，非数字会形成 `NaN` 并作为 SQLite `LIMIT ?` 参数，最终被错误报告为可重试的内部错误。

**代码复核**

- `adapters/http-fastify/src/v1/console-session-routes.ts`：两个列表路由未验证 `limit` 是否为有限整数。
- `adapters/persistence-sqlite/src/store.ts`：列表方法会直接使用传入的 limit。

**可验证验收条件**

1. `limit` 省略时继续使用既定默认值；有效范围内的整数正常分页。
2. `limit=abc`、`limit=NaN`、小数、零、负数以及超过最大值的值均返回非重试 HTTP `400` validation error，而不是 500。
3. messages 与 task-runs 两个端点使用一致的解析和范围规则。
4. Fastify route tests 覆盖上述合法与非法输入，并断言错误码和 `retryable: false`。

### #26 — Runtime factory failure leaves TaskRun stuck running without a cancellable runtime

**问题描述**

AttemptExecutor 在 runtime/model selection 前已获取 execution lease 并安装 checkpoint/token state。若 model selection 或 runtime factory 同步抛错，当前 catch 仅释放 lease 后继续抛错，TaskRun、Attempt 与 checkpoint 仍为 running/active，且 runtime map 中没有可取消实例。

**代码复核**

- `packages/execution/src/application/attempt-executor.ts`：checkpoint/lease 安装早于 runtime 创建；runtime 创建失败路径只释放 lease。
- `packages/execution/src/application/continuation-scheduler.ts`：取消依赖 runtime map，没有 runtime 时返回 false。

**可验证验收条件**

1. runtime model selection 或 runtime factory 在创建阶段抛错时，checkpoint/token/process-local state 被清理，execution lease 被释放。
2. 活跃 Attempt 与 TaskRun 原子转入既定的失败或可恢复终态，不再保持 `running`，并发布相应 lifecycle/terminal event。
3. direct start、resume 与 queued continuation 三条启动路径均不会留下“running 但无 runtime”的孤儿状态；continuation claim/state 也被正确结算。
4. 使用 throwing runtime factory 与/或不允许的 model 添加回归测试，断言持久化状态、checkpoint、lease、runtime map 和事件结果。

### #25 — Restoring a forgotten Topic leaves its associated memory records deleted

**问题描述**

以 Topic ID 执行 forget 时，记录后端会删除关联记录，同时 Topic descriptor 被删除；但 restore 只把显式 record IDs 传给 record backend，Topic IDs 仅用于恢复 descriptor，因此恢复后 Topic active 而内容记录仍 deleted。

**代码复核**

- `packages/memory/src/memory-service.ts`：forget 将 topic IDs 传给 record store，restore 的 record store 调用只传 `request.ids`。
- `packages/memory/src/ports.ts`：record restore port 缺少按 Topic 恢复的能力。

**可验证验收条件**

1. 对一个 Topic 及其关联 active records 执行 Topic-level forget 后，再在 grace period 内按同一 Topic ID restore，Topic descriptor 与本次 forget 影响的关联记录都恢复为此前状态/active。
2. restore 返回值准确统计恢复的 records 与 topics，恢复后的 recall/export 能再次读取关联记录。
3. 不得恢复超出授权 scope、已过 purge 时限或并非由可恢复删除状态覆盖的记录。
4. in-memory 与 PostgreSQL record backend（以及适用的集成层）都有 forget→restore 对称性回归测试。

### #24 — Empty Memory forget request tombstones every record in the authorized scope

**问题描述**

当 `ids` 与 `topicIds` 均缺失或为空数组时，agent tool schema 与 admin HTTP 路由允许请求进入 MemoryService；service 无防御性 guard，而 in-memory/PostgreSQL adapters 把空过滤条件解释为匹配授权 scope 中全部记录，造成 scope-wide tombstone。

**代码复核**

- `adapters/workspace-local/src/tools.ts`：`MemoryForgetSchema` 的两个目标数组都可选，允许空对象。
- `adapters/http-fastify/src/v1/admin-memory-console-routes.ts`：只校验 scope，未要求至少一个目标。
- `packages/memory/src/memory-service.ts`：forget 未拒绝空目标。
- record adapters：空 ID/topic filter 会退化成 scope 匹配。

**可验证验收条件**

1. agent tool 与 admin HTTP 边界都拒绝 `ids`/`topicIds` 同时缺失或均为空；HTTP 返回非重试 `400` validation error，tool 返回明确的参数验证失败。
2. MemoryService/record backend 存在防御性 guard，即使绕过公共边界，空目标也不得修改任何记录或 Topic。
3. 非空 record ID、非空 Topic ID 以及两者组合的既有 forget 行为保持正常。
4. HTTP、agent-tool、service、in-memory 和 PostgreSQL 路径有回归测试，断言空请求前后记录状态与计数不变。

## 后续 Roadmap 输入

原审查建议的风险顺序为：`#24`（scope-wide 数据丢失）→ `#26`（运行生命周期孤儿）→ `#28`（幂等一致性）→ `#25`（恢复不完整）→ `#27`（输入验证）。随后用户明确授权扩展执行范围，实际修复与关闭结果见下方复核。


## 修复与关闭复核（2026-08-09）

用户已明确授权将本次执行范围扩展至 `fix_issues` 与 `resolve_issues`。审查清单中的五项缺陷均已在当前工作区完成修复，并通过 CDP 回复和关闭：

| Issue | 修复结果 | GitHub 结果 |
|---|---|---|
| #24 | 空 forget 在 tool schema/runtime、HTTP、MemoryService、in-memory 与 PostgreSQL 边界均被拒绝。 | 已回复，已关闭 |
| #25 | record restore 支持 Topic IDs，Topic forget→restore 同时恢复 descriptor 与关联 records。 | 已回复，已关闭 |
| #26 | runtime factory 失败会终结 Attempt/TaskRun、清理 checkpoint、释放 lease 并完成 post-attempt。 | 已回复，已关闭 |
| #27 | console pagination limit 要求 1–200 的有限整数，非法值返回非重试 400。 | 已回复，已关闭 |
| #28 | SQLite 幂等冲突比较原子化；相同 payload 重放，不同 payload 顺序/并发均稳定返回非重试 409。 | 已回复，已关闭 |

验证证据：

- `npm run check` 通过。
- `tests/issue-regressions-24-28.test.ts` 及受影响模块测试共 217 项通过。
- PostgreSQL 实例未配置，`tests/postgres-query-shape.test.ts` 的 10 项参数、guard 与 Topic restore 查询回归通过。
- CDP 于 `2026-08-09T05:54:57.928Z` 逐项确认 #24–#28 均为 closed 且包含修复回复；重新读取开放 Issue 列表返回 `No results`，开放数为 0。
