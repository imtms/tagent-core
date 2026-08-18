import { createHash } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { ToolProvider } from "@tagent/execution/composition";
import type { RuntimeTool, RuntimeToolResult, RuntimeToolUpdateCallback, SubprocessPort, ToolCapabilityApplicationPort } from "@tagent/execution/ports";
import { readWorkspaceFile } from "../workspace-path.js";
import { bashCommandIsDestructive, bashInvalidatesChecks, durableTextResult, MAX_DURABLE_OUTPUT, MAX_OUTPUT, persistToolOutputArtifact, previewText, safeArtifactId, textResult } from "./shared.js";

const BashSchema = Type.Object({ command: Type.String(), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })) });

export class BashToolProvider implements ToolProvider {
  readonly id = "workspace.bash";
  constructor(
    private readonly capabilities: ToolCapabilityApplicationPort,
    private readonly workspace: string,
    private readonly subprocess: SubprocessPort,
  ) {}

  provideTools(): readonly RuntimeTool[] {
    const tool: RuntimeTool<Static<typeof BashSchema>, Record<string, unknown>> = {
      name: "bash", label: "Run command", description: "Run a non-interactive shell command in the workspace. A minimal best-effort guard blocks common catastrophic forms; it is not an operating-system sandbox.",
      parameters: BashSchema, executionMode: "sequential",
      policy: {
        operationType: "tool.bash",
        externalAction: true,
        workspaceAccess: (value) => bashInvalidatesChecks((value as Static<typeof BashSchema>).command) ? "mutation" : "read_only",
        invalidatesChecks: (value) => bashInvalidatesChecks((value as Static<typeof BashSchema>).command),
      },
      execute: (id, params, signal, onUpdate) => this.execute(id, params, signal, onUpdate),
    };
    return [tool];
  }

  private async execute(
    id: string,
    params: Static<typeof BashSchema>,
    signal: AbortSignal,
    onUpdate?: RuntimeToolUpdateCallback<Record<string, unknown>>,
  ): Promise<RuntimeToolResult<Record<string, unknown>>> {
    if (bashCommandIsDestructive(params.command)) {
      throw new Error("Command blocked by the minimal safety policy");
    }
    const chainedStages = (params.command.match(/(?:&&|;|\|\||\n)/g) ?? []).length + 1;
    if (chainedStages >= 3) this.capabilities.publish("tool.bash.composite", { toolCallId: id, chainedStages, recommendation: "Split build, test, deploy, restart, and polling into separately evidenced commands so a late timeout does not repeat earlier stages." });
    const stdoutChunks: Buffer[] = [], stderrChunks: Buffer[] = [];
    const captureRelative = `.tagent/tmp/${safeArtifactId(`${this.capabilities.runId}-${id}`)}.log`;
    const capturePath = path.join(this.workspace, captureRelative);
    let captureFile: Awaited<ReturnType<typeof open>> | undefined;
    let captureClosed = false;
    let stdoutBytes = 0, stderrBytes = 0, capturedOutputBytes = 0, sourceDroppedBytes = 0;
    let progressChunks: string[] = [];
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    const captureReady = mkdir(path.dirname(capturePath), { recursive: true }).then(() => open(capturePath, "w", 0o600)).then((file) => { captureFile = file; });
    let captureWrites = Promise.resolve();
    const flushProgress = () => {
      if (progressChunks.length) onUpdate?.(textResult(progressChunks.join(""), { stream: "combined" }));
      progressChunks = []; progressTimer = undefined;
    };
    const capture = (stream: "stdout" | "stderr", bytes: Uint8Array) => {
      const chunk = Buffer.from(bytes);
      const capturedBytesBefore = Math.min(stdoutBytes + stderrBytes, this.capabilities.artifactSink?.maxBytes ?? MAX_DURABLE_OUTPUT);
      if (stream === "stdout") stdoutBytes += chunk.length; else stderrBytes += chunk.length;
      const capturedChunk = chunk.subarray(0, Math.max(0, MAX_DURABLE_OUTPUT - capturedOutputBytes));
      if (capturedChunk.length) { (stream === "stdout" ? stdoutChunks : stderrChunks).push(capturedChunk); capturedOutputBytes += capturedChunk.length; }
      sourceDroppedBytes += Math.max(0, chunk.length - capturedChunk.length);
      const artifactChunk = chunk.subarray(0, Math.max(0, (this.capabilities.artifactSink?.maxBytes ?? MAX_DURABLE_OUTPUT) - capturedBytesBefore));
      captureWrites = captureWrites.then(async () => { await captureReady; if (artifactChunk.length) await captureFile!.write(artifactChunk); });
      progressChunks.push(chunk.toString("utf8"));
      if (!progressTimer) progressTimer = setTimeout(flushProgress, 250);
    };
    const timeoutSeconds = params.timeoutSeconds ?? 30;
    const timeoutController = new AbortController();
    const forwardAbort = () => timeoutController.abort(signal.reason);
    signal.addEventListener("abort", forwardAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; timeoutController.abort(new Error("timeout")); }, timeoutSeconds * 1000);
    try {
      const child = this.subprocess.spawn({
        argv: ["bash", "-lc", params.command], cwd: this.workspace, signal: timeoutController.signal,
        terminationGraceMs: 2_000,
        onStdout: (chunk) => capture("stdout", chunk), onStderr: (chunk) => capture("stderr", chunk),
      });
      const outcome = await child.done;
      clearTimeout(timer); if (progressTimer) clearTimeout(progressTimer); flushProgress();
      await captureReady; await captureWrites; await captureFile!.sync(); await captureFile!.close(); captureClosed = true;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8"), stderr = Buffer.concat(stderrChunks).toString("utf8");
      const combined = [stdout, stderr && `STDERR:\n${stderr}`].filter(Boolean).join("\n");
      const totalBytes = stdoutBytes + stderrBytes;
      let result: RuntimeToolResult<Record<string, unknown>>;
      if (totalBytes > MAX_OUTPUT || sourceDroppedBytes > 0) {
        const stored = await persistToolOutputArtifact(this.capabilities, signal, id, await readWorkspaceFile(this.workspace, captureRelative, signal).then((value) => value.buffer), `Command output: ${params.command.slice(0, 80)}`, totalBytes, totalBytes > (this.capabilities.artifactSink?.maxBytes ?? MAX_DURABLE_OUTPUT));
        const shown = previewText(combined || "Command completed with no output");
        this.capabilities.publish("tool.output.spilled", { toolCallId: id, artifactId: stored.artifactId, totalBytes, shownBytes: Buffer.byteLength(shown), storedBytes: stored.storedBytes, sha256: stored.sha256, truncatedAtSource: stored.truncatedAtSource, outputDiscardedBytes: Math.max(0, totalBytes - stored.storedBytes) });
        result = { content: [{ type: "text", text: shown }], details: { exitCode: outcome.exitCode, stdoutBytes, stderrBytes, capturedBytes: capturedOutputBytes, captureTruncated: stored.truncatedAtSource, artifactId: stored.artifactId, artifactUri: stored.uri, sha256: stored.sha256, totalBytes, storedBytes: stored.storedBytes, shownBytes: Buffer.byteLength(shown), truncatedAtSource: stored.truncatedAtSource, outputDiscardedBytes: Math.max(0, totalBytes - stored.storedBytes) } };
      } else result = await durableTextResult(this.capabilities, signal, id, combined || "Command completed with no output", { exitCode: outcome.exitCode, stdoutBytes, stderrBytes, capturedBytes: totalBytes, captureTruncated: false }, `Command output: ${params.command.slice(0, 80)}`, totalBytes, false);
      await unlink(capturePath).catch(() => undefined);
      const artifact = typeof result.details.artifactId === "string" ? `; artifactId=${result.details.artifactId}` : "";
      const output = (result.content[0] as { text: string }).text;
      if (signal.aborted) throw new Error(`Command aborted${artifact}`);
      if (timedOut) {
        this.capabilities.publish("tool.bash.timed_out", { toolCallId: id, timeoutSeconds, commandHash: createHash("sha256").update(params.command).digest("hex"), artifactId: result.details.artifactId ?? null, stdoutBytes, stderrBytes });
        throw new Error(`Command timed out after ${timeoutSeconds}s${artifact}. Inspect the preserved output before retrying; do not rerun the identical command unchanged.\n${output}`);
      }
      if (outcome.signal) throw new Error(`Command terminated by ${outcome.signal}${artifact}\n${output}`);
      if (outcome.exitCode !== 0) throw new Error(`Command exited with code ${outcome.exitCode}${artifact}\n${output}`);
      return result;
    } finally {
      clearTimeout(timer);
      if (progressTimer) clearTimeout(progressTimer);
      signal.removeEventListener("abort", forwardAbort);
      await captureReady.catch(() => undefined);
      await captureWrites.catch(() => undefined);
      if (captureFile && !captureClosed) await captureFile.close().catch(() => undefined);
      await unlink(capturePath).catch(() => undefined);
    }
  }
}
