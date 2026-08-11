# GitHub Issue #34–#35 CDP 审查与修复证据

## 审查基线

- 仓库：`imtms/tagent-core`
- 基线分支：`main`
- 基线提交：`3216734000ffb45abec2105ea3bf2494dd975584`
- CDP target：`95914B42AFD83DE9E2A44BA13DFC4868`
- CDP 查询时间：`2026-08-11T05:17:31.920Z`
- CDP 查询 URL：`https://github.com/imtms/tagent-core/issues?q=is%3Aissue%20state%3Aopen`
- 开放 Issue：仅 `#34`、`#35`

## #34 — Provider retry backoff can exceed the TaskRun idle timeout and terminate an actively retrying run

### CDP 复现描述

Issue 指出当前 `pi-runtime.ts` 使用 `1_000 * 2 ** (retryAttempt - 1)`，没有上限。配置 `TAGENT_PROVIDER_MAX_RETRIES=1000`、`TAGENT_RUN_TIMEOUT_MS=1200000` 时，第 12 次 retry 的 2,048,000ms 延迟超过 20 分钟 idle watchdog；第 23 次还超过 Node signed 32-bit timer 上限。

### main 核验与根因

基线代码确认缺陷存在：provider retry 事件只在等待开始时刷新 activity，之后 `waitForRetry(delayMs)` 静默等待。未受限的指数退避既能长于 idle/hard timeout，也能溢出 Node timer 范围。

### 最小修复

- 增加 `providerRetryDelayMs()`。
- 延迟取指数退避、`runTimeoutMs - 1`、`runHardTimeoutMs - 1` 与 `2_147_483_647` 的最小值。
- 大 retry ordinal 在指数计算溢出前直接返回预算上限。
- 保留已有 retry event、abort、steer 与 manual compaction 行为。

### 验收条件

1. retry 12 在 1,200,000ms idle budget 下不超过 1,199,999ms。
2. 任意高 retry ordinal 不超过 Node timer 上限。
3. retry delay 不超过配置的 idle/hard watchdog budget。
4. 现有 provider retry、abort 和控制路径回归测试继续通过。

## #35 — Malformed Supervisor audit blocks a completed TaskRun without any review-only recovery path

### CDP 复现描述

Issue 指出 Agent Attempt 已完成且 final candidate 已持久化时，如果 Supervisor 返回 `failures: {}`、缺失 criterion coverage 或其他 schema defect，`parseSettledAudit()` 抛错并直接形成 `supervisor_review_failed` 阻塞；没有仅重试 review 的恢复路径。

### main 核验与根因

基线代码确认缺陷存在：`OpenAiSupervisorReviewer.reviewSettled()` 对本地 schema/evidence validation error 立即抛出 `SupervisorReviewError`，明确不调用 repair LLM。TaskRunSupervisor 随后阻塞 run，尽管 Agent 工作无需重跑。

### 最小修复

- 首次 Supervisor response 本地校验失败后，最多执行一次 bounded review-only repair request。
- repair prompt 仅包含原本已裁剪的 `TASKRUN_DATA`、validation error，以及最多 8KB 的 previous response。
- 第二次仍执行完整 schema、criterion coverage、allowed evidence refs 校验。
- repair 成功时复用原 Agent candidate，且不创建 Agent Attempt/continuation。
- repair 再失败时明确报告一次 bounded review-only repair 已失败，不循环。

### 验收条件

1. 首次 malformed schema、第二次 valid audit 时 review 成功。
2. Agent Attempt ordinal 保持不变，continuation 数量保持 0。
3. missing criterion coverage 与 malformed JSON 最多触发一次 repair request。
4. 第二次仍无效时以 Supervisor review validation failure 终止，不无限循环。
5. unknown evidence refs 等现有本地 authoritative validation 继续执行。

## 验证命令

- `npx vitest run tests/pi-session.test.ts --reporter=dot`
- `npx vitest run tests/supervisor.test.ts --reporter=dot`
- `npm run check`
- `npm run lint`
- `git diff --check`

GitHub 回复、关闭及最终 CDP 开放 Issue 复核将在完整验证通过并推送 commit 后追加。

## 本地验证结果

- `npm run check`：PASS。
- `npm run lint`：PASS。
- `npx vitest run tests/pi-session.test.ts tests/supervisor.test.ts tests/runtime.test.ts --reporter=dot`：3 files、128 tests PASS。
- `npx vitest run tests/runtime-pi-workspace-package.test.ts --reporter=dot`：5 tests PASS。
- 完整 Vitest shard 1：55 files PASS、1 skipped；592 tests PASS、2 skipped。
- 完整 Vitest shard 2：56 files PASS；399 tests PASS、1 skipped。
- 合计：111 passed test files、991 passed tests、3 skipped tests，无失败。
- `git diff --check`：PASS。
