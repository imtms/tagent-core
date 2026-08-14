export const TOOL_ERROR_CODES = [
  "ABORTED_BEFORE_DISPATCH",
  "ABORTED",
  "TIMEOUT",
  "PATH_REJECTED",
  "STALE_STATE",
  "PRECONDITION_FAILED",
  "INVALID_ARGUMENT",
  "NOT_AUTHORIZED",
  "UNKNOWN",
] as const;

export type ToolErrorCode = typeof TOOL_ERROR_CODES[number];

/** Stable, transport-neutral metadata for one failed tool call. */
export interface StructuredToolError {
  name: string;
  code: ToolErrorCode;
  message: string;
}

export class ToolExecutionError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ToolExecutionError";
    this.code = code;
  }

  toJSON(): StructuredToolError {
    return { name: this.name, code: this.code, message: this.message };
  }
}

function sourceCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  return typeof error.code === "string" ? error.code.toUpperCase() : "";
}

function sourceName(error: unknown): string {
  if (!error || typeof error !== "object" || !("name" in error)) return "";
  return typeof error.name === "string" ? error.name : "";
}

function sourceMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toStructuredToolError(error: unknown): StructuredToolError | undefined {
  if (error instanceof ToolExecutionError) return error.toJSON();
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Partial<StructuredToolError>;
  return candidate.name === "ToolExecutionError"
    && TOOL_ERROR_CODES.includes(candidate.code as ToolErrorCode)
    && typeof candidate.message === "string"
    ? { name: candidate.name, code: candidate.code as ToolErrorCode, message: candidate.message }
    : undefined;
}

export function classifyToolError(
  error: unknown,
  options: { signal?: AbortSignal; beforeDispatch?: boolean; code?: ToolErrorCode } = {},
): ToolExecutionError {
  if (error instanceof ToolExecutionError) return error;
  const message = sourceMessage(error);
  if (options.code) return new ToolExecutionError(options.code, message, { cause: error });
  if (options.beforeDispatch) return new ToolExecutionError("ABORTED_BEFORE_DISPATCH", message, { cause: error });
  const code = sourceCode(error);
  const name = sourceName(error);
  if (options.signal?.aborted || code === "ABORT_ERR" || name === "AbortError") {
    return new ToolExecutionError("ABORTED", message, { cause: error });
  }
  if (code === "ETIMEDOUT" || code === "TIMEOUT" || name === "TimeoutError"
    || /(?:timed?\s*out|timeout|exceeded\s+\d+\s*ms)/i.test(message)) {
    return new ToolExecutionError("TIMEOUT", message, { cause: error });
  }
  if (code === "WORKSPACE_PATH_REJECTED" || name === "WorkspacePathError"
    && !["EACCES", "EPERM", "WORKSPACE_IO_ERROR"].includes(code)) {
    return new ToolExecutionError("PATH_REJECTED", message, { cause: error });
  }
  if (code === "WORKSPACE.EDIT_STALE") {
    return new ToolExecutionError("STALE_STATE", message, { cause: error });
  }
  if (code === "WORKSPACE.EDIT_PRECONDITION_FAILED") {
    return new ToolExecutionError("PRECONDITION_FAILED", message, { cause: error });
  }
  if (code === "WORKSPACE.EDIT_INVALID") {
    return new ToolExecutionError("INVALID_ARGUMENT", message, { cause: error });
  }
  if (["EACCES", "EPERM", "FORBIDDEN", "NOT_AUTHORIZED"].includes(code)
    || /(?:not authorized|not allowed|permission denied|approval guard|mutation guard)/i.test(message)) {
    return new ToolExecutionError("NOT_AUTHORIZED", message, { cause: error });
  }
  return new ToolExecutionError("UNKNOWN", message, { cause: error });
}

export function structuredToolErrorFromDetails(details: unknown): StructuredToolError | undefined {
  if (!details || typeof details !== "object" || !("error" in details)) return undefined;
  return toStructuredToolError((details as { error?: unknown }).error);
}
