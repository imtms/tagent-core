export const CORE_HOST_PROTOCOL_VERSION = 1 as const;
export const CORE_STATE_PROTOCOL = "tagent-core/state-0.8" as const;

const RELEASE_ID = /^[0-9a-f]{40}$/;
const MAX_IPC_BYTES = 32 * 1024;

export interface CoreHostActivationRequest {
  readonly type: "ACTIVATE";
  readonly protocolVersion: typeof CORE_HOST_PROTOCOL_VERSION;
  readonly generationId: string;
  readonly requestId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly expectedCurrent: string;
  readonly targetRelease: string;
}

export interface CoreHostReadyMessage {
  readonly type: "READY";
  readonly protocolVersion: typeof CORE_HOST_PROTOCOL_VERSION;
  readonly generationId: string;
  readonly releaseId: string;
  readonly stateProtocol: typeof CORE_STATE_PROTOCOL;
  readonly writerFence: number;
}

export interface CoreHostDrainedMessage {
  readonly type: "DRAINED";
  readonly protocolVersion: typeof CORE_HOST_PROTOCOL_VERSION;
  readonly generationId: string;
  readonly requestId: string;
  readonly writerFence: number;
}

export type GenerationToHostMessage =
  | CoreHostReadyMessage
  | CoreHostActivationRequest
  | CoreHostDrainedMessage;

export type HostToGenerationMessage =
  | {
      readonly type: "DRAIN";
      readonly protocolVersion: typeof CORE_HOST_PROTOCOL_VERSION;
      readonly generationId: string;
      readonly requestId: string;
      readonly deadlineMs: number;
    }
  | {
      readonly type: "ACTIVATION_RESULT";
      readonly protocolVersion: typeof CORE_HOST_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly status: "succeeded" | "rolled_back" | "failed" | "blocked";
      readonly activeRelease: string;
      readonly error?: string;
    };

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new TypeError(`${name} must contain exactly ${canonical.join(", ")}`);
  }
}

export function protocolText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function safeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value as number;
}

function positiveInteger(value: unknown, name: string): number {
  const integer = safeInteger(value, name);
  if (integer === 0) throw new TypeError(`${name} must be a positive safe integer`);
  return integer;
}

function fullReleaseId(value: unknown, name: string): string {
  const id = protocolText(value, name);
  if (!RELEASE_ID.test(id)) throw new TypeError(`${name} must be a full lowercase Git commit`);
  return id;
}

function generationReleaseId(value: unknown, name: string): string {
  const id = protocolText(value, name);
  if (id !== "development" && !RELEASE_ID.test(id)) {
    throw new TypeError(`${name} must be development or a full lowercase Git commit`);
  }
  return id;
}

function protocolRecord(value: unknown, name: string): Record<string, unknown> {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > MAX_IPC_BYTES) {
    throw new TypeError(`${name} is too large`);
  }
  return record(value, name);
}

export function parseGenerationToHostMessage(value: unknown): GenerationToHostMessage {
  const input = protocolRecord(value, "Generation IPC message");
  const type = protocolText(input.type, "Generation IPC type");
  if (input.protocolVersion !== CORE_HOST_PROTOCOL_VERSION) throw new TypeError("Generation IPC protocol is unsupported");
  if (type === "READY") {
    exactKeys(input, ["type", "protocolVersion", "generationId", "releaseId", "stateProtocol", "writerFence"], "READY");
    if (input.stateProtocol !== CORE_STATE_PROTOCOL) throw new TypeError("Generation state protocol is incompatible");
    return {
      type,
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      generationId: protocolText(input.generationId, "READY.generationId"),
      releaseId: generationReleaseId(input.releaseId, "READY.releaseId"),
      stateProtocol: CORE_STATE_PROTOCOL,
      writerFence: positiveInteger(input.writerFence, "READY.writerFence"),
    };
  }
  if (type === "ACTIVATE") {
    exactKeys(input, ["type", "protocolVersion", "generationId", "requestId", "runId", "operationId", "expectedCurrent", "targetRelease"], "ACTIVATE");
    const requestId = protocolText(input.requestId, "ACTIVATE.requestId");
    const operationId = protocolText(input.operationId, "ACTIVATE.operationId");
    if (requestId !== operationId) throw new TypeError("ACTIVATE requestId must equal operationId");
    const targetRelease = protocolText(input.targetRelease, "ACTIVATE.targetRelease");
    if (targetRelease !== "current" && !RELEASE_ID.test(targetRelease)) {
      throw new TypeError("ACTIVATE.targetRelease must be current or a full lowercase Git commit");
    }
    return {
      type,
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      generationId: protocolText(input.generationId, "ACTIVATE.generationId"),
      requestId,
      runId: protocolText(input.runId, "ACTIVATE.runId"),
      operationId,
      expectedCurrent: fullReleaseId(input.expectedCurrent, "ACTIVATE.expectedCurrent"),
      targetRelease,
    };
  }
  if (type === "DRAINED") {
    exactKeys(input, ["type", "protocolVersion", "generationId", "requestId", "writerFence"], "DRAINED");
    return {
      type,
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      generationId: protocolText(input.generationId, "DRAINED.generationId"),
      requestId: protocolText(input.requestId, "DRAINED.requestId"),
      writerFence: safeInteger(input.writerFence, "DRAINED.writerFence"),
    };
  }
  throw new TypeError(`Unknown Generation IPC message ${type}`);
}

export function parseHostToGenerationMessage(value: unknown): HostToGenerationMessage {
  const input = protocolRecord(value, "Host IPC message");
  const type = protocolText(input.type, "Host IPC type");
  if (input.protocolVersion !== CORE_HOST_PROTOCOL_VERSION) throw new TypeError("Host IPC protocol is unsupported");
  if (type === "DRAIN") {
    exactKeys(input, ["type", "protocolVersion", "generationId", "requestId", "deadlineMs"], "DRAIN");
    return {
      type,
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      generationId: protocolText(input.generationId, "DRAIN.generationId"),
      requestId: protocolText(input.requestId, "DRAIN.requestId"),
      deadlineMs: positiveInteger(input.deadlineMs, "DRAIN.deadlineMs"),
    };
  }
  if (type === "ACTIVATION_RESULT") {
    const expected = input.error === undefined
      ? ["type", "protocolVersion", "requestId", "status", "activeRelease"]
      : ["type", "protocolVersion", "requestId", "status", "activeRelease", "error"];
    exactKeys(input, expected, "ACTIVATION_RESULT");
    if (!new Set(["succeeded", "rolled_back", "failed", "blocked"]).has(String(input.status))) {
      throw new TypeError("ACTIVATION_RESULT.status is invalid");
    }
    return {
      type,
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      requestId: protocolText(input.requestId, "ACTIVATION_RESULT.requestId"),
      status: input.status as Extract<HostToGenerationMessage, { type: "ACTIVATION_RESULT" }>["status"],
      activeRelease: protocolText(input.activeRelease, "ACTIVATION_RESULT.activeRelease"),
      ...(input.error === undefined ? {} : { error: protocolText(input.error, "ACTIVATION_RESULT.error") }),
    };
  }
  throw new TypeError(`Unknown Host IPC message ${type}`);
}
