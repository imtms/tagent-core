export const SENSITIVE_ENVIRONMENT_NAME = /KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL|AUTHORIZATION|COOKIE/i;

/** Build a fresh child environment without ambient credentials or TAgent-owned state. */
export function scrubbedParentEnvironment(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) =>
    value !== undefined
    && !SENSITIVE_ENVIRONMENT_NAME.test(name)
    && !name.toUpperCase().startsWith("TAGENT_")));
}

export interface SubprocessOutcome {
  exitCode: number | null;
  signal: string | null;
}

export interface SubprocessSpawnSpec {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  /** Explicit trusted overrides, merged after the scrubbed ambient base. */
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  /** Optional finite stdin body. Interactive input belongs behind a different capability. */
  readonly stdin?: string | Uint8Array;
  /** Caller-owned lifetime for this subprocess tree. */
  readonly signal: AbortSignal;
  readonly terminationGraceMs: number;
  readonly onStdout?: (chunk: Uint8Array) => void;
  readonly onStderr?: (chunk: Uint8Array) => void;
}

export interface SubprocessHandle {
  readonly pid: number;
  readonly done: Promise<SubprocessOutcome>;
  terminate(): void;
}

/** Execution-world-neutral managed subprocess seam. */
export interface SubprocessPort {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
  dispose?(): Promise<void> | void;
}
