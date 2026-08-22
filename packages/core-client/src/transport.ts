import { loadCoreAbi } from "./abi-loader.js";
import { CoreClientError, errorCategory, networkError, protocolError } from "./errors.js";
import { normalizeRetry, retryDelay, waitForRetry, type CoreRetryOptions, type NormalizedRetryOptions } from "./retry.js";
import { readSse, type SseMessage } from "./sse.js";

export type CoreFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface CoreClientOptions {
  baseUrl?: string;
  bearerToken?: string;
  fetch?: CoreFetch;
  headers?: RequestInit["headers"];
  requestIdFactory?: () => string;
  retry?: CoreRetryOptions;
  /** Default request timeout. Omit to preserve the platform fetch timeout. */
  timeoutMs?: number;
}

export interface CoreRequestOptions<T> extends Omit<RequestInit, "body" | "headers"> {
  body?: RequestInit["body"];
  decode?: (payload: unknown) => T | Promise<T>;
  headers?: RequestInit["headers"];
  idempotent?: boolean;
  idempotencyKey?: string;
  json?: unknown;
  requestId?: string;
  retry?: false | CoreRetryOptions;
  /** Overrides the client default for this request. */
  timeoutMs?: number;
}

/** Cross-client controls that do not change a typed endpoint's payload. */
export interface CoreCallOptions {
  headers?: RequestInit["headers"];
  requestId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CoreSseOptions<T> {
  decode: (message: SseMessage) => T;
  headers?: RequestInit["headers"];
  onError?: (error: CoreClientError) => void;
  onMessage: (message: T) => void | Promise<void>;
  onOpen?: (response: Response) => void;
  requestId?: string;
  signal?: AbortSignal;
}

export interface CoreSseSubscription {
  close: () => void;
  completed: Promise<void>;
}

function defaultRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2).padEnd(12, "0").slice(0, 12);
  return `request-${timestamp}-${random}`;
}

function resolveUrl(baseUrl: string, path: string): string {
  if (!baseUrl || /^[a-z][a-z\d+.-]*:/i.test(path)) return path;
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

async function responseError(payload: unknown, response: Response, method: string, url: string): Promise<CoreClientError> {
  const abi = await loadCoreAbi();
  let envelope;
  try {
    envelope = abi.decodeAbi(abi.ErrorEnvelopeSchema, payload);
  } catch (error) {
    throw protocolError(method, url, `TAgent Core error envelope validation failed: ${error instanceof Error ? error.message : String(error)}`, response.headers.get("x-request-id") ?? "", { payload }, error);
  }
  return new CoreClientError({
    category: errorCategory(undefined, response.status),
    code: envelope.error.code,
    details: envelope.error.details,
    message: envelope.error.message,
    method,
    requestId: envelope.error.requestId,
    retryable: envelope.error.retryable,
    status: response.status,
    url,
  });
}

export class CoreTransport {
  private readonly baseUrl: string;
  private readonly bearerToken: string;
  private readonly defaultHeaders: Headers;
  private readonly fetchImplementation: CoreFetch;
  private readonly requestIdFactory: () => string;
  private readonly retryOptions: NormalizedRetryOptions;
  private readonly timeoutMs: number | undefined;

  constructor(options: CoreClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "";
    this.bearerToken = options.bearerToken ?? "";
    this.defaultHeaders = new Headers(options.headers);
    this.fetchImplementation = options.fetch ?? ((input, init) => fetch(input, init));
    this.requestIdFactory = options.requestIdFactory ?? defaultRequestId;
    this.retryOptions = normalizeRetry(options.retry);
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new TypeError("Core client timeoutMs must be a positive finite number");
    }
    this.timeoutMs = options.timeoutMs;
  }

  protected resolve(path: string): string {
    return resolveUrl(this.baseUrl, path);
  }

  protected queryString(values: Record<string, string | number | undefined>): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value));
    return query.size ? `?${query}` : "";
  }

  async request<T>(path: string, options: CoreRequestOptions<T> & { decode: (payload: unknown) => T | Promise<T> }): Promise<T>;
  async request(path: string, options?: CoreRequestOptions<unknown>): Promise<unknown>;
  async request<T>(path: string, options: CoreRequestOptions<T> = {}): Promise<T | unknown> {
    const method = (options.method ?? "GET").toUpperCase();
    const url = this.resolve(path);
    const headers = new Headers(this.defaultHeaders);
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    if (this.bearerToken && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${this.bearerToken}`);
    if (options.idempotencyKey) {
      const abi = await loadCoreAbi();
      try {
        abi.decodeAbi(abi.IdempotencyKeySchema, options.idempotencyKey);
      } catch (error) {
        throw protocolError(method, url, `Idempotency-Key validation failed: ${error instanceof Error ? error.message : String(error)}`, "", {}, error);
      }
    }
    if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);

    const requestId = options.requestId ?? this.requestIdFactory();
    const json = options.json;
    if (requestId) headers.set("X-Request-Id", requestId);
    if (json !== undefined && options.body != null) throw protocolError(method, url, "A Core request cannot specify both json and body", requestId);

    let body = options.body;
    if (json !== undefined) {
      body = JSON.stringify(json);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    }
    const {
      decode, idempotent: _idempotent, idempotencyKey: _idempotencyKey, json: _json,
      requestId: _requestId, retry: requestRetry, timeoutMs: requestTimeoutMs, ...requestInit
    } = options;
    const timeoutMs = requestTimeoutMs ?? this.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw protocolError(method, url, "TAgent Core request timeoutMs must be a positive finite number", requestId);
    }
    const timeoutSignal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    const signal = requestInit.signal && timeoutSignal
      ? AbortSignal.any([requestInit.signal, timeoutSignal])
      : requestInit.signal ?? timeoutSignal;
    const retry = requestRetry === false ? normalizeRetry({ maxAttempts: 1 }) : requestRetry ? normalizeRetry(requestRetry) : this.retryOptions;
    const retryableRequest = ["GET", "HEAD", "OPTIONS"].includes(method) || Boolean(options.idempotent || options.idempotencyKey);
    let response: Response | undefined;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      try {
        response = await this.fetchImplementation(url, { ...requestInit, body, headers, method, signal });
      } catch (error) {
        if (!retryableRequest || attempt === retry.maxAttempts) throw networkError(method, url, error);
        await waitForRetry(retryDelay(undefined, attempt, retry), signal);
        continue;
      }
      if (response.ok || !retryableRequest || !retry.statuses.has(response.status) || attempt === retry.maxAttempts) break;
      await response.body?.cancel().catch(() => undefined);
      await waitForRetry(retryDelay(response, attempt, retry), signal);
    }
    if (!response) throw networkError(method, url, "request did not produce a response");

    if (response.status === 204) {
      if (!decode) return undefined;
      try {
        return await decode(undefined);
      } catch (error) {
        throw protocolError(method, url, `TAgent Core response validation failed: ${error instanceof Error ? error.message : String(error)}`, response.headers.get("x-request-id") ?? "", {}, error);
      }
    }
    const contentType = response.headers.get("content-type") ?? "";
    const isJson = /(?:^|\s|;)application\/(?:[\w.+-]*\+)?json(?:\s|;|$)/i.test(contentType);
    const payload = isJson ? await response.json().catch(() => undefined) : await response.text().catch(() => "");
    if (!response.ok) throw await responseError(payload, response, method, url);
    if (!isJson) {
      throw protocolError(method, url, `TAgent Core protocol mismatch: expected JSON but received ${contentType || "an unknown content type"}`, response.headers.get("x-request-id") ?? "", { payload });
    }
    if (payload === undefined) throw protocolError(method, url, "TAgent Core returned invalid JSON", response.headers.get("x-request-id") ?? "");
    if (!decode) return payload;
    try {
      return await decode(payload);
    } catch (error) {
      throw protocolError(method, url, `TAgent Core response validation failed: ${error instanceof Error ? error.message : String(error)}`, response.headers.get("x-request-id") ?? "", {}, error);
    }
  }

  subscribeSse<T>(path: string, options: CoreSseOptions<T>): CoreSseSubscription {
    const controller = new AbortController();
    const url = this.resolve(path);
    const headers = new Headers(this.defaultHeaders);
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    headers.set("Accept", "text/event-stream");
    if (this.bearerToken && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${this.bearerToken}`);
    if (options.requestId) headers.set("X-Request-Id", options.requestId);
    const abort = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    const completed = (async (): Promise<void> => {
      try {
        let response: Response;
        try {
          response = await this.fetchImplementation(url, { headers, method: "GET", signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) return;
          throw networkError("GET", url, error);
        }
        if (!response.ok) {
          const contentType = response.headers.get("content-type") ?? "";
          const payload = contentType.includes("json") ? await response.json().catch(() => undefined) : await response.text().catch(() => "");
          throw await responseError(payload, response, "GET", url);
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("text/event-stream")) throw protocolError("GET", url, `TAgent Core protocol mismatch: expected text/event-stream but received ${contentType || "an unknown content type"}`);
        options.onOpen?.(response);
        await readSse(response, async (message) => options.onMessage(options.decode(message)));
      } catch (error) {
        if (controller.signal.aborted) return;
        const clientError = error instanceof CoreClientError ? error : protocolError("GET", url, error instanceof Error ? error.message : String(error), "", {}, error);
        options.onError?.(clientError);
        throw clientError;
      } finally {
        options.signal?.removeEventListener("abort", abort);
      }
    })();
    return { close: () => controller.abort(), completed };
  }
}

export function createCoreTransport(options: CoreClientOptions = {}): CoreTransport {
  return new CoreTransport(options);
}
