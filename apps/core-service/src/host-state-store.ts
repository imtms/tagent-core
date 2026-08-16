import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const RELEASE_ID = /^[0-9a-f]{40}$/;

export type CoreHostActivationPhase =
  | "validating"
  | "draining"
  | "starting"
  | "committed"
  | "rolled_back"
  | "failed";

export interface CoreHostActivationState {
  readonly requestId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly previousRelease: string;
  readonly targetRelease: string;
  readonly generationId: string;
  readonly phase: CoreHostActivationPhase;
  readonly updatedAt: number;
  readonly error?: string;
}

export interface CoreHostDurableState {
  readonly schema: "tagent-core/host-state-v1";
  readonly crashTimestamps: readonly number[];
  readonly activation: CoreHostActivationState | null;
}

export function initialCoreHostState(): CoreHostDurableState {
  return { schema: "tagent-core/host-state-v1", crashTimestamps: [], activation: null };
}

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

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function safeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value as number;
}

function parseActivationState(value: unknown): CoreHostActivationState {
  const activation = record(value, "Core Host activation state");
  const expected = activation.error === undefined
    ? ["requestId", "runId", "operationId", "previousRelease", "targetRelease", "generationId", "phase", "updatedAt"]
    : ["requestId", "runId", "operationId", "previousRelease", "targetRelease", "generationId", "phase", "updatedAt", "error"];
  exactKeys(activation, expected, "Core Host activation state");
  const phase = text(activation.phase, "Core Host activation phase") as CoreHostActivationPhase;
  if (!new Set<CoreHostActivationPhase>(["validating", "draining", "starting", "committed", "rolled_back", "failed"]).has(phase)) {
    throw new TypeError(`Core Host activation phase ${phase} is unsupported`);
  }
  const previousRelease = text(activation.previousRelease, "Core Host previous release");
  const targetRelease = text(activation.targetRelease, "Core Host target release");
  if (!RELEASE_ID.test(previousRelease) || !RELEASE_ID.test(targetRelease)) {
    throw new TypeError("Core Host activation releases must be full lowercase Git commits");
  }
  return {
    requestId: text(activation.requestId, "Core Host activation requestId"),
    runId: text(activation.runId, "Core Host activation runId"),
    operationId: text(activation.operationId, "Core Host activation operationId"),
    previousRelease,
    targetRelease,
    generationId: text(activation.generationId, "Core Host activation generationId"),
    phase,
    updatedAt: safeInteger(activation.updatedAt, "Core Host activation updatedAt"),
    ...(activation.error === undefined ? {} : { error: text(activation.error, "Core Host activation error") }),
  };
}

export class CoreHostStateStore {
  readonly path: string;

  constructor(private readonly runtimeDirectory: string) {
    this.path = path.join(runtimeDirectory, "activation.json");
  }

  async read(): Promise<CoreHostDurableState> {
    try {
      const parsed = record(JSON.parse(await readFile(this.path, "utf8")), "Core Host state");
      exactKeys(parsed, ["schema", "crashTimestamps", "activation"], "Core Host state");
      if (parsed.schema !== "tagent-core/host-state-v1" || !Array.isArray(parsed.crashTimestamps)) {
        throw new Error("Core Host state schema is unsupported");
      }
      return {
        schema: "tagent-core/host-state-v1",
        crashTimestamps: parsed.crashTimestamps.map((item) => safeInteger(item, "Core Host crash timestamp")),
        activation: parsed.activation === null ? null : parseActivationState(parsed.activation),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialCoreHostState();
      throw error;
    }
  }

  async write(state: CoreHostDurableState): Promise<void> {
    await mkdir(this.runtimeDirectory, { recursive: true });
    const temporary = path.join(this.runtimeDirectory, `.activation.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.path);
      const directory = await open(this.runtimeDirectory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
