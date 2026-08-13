import type { RunId } from "@tagent/execution/domain";
import type { RuntimeToolResult, ToolCapabilityApplicationPort } from "@tagent/execution/ports";

export const MAX_OUTPUT = 24_000;
export const MAX_DURABLE_OUTPUT = 16 * 1024 * 1024;

export function previewText(text: string) {
  const source = Buffer.from(text);
  if (source.length <= MAX_OUTPUT) return text;
  const marker = "\n... output omitted; full content is available in the referenced Artifact ...\n";
  const budget = MAX_OUTPUT - Buffer.byteLength(marker);
  let headEnd = Math.floor(budget * .55);
  while (headEnd > 0 && (source[headEnd] & 0xc0) === 0x80) headEnd -= 1;
  let tailStart = source.length - Math.ceil(budget * .45);
  while (tailStart < source.length && (source[tailStart] & 0xc0) === 0x80) tailStart += 1;
  return source.subarray(0, headEnd).toString("utf8") + marker + source.subarray(tailStart).toString("utf8");
}

export function textResult(text: string, details: Record<string, unknown> = {}): RuntimeToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text: previewText(text) }], details };
}

export function safeArtifactId(value: string) { return value.replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 180); }

export function currentAttemptOrdinal(capabilities: ToolCapabilityApplicationPort) {
  return capabilities.getRunExecutionState?.()?.attempt ?? capabilities.getRun()?.attempt;
}

export function operationId(runId: RunId, attempt: number, toolCallId: string) {
  return `${runId}:${attempt}:${toolCallId}`;
}

export async function persistToolOutputArtifact(
  capabilities: ToolCapabilityApplicationPort,
  toolCallId: string,
  content: string | Buffer,
  title: string,
  totalBytes: number,
  truncatedAtSource: boolean,
) {
  if (!capabilities.artifactSink) throw new Error("Durable Artifact sink is required for oversized tool output");
  const attempt = currentAttemptOrdinal(capabilities);
  if (attempt === undefined) throw new Error("Run not found");
  const artifactId = safeArtifactId(`${capabilities.runId}:${attempt}:${toolCallId}:output`);
  const stored = await capabilities.artifactSink.write({
    runId: capabilities.runId, artifactId, title, kind: "tool-output", content,
    totalBytes, truncatedAtSource, mediaType: "text/plain; charset=utf-8",
  });
  capabilities.addArtifact({ id: artifactId, title, kind: "tool-output", content: "", uri: stored.uri });
  return stored;
}

export async function durableTextResult(
  capabilities: ToolCapabilityApplicationPort,
  toolCallId: string,
  text: string,
  details: Record<string, unknown> = {},
  title = "Tool output",
  sourceTotalBytes = Buffer.byteLength(text),
  truncatedAtSource = false,
): Promise<RuntimeToolResult<Record<string, unknown>>> {
  const shown = previewText(text);
  if (sourceTotalBytes <= MAX_OUTPUT && !truncatedAtSource) return {
    content: [{ type: "text", text: shown }],
    details: { ...details, totalBytes: sourceTotalBytes, shownBytes: Buffer.byteLength(shown), outputDiscardedBytes: 0 },
  };
  const stored = await persistToolOutputArtifact(capabilities, toolCallId, text, title, sourceTotalBytes, truncatedAtSource);
  capabilities.publish("tool.output.spilled", {
    toolCallId, artifactId: stored.artifactId, totalBytes: sourceTotalBytes,
    shownBytes: Buffer.byteLength(shown), storedBytes: stored.storedBytes, sha256: stored.sha256,
    truncatedAtSource: stored.truncatedAtSource, outputDiscardedBytes: Math.max(0, sourceTotalBytes - stored.storedBytes),
  });
  return {
    content: [{ type: "text", text: shown }],
    details: {
      ...details, artifactId: stored.artifactId, artifactUri: stored.uri, sha256: stored.sha256,
      totalBytes: sourceTotalBytes, storedBytes: stored.storedBytes, shownBytes: Buffer.byteLength(shown),
      truncatedAtSource: stored.truncatedAtSource, outputDiscardedBytes: Math.max(0, sourceTotalBytes - stored.storedBytes),
    },
  };
}

/** Verification and read-only commands observe state; they do not invalidate prior receipts. */
export function bashInvalidatesChecks(command: string) {
  const source = command.trim();
  if (!source) return false;
  if (/(?:^|\s)(?:>|>>|tee\b|sed\s+-i\b)|\b(?:git\s+(?:add|commit|push|pull|merge|rebase|checkout|switch|restore|reset|clean)|npm\s+(?:install|uninstall|publish)|pnpm\s+(?:add|remove|install)|yarn\s+(?:add|remove|install)|rm|mv|cp|mkdir|touch|chmod|chown)\b/i.test(source)) return true;
  const shellPrefix = /^(?:(?:cd\s+(?:'[^']*'|"[^"]*"|[^;&|]+?)\s*&&\s*)|(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)\s+))*/i;
  const observation = /^(?:git\s+(?:status|diff|log|show|rev-parse|branch\s+--show-current)\b|npm\s+(?:test\b|run\s+(?:test|lint|check|typecheck)\b)|pnpm\s+(?:test\b|run\s+(?:test|lint|check|typecheck)\b)|yarn\s+(?:test\b|run\s+(?:test|lint|check|typecheck)\b)|npx\s+(?:vitest|eslint|tsc\s+--noEmit)\b|(?:vitest|pytest|eslint)\b|python(?:3)?\s+-m\s+pytest\b|go\s+test\b|cargo\s+(?:test|check|clippy)\b|tsc\s+--noEmit\b|rg\b|grep\b|ls\b|find\b|cat\b|head\b|tail\b|wc\b|pwd\b|sed\s+-n\b)/i;
  const stages = source.replace(shellPrefix, "").split(/(?:&&|;|\|\||\n)/).map((stage) => stage.trim()).filter(Boolean);
  return stages.some((stage) => !observation.test(stage));
}
