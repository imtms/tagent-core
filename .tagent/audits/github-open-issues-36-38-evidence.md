# GitHub Issue #36–#38 CDP 审查与修复证据

## 审查基线

- 仓库：`imtms/tagent-core`
- 分支：`main`
- 基线提交：`36e2e900233902435bcb14d3f6a31cf81d51bd78`
- Chromium CDP target：`95914B42AFD83DE9E2A44BA13DFC4868`
- 开放 Issue 查询时间：`2026-08-12T02:37:57.694Z`
- 查询 URL：`https://github.com/imtms/tagent-core/issues?q=is%3Aissue%20state%3Aopen`
- 查询结果：仅 `#36`、`#37`、`#38`

## #36 — Configured subject IDs beginning with `session:` lose user-scoped memory

### CDP 与源码核验

Issue 在 CDP 页面中给出的复现是配置 `subjectId: "session:alice"` 后检查 collaboration 与 runtime-host 的 Memory access scopes。基线代码在两个入口都以 `startsWith("session:")` 判断匿名身份，因此合法配置 principal 被错误排除 user scope。问题真实存在，应修复。

### 根因与最小修复

`session:` 前缀不是保留的身份类型标记；配置允许任意合法非空 subject ID。真正应排除 user scope 的仅是当前 Session 自动生成的精确 fallback：`session:${sessionId}`。

- collaboration `memoryScopes()` 改为精确比较当前 fallback。
- runtime-host Memory access 使用当前 Run 的 Session ID 做同一精确比较。

### 验收证据

专项测试同时验证：

1. 配置 principal `session:alice` 在 capture 与 runtime tool recall 两条路径都包含 `{type:"user", id:"session:alice"}`。
2. 精确 fallback `session:${currentSessionId}` 仍只得到 workspace + session scopes。

## #37 — Task-scoped communication preferences are persisted globally

### CDP 与源码核验

Issue 给出的中文 `这次任务我偏好回答简洁` 和英文 `For this task/session, I prefer concise answers` 都命中基线 durable cue（`偏好` / `i prefer`），直接被保存到 global `*`。分类器没有先处理显式本地限定词。问题真实存在，应修复。

### 根因与最小修复

在 durable cue 判定前优先识别明确 task/session-local 限定词，包括：`这次任务`、`本次任务`、`当前任务/会话`、`仅限这次/本次/当前`、`for/in this task/session`、`for/in the current task/session`、`this task/session only`。只要存在明确本地限定词，即保持 Session scope；未限定的长期表达仍沿用原 global 行为。

### 验收证据

专项测试通过真实 Store、execution collaboration adapter 与 LearningService 提交中英文输入，确认：

1. profile 仅写入 Session scope，不产生 global profile。
2. 当前 Session 可解析出 `verbosity: 简洁`。
3. 同一 principal 的无关 Session 不再收到该偏好。

## #38 — Omitted console session `requestId` collides across process restarts

### CDP 与源码核验

Issue 指出 `/api/v1/console/sessions` 在未提供可选 `requestId` 时使用 Fastify `request.id` 作为持久幂等键。Fastify 新进程会从 `req-1` 重新开始，配合同一持久 Store 会导致旧 receipt 重放或 payload conflict。基线源码确认该 fallback。问题真实存在，应修复。

### 根因与最小修复

进程本地 request identity 不能作为跨进程持久幂等 identity。保留 caller-provided `requestId` 的原有幂等语义；缺省时改为生成 `console-session:${randomUUID()}`，使独立请求跨重启不会碰撞。

### 验收证据

专项测试使用同一 SQLite 文件依次创建三个全新 Fastify app：

1. 第一次无 requestId 创建 `First`。
2. 重启后相同 payload 创建新的 Session，而非 replay。
3. 再重启后不同 payload `Second` 返回 200，而非 500。
4. 最终持久 Session 数为 3。

## 本地验证

- `npx vitest run tests/issue-regressions-36-38.test.ts --reporter=dot`：3/3 PASS。
- `npx vitest run tests/learning-ledger-profile.test.ts tests/pi-session.test.ts tests/http-fastify-workspace-package.test.ts tests/issue-regressions-24-28.test.ts tests/issue-regressions-36-38.test.ts --reporter=dot`：5 files、65 tests PASS。
- `npm run check`：PASS。
- `npm run lint`：PASS。
- `git diff --check`：PASS。

GitHub 回复、关闭、推送提交及最终开放 Issue CDP 复核将在发布步骤完成后追加。
