export interface CoreRetryOptions {
  baseDelayMs?: number;
  maxAttempts?: number;
  maxDelayMs?: number;
  statuses?: readonly number[];
}

export interface NormalizedRetryOptions {
  baseDelayMs: number;
  maxAttempts: number;
  maxDelayMs: number;
  statuses: ReadonlySet<number>;
}

const retryStatuses = [429, 502, 503, 504] as const;

export function normalizeRetry(options: CoreRetryOptions | undefined): NormalizedRetryOptions {
  const maxAttempts = Math.max(1, Math.floor(options?.maxAttempts ?? 1));
  const baseDelayMs = Math.max(0, Math.floor(options?.baseDelayMs ?? 250));
  const maxDelayMs = Math.max(baseDelayMs, Math.floor(options?.maxDelayMs ?? 5_000));
  return { baseDelayMs, maxAttempts, maxDelayMs, statuses: new Set(options?.statuses ?? retryStatuses) };
}

export function retryDelay(response: Response | undefined, attempt: number, options: NormalizedRetryOptions): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(options.maxDelayMs, Math.round(seconds * 1_000));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(options.maxDelayMs, Math.max(0, date - Date.now()));
  }
  return Math.min(options.maxDelayMs, options.baseDelayMs * (2 ** Math.max(0, attempt - 1)));
}

export function waitForRetry(delayMs: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted"));
  if (delayMs === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const complete = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(complete, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("Request aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
