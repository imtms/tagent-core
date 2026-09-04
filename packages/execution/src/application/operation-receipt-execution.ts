import { createHash } from "node:crypto";
import type { RuntimeToolResult, ToolCapabilityApplicationPort } from "../ports/index.js";
import { classifyToolError } from "../ports/index.js";

export function evidencedResult(result: RuntimeToolResult, receiptId: string, mutation: boolean): RuntimeToolResult {
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

export async function executeReadOnlyOperation(input: {
  capabilities: ToolCapabilityApplicationPort;
  id: string;
  operationType: string;
  args: unknown;
  signal: AbortSignal;
  execute(): Promise<RuntimeToolResult>;
}): Promise<RuntimeToolResult> {
  const receipt = input.capabilities.claimOperation(input.id, input.operationType, input.args);
  if (!receipt.claimed) {
    if (receipt.status === "succeeded") return receipt.result as RuntimeToolResult;
    throw new Error(`Operation ${input.id} cannot be replayed from status ${receipt.status}`);
  }
  try {
    const result = evidencedResult(await input.execute(), input.id, false);
    input.capabilities.updateOperation(input.id, {
      status: "succeeded", stage: "observed", effects: [{ kind: "workspace", action: "read_only" }], result,
    });
    return result;
  } catch (error) {
    const classified = classifyToolError(error, { signal: input.signal });
    input.capabilities.updateOperation(input.id, {
      status: "failed", stage: "observation_failed",
      effects: [{ kind: "workspace", action: "read_only" }, { kind: "error", error: classified.toJSON() }],
      error: classified.message,
    });
    throw classified;
  }
}
