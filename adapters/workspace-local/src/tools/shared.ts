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
  inputRedirect: boolean;
  outputRedirect: boolean;
  substitution: boolean;
}

function parseShellStages(command: string): ParsedShellStage[] {
  const stages: ParsedShellStage[] = [];
  let words: string[] = [];
  let word = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let inputRedirect = false;
  let outputRedirect = false;
  let substitution = false;
  const finishWord = () => {
    if (word) words.push(word);
    word = "";
  };
  const finishStage = () => {
    finishWord();
    if (words.length || inputRedirect || outputRedirect || substitution) stages.push({ words, inputRedirect, outputRedirect, substitution });
    words = [];
    inputRedirect = false;
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
    if (character === "<") {
      inputRedirect = true;
      finishWord();
      while (command[index + 1] === "<") index += 1;
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

function hasCommandEnvironment(words: readonly string[]): boolean {
  let assignments = 0;
  while (assignments < words.length && assignment(words[assignments]!)) assignments += 1;
  return assignments > 0 && assignments < words.length;
}

function sedScriptIsObservation(script: string): boolean {
  return script.split(";").every((statement) => /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?)?[pq=]$/.test(statement.trim()));
}

function sedIsObservation(args: string[]): boolean {
  let quiet = false;
  const scripts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (["-n", "--quiet", "--silent", "-E", "-r", "--regexp-extended", "-s", "--separate", "-u", "--unbuffered", "-z", "--null-data"].includes(argument)) {
      quiet ||= argument === "-n" || argument === "--quiet" || argument === "--silent";
      continue;
    }
    if (argument === "-e" || argument === "--expression") {
      const script = args[index + 1];
      if (script === undefined) return false;
      scripts.push(script);
      index += 1;
      continue;
    }
    if (argument.startsWith("--expression=")) {
      scripts.push(argument.slice("--expression=".length));
      continue;
    }
    if (argument.startsWith("-e") && argument.length > 2) {
      scripts.push(argument.slice(2));
      continue;
    }
    if (argument.startsWith("-")) return false;
    if (!scripts.length) scripts.push(argument);
  }
  return quiet && scripts.length > 0 && scripts.every(sedScriptIsObservation);
}

function hasAnyOption(args: string[], options: readonly string[]): boolean {
  return args.some((argument) => options.some((option) => argument.toLowerCase() === option || argument.toLowerCase().startsWith(`${option}=`)));
}

function isFileObservation(words: string[]): boolean {
  const executable = executableName(words[0]);
  const args = words.slice(1);
  if (["echo", "printf", "test", "[", "grep", "ls", "cat", "head", "tail", "wc", "pwd"].includes(executable)) return true;
  if (executable === "rg") return !hasAnyOption(args, ["--pre"]);
  if (executable === "cd") return true;
  if (executable === "find") return !args.some((argument) => [
    "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls",
  ].includes(argument.toLowerCase()));
  if (executable === "sed") return sedIsObservation(args);
  if (executable === "git") {
    const subcommand = args[0]?.toLowerCase();
    if (hasAnyOption(args, ["--ext-diff", "--textconv", "--output"])) return false;
    return ["status", "diff", "log", "show", "rev-parse"].includes(subcommand ?? "")
      || (subcommand === "branch" && args[1] === "--show-current");
  }
  return false;
}

function isWorkspaceCodeExecution(words: string[]): boolean {
  const executable = executableName(words[0]);
  const args = words.slice(1);
  if (["npm", "pnpm", "yarn"].includes(executable)) {
    return args[0]?.toLowerCase() === "test"
      || (executable !== "npm" && ["lint", "check", "typecheck"].includes(args[0]?.toLowerCase() ?? ""))
      || (args[0]?.toLowerCase() === "run" && ["test", "lint", "check", "typecheck"].includes(args[1]?.toLowerCase() ?? ""));
  }
  if (executable === "npx") {
    const invoked = executableName(args[0]);
    return invoked === "vitest" || invoked === "eslint" || (invoked === "tsc" && args.some((argument) => argument.toLowerCase() === "--noemit"));
  }
  if (["vitest", "pytest", "eslint"].includes(executable)) return true;
  if (/^python(?:3)?$/.test(executable)) return args[0] === "-m" && args[1]?.toLowerCase() === "pytest";
  if (executable === "go") return args[0]?.toLowerCase() === "test";
  if (executable === "cargo") return ["test", "check", "clippy"].includes(args[0]?.toLowerCase() ?? "");
  if (executable === "tsc") return args.some((argument) => argument.toLowerCase() === "--noemit");
  return false;
}

export type BashCommandEffect = "read_only" | "code_execution" | "mutation_or_external";

/** Classify the strongest shell stage without pretending workspace code is a file observation. */
export function bashCommandEffect(command: string): BashCommandEffect {
  const variables = new Map<string, string>();
  let effect: BashCommandEffect = "read_only";
  for (const stage of parseShellStages(command.trim())) {
    const environment = hasCommandEnvironment(stage.words);
    const words = commandWords(stage, variables);
    if (!words.length) continue;
    if (stage.inputRedirect || stage.outputRedirect || stage.substitution || environment) return "mutation_or_external";
    if (isFileObservation(words)) continue;
    if (isWorkspaceCodeExecution(words)) effect = "code_execution";
    else return "mutation_or_external";
  }
  return effect;
}

/** Verification and read-only commands observe state; they do not invalidate prior receipts. */
export function bashInvalidatesChecks(command: string) {
  return bashCommandEffect(command) !== "read_only";
}

/**
 * Generic Bash is not filesystem- or network-sandboxed. Only the small command
 * grammar proven to be a workspace-relative observation can inherit ordinary
 * TaskRun authority; every unknown or externally addressed command requires a
 * current-Attempt explicit approval before dispatch.
 */
export function bashRequiresExplicitApproval(command: string) {
  const variables = new Map<string, string>();
  return parseShellStages(command.trim()).some((stage) => {
    const environment = hasCommandEnvironment(stage.words);
    const words = commandWords(stage, variables);
    if (!words.length) return false;
    if (stage.inputRedirect || stage.outputRedirect || stage.substitution || environment) return true;
    if (!isFileObservation(words)) return true;
    if (words.slice(1).some((word) => {
      const value = word.trim();
      return value.startsWith("/")
        || value.startsWith("~")
        || value.includes("=/")
        || /(^|\/)\.\.(\/|$)/.test(value)
        || /[$`]/.test(value);
    })) return true;
    const executable = executableName(words[0]);
    const args = words.slice(1);
    if (["echo", "printf", "pwd"].includes(executable)) return false;
    if (executable === "rg") {
      if (hasAnyOption(args, ["--pre", "--follow"])
        || args.some((argument) => /^-[^-]*L/.test(argument))) return true;
      // Avoid guessing which following operand belongs to an option. `--x=y`
      // forms remain analyzable; separated option values require approval.
      if (args.some((argument) => [
        "-e", "--regexp", "-f", "--file", "-g", "--glob", "--iglob",
        "-t", "--type", "-T", "--type-not", "--type-add", "--type-clear",
        "-j", "--threads", "-m", "--max-count", "-A", "--after-context",
        "-B", "--before-context", "-C", "--context", "--max-depth",
        "--max-filesize", "--path-separator", "--sort", "--sortr",
      ].includes(argument))) return true;
      const positional = args.filter((argument) => !argument.startsWith("-") && argument !== "--");
      const paths = hasAnyOption(args, ["--files"]) ? positional : positional.slice(1);
      return paths.some((argument) => argument !== ".");
    }
    if (executable === "ls") {
      if (hasAnyOption(args, ["--dereference"]) || args.some((argument) => /^-[^-]*L/.test(argument))) return true;
      return args.filter((argument) => !argument.startsWith("-") && argument !== "--")
        .some((argument) => argument !== ".");
    }
    if (executable === "find") {
      if (args.some((argument) => ["-H", "-L"].includes(argument))) return true;
      const expressionIndex = args.findIndex((argument) => argument.startsWith("-") || argument === "(" || argument === "!");
      const roots = args.slice(0, expressionIndex < 0 ? args.length : expressionIndex);
      return roots.some((argument) => argument !== ".");
    }
    // Generic path-reading commands (including cat/grep/head/tail/sed), git,
    // test, and cd can follow a workspace symlink or execute repository/user
    // configuration. Their lexical path is not a containment proof.
    return true;
  });
}

function shortOptionIncludes(args: string[], option: string): boolean {
  return args.some((argument) => /^-[^-]+$/.test(argument) && argument.slice(1).toLowerCase().includes(option));
}

export const HOSTING_CORE_LIFECYCLE_BLOCK_REASON = "Stopping or restarting the hosting TAgent Core through Bash would bypass the durable Generation handoff; use core_generation_activate instead";

const coreServiceNames = new Set(["tagent-core", "tagent-core.service"]);
const systemctlLifecycleActions = new Set(["stop", "restart", "try-restart", "reload-or-restart", "reload-or-try-restart", "kill"]);
const serviceLifecycleActions = new Set(["stop", "restart", "try-restart", "force-reload", "condrestart"]);
const wrapperOptionsWithValue = new Set([
  "-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt",
  "-c", "--close-from", "-r", "--chroot", "-d", "--chdir", "-t", "--command-timeout",
]);
const envOptionsWithValue = new Set(["-u", "--unset", "-c", "--chdir", "-s", "--split-string"]);

function unwrapLifecycleCommand(input: string[]): string[] {
  let words = [...input];
  for (let depth = 0; depth < 6 && words.length; depth += 1) {
    const executable = executableName(words[0]);
    if (["command", "exec", "nohup"].includes(executable)) {
      words = words.slice(1);
      continue;
    }
    if (executable !== "sudo" && executable !== "env") return words;
    const optionsWithValue = executable === "sudo" ? wrapperOptionsWithValue : envOptionsWithValue;
    let index = 1;
    while (index < words.length) {
      const value = words[index]!;
      if (value === "--") { index += 1; break; }
      if (assignment(value)) { index += 1; continue; }
      if (!value.startsWith("-")) break;
      const option = value.split("=", 1)[0]!.toLowerCase();
      index += !value.includes("=") && optionsWithValue.has(option) ? 2 : 1;
    }
    words = words.slice(index);
  }
  return words;
}

function isCoreService(value: string | undefined) {
  return coreServiceNames.has((value ?? "").toLowerCase());
}

function systemctlTargetsLocalSystem(args: string[]) {
  return !args.some((argument) => {
    const option = argument.toLowerCase();
    return ["--user", "--global", "-h", "--host", "-m", "--machine", "--root", "--image"].includes(option)
      || /^(?:--host|--machine|--root|--image)=/.test(option)
      || /^-[hm].+/.test(option);
  });
}

function nestedShellCommand(args: string[]): string | undefined {
  for (let index = 0; index < args.length - 1; index += 1) {
    const option = args[index]!;
    if (/^-[^-]*c[^-]*$/i.test(option)) return args[index + 1];
  }
  return undefined;
}

function commandTargetsHostingCore(command: string, depth: number): boolean {
  const variables = new Map<string, string>();
  return parseShellStages(command).some((stage) => {
    const words = unwrapLifecycleCommand(commandWords(stage, variables));
    const executable = executableName(words[0]);
    const args = words.slice(1);
    if (!executable) return false;
    if (executable === "systemctl") {
      if (!systemctlTargetsLocalSystem(args)) return false;
      const normalized = args.map((argument) => argument.toLowerCase());
      const actionIndex = normalized.findIndex((argument) => systemctlLifecycleActions.has(argument)
        || (["disable", "mask"].includes(argument) && normalized.includes("--now")));
      return actionIndex >= 0 && normalized.slice(actionIndex + 1).some(isCoreService);
    }
    if (executable === "service") {
      return isCoreService(args[0]) && serviceLifecycleActions.has(args[1]?.toLowerCase() ?? "");
    }
    const executablePath = (words[0] ?? "").replaceAll("\\", "/").toLowerCase();
    if (isCoreService(executable) && executablePath === "/etc/init.d/tagent-core") {
      return serviceLifecycleActions.has(args[0]?.toLowerCase() ?? "");
    }
    if (depth < 3 && ["bash", "sh", "dash", "zsh"].includes(executable)) {
      const nested = nestedShellCommand(args);
      if (nested && commandTargetsHostingCore(nested, depth + 1)) return true;
    }
    if (depth < 3 && stage.substitution) {
      const source = words.join(" ");
      for (const match of source.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
        if (commandTargetsHostingCore(match[1] ?? match[2] ?? "", depth + 1)) return true;
      }
    }
    return false;
  });
}

/** Narrow guard for lifecycle actions that would terminate the Bash-hosting Core Generation. */
export function bashCommandTargetsHostingCore(command: string): boolean {
  return commandTargetsHostingCore(command, 0);
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
