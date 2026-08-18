import { createHash } from "node:crypto";
import type { RuntimeCapabilityCatalog, RuntimeTool, RuntimeToolResult, ToolCapabilityApplicationPort } from "../ports/index.js";
import { classifyToolError, type StructuredToolError, ToolExecutionError } from "../ports/tool-error.js";

interface ToolCallState {
  toolName: string;
  argsHash: string;
  blocked?: string;
  executing: boolean;
  settled: boolean;
  recorded: boolean;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}

function argsHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function operationId(capabilities: ToolCapabilityApplicationPort, toolCallId: string) {
  const attempt = capabilities.getRunExecutionState?.()?.attempt ?? capabilities.getRun()?.attempt;
  if (attempt === undefined) throw new Error("Run not found");
  return `${capabilities.runId}:${attempt}:${toolCallId}`;
}

function evidencedResult(result: RuntimeToolResult, receiptId: string, mutation: boolean): RuntimeToolResult {
  const observedAt = Date.now();
  const resultDigest = createHash("sha256").update(JSON.stringify(result)).digest("hex");
  return {
    ...result,
    content: mutation ? result.content.map((part, index) => {
      if (index !== 0 || part.type !== "text") return part;
      const marker = `\n[trusted operation receipt: ${receiptId}]`;
      const budget = Math.max(0, 24_000 - Buffer.byteLength(marker));
      const source = Buffer.from(part.text);
      let end = Math.min(source.length, budget);
      while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
      return { ...part, text: source.subarray(0, end).toString("utf8") + marker };
    }) : result.content,
    details: result.details && typeof result.details === "object"
      ? { ...result.details, operationId: receiptId, observedAt, resultDigest }
      : { value: result.details, operationId: receiptId, observedAt, resultDigest },
  };
}

/** Non-bypassable execution path for authorization, receipts, execution and settlement. */
export class ToolExecutionPipeline {
  private readonly calls = new Map<string, ToolCallState>();
  private source?: ReadonlyMap<string, RuntimeTool>;

  constructor(private readonly capabilities: ToolCapabilityApplicationPort) {}

  bindCatalog(catalog: RuntimeCapabilityCatalog): RuntimeCapabilityCatalog {
    if (this.source) throw new Error("ToolExecutionPipeline is already bound to an Attempt catalog");
    this.source = new Map(catalog.tools.map((tool) => [tool.name, tool]));
    return Object.freeze({ tools: Object.freeze(catalog.tools.map((tool) => this.wrap(tool))) });
  }

  beforeToolCall(toolCallId: string, toolName: string, args: unknown): { blocked: boolean; reason?: string } {
    const existing = this.calls.get(toolCallId);
    const digest = argsHash(args);
    const tool = this.source?.get(toolName);
    if (!tool) return { blocked: true, reason: `Unknown tool ${toolName}` };
    if (existing) {
      if (existing.toolName !== toolName || existing.argsHash !== digest) {
        return { blocked: true, reason: `Tool call ${toolCallId} was reused with different payload or tool identity` };
      }
      if (existing.settled && !tool.policy?.operationType) {
        return { blocked: true, reason: `Tool call ${toolCallId} is already settled without a replayable receipt` };
      }
      return existing.blocked ? { blocked: true, reason: existing.blocked } : { blocked: false };
    }
    let blocked: string | undefined;
    let recorded = false;
    if (!this.capabilities.isCurrentAttempt()) blocked = "Attempt is no longer current";
    if (!blocked && tool.policy?.externalAction) {
      const approval = this.capabilities.authorizeExternalAction(tool.policy.externalAction === "explicit");
      if (!approval.allowed) {
        let reason = approval.reason;
        if (tool.policy.externalAction === "explicit" && this.capabilities.requestExternalActionApproval) {
          try {
            const requested = this.capabilities.requestExternalActionApproval(toolCallId, toolName);
            reason = `${requested.reason} (approval ${requested.approvalId})`;
          } catch (error) {
            reason = `${reason}; approval request failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        blocked = `External action approval guard: ${reason}`;
      }
    }
    const access = typeof tool.policy?.workspaceAccess === "function" ? tool.policy.workspaceAccess(args) : tool.policy?.workspaceAccess;
    if (!blocked && access === "mutation") {
      const goal = this.capabilities.authorizeWorkspaceMutation();
      if (!goal.allowed) blocked = `Workspace Goal mutation guard: ${goal.reason}`;
      else this.capabilities.advanceRunPhase("implement");
    }
    if (!blocked) {
      const attempt = this.capabilities.recordToolAttempt(toolCallId, toolName, args);
      recorded = attempt.created && attempt.status === "running";
      if (!attempt.created && attempt.status === "failed") blocked = `Tool attempt ${toolCallId} already failed`;
      else if (!attempt.created && attempt.status === "running") blocked = `Tool attempt ${toolCallId} is already running`;
      else if (!attempt.created && !tool.policy?.operationType) blocked = `Tool attempt ${toolCallId} already succeeded without a replayable receipt`;
      else if (attempt.created && attempt.guard.blocked) blocked = attempt.guard.reason;
    }
    this.calls.set(toolCallId, { toolName, argsHash: digest, blocked, executing: false, settled: false, recorded });
    if (blocked) this.settle(toolCallId, false, blocked);
    return blocked ? { blocked: true, reason: blocked } : { blocked: false };
  }

  afterToolCall(toolCallId: string, success: boolean, error?: StructuredToolError) {
    this.settle(toolCallId, success, error ? JSON.stringify(error) : undefined);
  }

  private wrap(tool: RuntimeTool): RuntimeTool {
    return Object.freeze({
      ...tool,
      execute: async (toolCallId: string, args: unknown, signal: AbortSignal, onUpdate?: Parameters<RuntimeTool["execute"]>[3]) => {
        if (signal.aborted) {
          const classified = classifyToolError(signal.reason ?? new Error("Tool call aborted before dispatch"), {
            signal,
            beforeDispatch: true,
          });
          // Runtime hooks may have admitted and durably recorded this call just
          // before SDK dispatch. Balance that record even though the body never
          // starts; a direct pre-aborted caller still records nothing.
          if (this.calls.has(toolCallId)) this.settle(toolCallId, false, JSON.stringify(classified.toJSON()));
          throw classified;
        }
        const guard = this.beforeToolCall(toolCallId, tool.name, args);
        if (guard.blocked) {
          throw new ToolExecutionError("NOT_AUTHORIZED", guard.reason ?? "Tool call blocked");
        }
        const state = this.calls.get(toolCallId)!;
        if (state.executing) throw new Error(`Tool call ${toolCallId} is already executing`);
        state.executing = true;
        try {
          const result = await this.executeWithReceipt(tool, toolCallId, args, signal, onUpdate);
          this.settle(toolCallId, true);
          return result;
        } catch (error) {
          const classified = classifyToolError(error, { signal });
          this.settle(toolCallId, false, JSON.stringify(classified.toJSON()));
          throw classified;
        } finally {
          state.executing = false;
        }
      },
    });
  }

  private async executeWithReceipt(tool: RuntimeTool, toolCallId: string, args: unknown, signal: AbortSignal, onUpdate?: Parameters<RuntimeTool["execute"]>[3]): Promise<RuntimeToolResult> {
    const policy = tool.policy;
    if (!policy?.operationType) return this.executeToolBody(tool, toolCallId, args, signal, onUpdate);
    const id = operationId(this.capabilities, toolCallId);
    const access = typeof policy.workspaceAccess === "function" ? policy.workspaceAccess(args) : policy.workspaceAccess;
    if (access === "read_only") {
      const result = await this.executeToolBody(tool, toolCallId, args, signal, onUpdate);
      const receipt = this.capabilities.claimOperation(id, policy.operationType, args);
      if (!receipt.claimed) {
        if (receipt.status === "succeeded") return receipt.result as RuntimeToolResult;
        throw new Error(`Operation ${id} cannot be recorded from status ${receipt.status}`);
      }
      const evidenced = evidencedResult(result, id, false);
      this.capabilities.updateOperation(id, {
        status: "succeeded", stage: "observed",
        effects: [{ kind: "workspace", action: "read_only" }], result: evidenced,
      });
      return evidenced;
    }
    const receipt = this.capabilities.claimOperation(id, policy.operationType, args);
    if (!receipt.claimed) {
      if (receipt.status === "succeeded") return receipt.result as RuntimeToolResult;
      throw new Error(`Operation ${id} cannot be replayed from status ${receipt.status}`);
    }
    const invalidates = typeof policy.invalidatesChecks === "function" ? policy.invalidatesChecks(args) : policy.invalidatesChecks !== false;
    let invalidatedChecks: number | undefined;
    const invalidateChecks = () => {
      if (invalidatedChecks === undefined) invalidatedChecks = invalidates ? this.capabilities.markChecksStale() : 0;
      return invalidatedChecks;
    };
    try {
      const result = evidencedResult(await this.executeToolBody(tool, toolCallId, args, signal, onUpdate), id, true);
      const staleChecks = invalidateChecks();
      this.capabilities.updateOperation(id, { status: "succeeded", stage: "completed", effects: [
        { kind: "workspace", action: access ?? "mutation" },
        { kind: "checks", action: staleChecks ? "stale" : "preserved", count: staleChecks },
      ], result });
      try {
        tool.onOperationSettled?.(toolCallId, args, result);
      } catch {
        // The successful receipt is already authoritative and must never be
        // rewritten as failed by an optional post-settlement notification.
        // Durable consumers reconcile any missed notification on startup.
      }
      return result;
    } catch (error) {
      const classified = classifyToolError(error, { signal });
      const staleChecks = invalidateChecks();
      this.capabilities.updateOperation(id, {
        status: "failed",
        stage: "execution_failed",
        effects: [
          { kind: "workspace", action: access ?? "mutation" },
          { kind: "checks", action: staleChecks ? "stale" : "preserved", count: staleChecks },
          { kind: "error", error: classified.toJSON() },
        ],
        error: classified.message,
      });
      throw classified;
    }
  }

  private async executeToolBody(
    tool: RuntimeTool,
    toolCallId: string,
    args: unknown,
    signal: AbortSignal,
    onUpdate?: Parameters<RuntimeTool["execute"]>[3],
  ): Promise<RuntimeToolResult> {
    signal.throwIfAborted();
    try {
      const result = await tool.execute(toolCallId, args, signal, onUpdate);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      throw classifyToolError(error, { signal });
    }
  }

  private settle(toolCallId: string, success: boolean, error?: string) {
    const state = this.calls.get(toolCallId);
    if (!state || state.settled) return;
    state.settled = true;
    if (!state.recorded) return;
    if (!this.capabilities.consumeAtomicallySettledToolCall(toolCallId) && this.capabilities.isCurrentAttempt()) {
      this.capabilities.completeToolAttempt(toolCallId, success, error);
    }
  }
}
