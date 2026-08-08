import { randomUUID } from "node:crypto";
import type { RunId } from "@tagent/execution/domain";
import type { Store } from "@tagent/persistence-sqlite/store";

export function recordSuccessfulBash(
  store: Store,
  runId: RunId,
  command: string,
  output = "verification passed",
  operationId = `test-bash-${randomUUID()}`,
) {
  const run = store.getRun(runId);
  if (!run) throw new Error(`Unknown test Run ${runId}`);
  store.claimOperation(operationId, runId, run.attempt, "tool.bash", { command });
  return store.updateOperation(operationId, {
    status: "succeeded",
    stage: "completed",
    result: {
      content: [{ type: "text", text: output }],
      details: { exitCode: 0 },
    },
  });
}

export function upsertTrustedCheck(
  store: Store,
  runId: RunId,
  check: {
    key: string;
    title: string;
    command: string;
    output?: string;
    required?: boolean;
  },
) {
  const operation = recordSuccessfulBash(store, runId, check.command, check.output);
  store.upsertCheck(runId, {
    key: check.key,
    title: check.title,
    status: "passed",
    required: check.required ?? true,
    command: check.command,
    evidence: "",
    stale: false,
    sourceOperationId: operation.id,
  });
  return operation;
}
