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
  signal: AbortSignal,
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
  }, signal);
  capabilities.addArtifact({ id: artifactId, title, kind: "tool-output", content: "", uri: stored.uri });
  return stored;
}

export async function durableTextResult(
  capabilities: ToolCapabilityApplicationPort,
  signal: AbortSignal,
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
  const stored = await persistToolOutputArtifact(capabilities, signal, toolCallId, text, title, sourceTotalBytes, truncatedAtSource);
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

interface ParsedShellStage {
  words: string[];
  outputRedirect: boolean;
  substitution: boolean;
}

function parseShellStages(command: string): ParsedShellStage[] {
  const stages: ParsedShellStage[] = [];
  let words: string[] = [];
  let word = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let outputRedirect = false;
  let substitution = false;
  const finishWord = () => {
    if (word) words.push(word);
    word = "";
  };
  const finishStage = () => {
    finishWord();
    if (words.length || outputRedirect || substitution) stages.push({ words, outputRedirect, substitution });
    words = [];
    outputRedirect = false;
    substitution = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else word += character;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = undefined;
      else {
        if ((character === "$" && command[index + 1] === "(") || character === "`") substitution = true;
        word += character;
      }
      continue;
    }
    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    if ((character === "$" && command[index + 1] === "(") || character === "`") substitution = true;
    if (/\s/.test(character)) {
      if (character === "\n") finishStage();
      else finishWord();
      continue;
    }
    if (character === ">") {
      outputRedirect = true;
      finishWord();
      if (command[index + 1] === ">") index += 1;
      continue;
    }
    if ([";", "|", "&", "(", ")", "{", "}"].includes(character)) {
      finishStage();
      if ((character === "|" || character === "&") && command[index + 1] === character) index += 1;
      continue;
    }
    word += character;
  }
  if (escaped) word += "\\";
  finishStage();
  return stages;
}

function assignment(word: string): { name: string; value: string } | undefined {
  const separator = word.indexOf("=");
  if (separator < 1) return undefined;
  const name = word.slice(0, separator);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
  return { name, value: word.slice(separator + 1) };
}

function commandWords(stage: ParsedShellStage, variables: Map<string, string>): string[] {
  const words = [...stage.words];
  while (words.length) {
    const parsed = assignment(words[0]!);
    if (!parsed) break;
    variables.set(parsed.name, parsed.value);
    words.shift();
  }
  while (words[0]?.toLowerCase() === "command") words.shift();
  const reference = words[0]?.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/);
  if (reference) words[0] = variables.get(reference[1] ?? reference[2]!) ?? words[0]!;
  return words;
}

function executableName(word: string | undefined): string {
  return (word ?? "").replaceAll("\\", "/").split("/").at(-1)!.toLowerCase();
}

function includesMutationFlag(args: string[]): boolean {
  return args.some((argument) => /^(?:-u|--update(?:snapshot)?|--update-snapshot|--snapshot-update)(?:=|$)/i.test(argument)
    || /^(?:--fix|--write)(?:=|$)/i.test(argument));
}

function isObservation(words: string[]): boolean {
  const executable = executableName(words[0]);
  const args = words.slice(1);
  if (["echo", "printf", "test", "[", "rg", "grep", "ls", "cat", "head", "tail", "wc", "pwd"].includes(executable)) return true;
  if (executable === "cd") return true;
  if (executable === "find") return !args.some((argument) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(argument.toLowerCase()));
  if (executable === "sed") return args.some((argument) => argument === "-n" || /^-[a-z]*n[a-z]*$/i.test(argument))
    && !args.some((argument) => argument === "-i" || argument.startsWith("-i") || argument.startsWith("--in-place"));
  if (executable === "git") {
    const subcommand = args[0]?.toLowerCase();
    return ["status", "diff", "log", "show", "rev-parse"].includes(subcommand ?? "")
      || (subcommand === "branch" && args[1] === "--show-current");
  }
  if (["npm", "pnpm", "yarn"].includes(executable)) {
    if (includesMutationFlag(args)) return false;
    return args[0]?.toLowerCase() === "test"
      || (args[0]?.toLowerCase() === "run" && ["test", "lint", "check", "typecheck"].includes(args[1]?.toLowerCase() ?? ""));
  }
  if (executable === "npx") {
    if (includesMutationFlag(args)) return false;
    const invoked = executableName(args[0]);
    return invoked === "vitest" || invoked === "eslint" || (invoked === "tsc" && args.some((argument) => argument.toLowerCase() === "--noemit"));
  }
  if (["vitest", "pytest", "eslint"].includes(executable)) return !includesMutationFlag(args);
  if (/^python(?:3)?$/.test(executable)) return args[0] === "-m" && args[1]?.toLowerCase() === "pytest" && !includesMutationFlag(args.slice(2));
  if (executable === "go") return args[0]?.toLowerCase() === "test";
  if (executable === "cargo") return ["test", "check", "clippy"].includes(args[0]?.toLowerCase() ?? "");
  if (executable === "tsc") return args.some((argument) => argument.toLowerCase() === "--noemit");
  return false;
}

/** Verification and read-only commands observe state; they do not invalidate prior receipts. */
export function bashInvalidatesChecks(command: string) {
  const variables = new Map<string, string>();
  return parseShellStages(command.trim()).some((stage) => {
    if (stage.outputRedirect || stage.substitution) return true;
    const words = commandWords(stage, variables);
    return words.length > 0 && !isObservation(words);
  });
}

function shortOptionIncludes(args: string[], option: string): boolean {
  return args.some((argument) => /^-[^-]+$/.test(argument) && argument.slice(1).toLowerCase().includes(option));
}

/** Best-effort guard for common catastrophic forms; authorization remains the primary boundary. */
export function bashCommandIsDestructive(command: string, depth = 0): boolean {
  const variables = new Map<string, string>();
  return parseShellStages(command).some((stage) => {
    const words = commandWords(stage, variables);
    const executable = executableName(words[0]);
    const args = words.slice(1);
    if (!executable) return false;
    if (executable === "mkfs" || executable.startsWith("mkfs.") || ["shutdown", "reboot", "poweroff"].includes(executable)) return true;
    if (executable === "rm") {
      const recursive = shortOptionIncludes(args, "r") || args.includes("--recursive");
      const forced = shortOptionIncludes(args, "f") || args.includes("--force");
      return recursive && forced;
    }
    if (executable === "git") {
      const subcommand = args[0]?.toLowerCase();
      if (subcommand === "reset") return args.includes("--hard");
      if (subcommand === "clean") return shortOptionIncludes(args.slice(1), "f") || args.slice(1).includes("--force");
    }
    if (depth < 2 && ["bash", "sh"].includes(executable) && args[0] === "-c" && args[1]) {
      return bashCommandIsDestructive(args[1], depth + 1);
    }
    return false;
  });
}
