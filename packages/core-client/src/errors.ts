import type { ErrorCategory } from "@tagent/abi";

export type CoreClientErrorCategory = ErrorCategory | "network" | "protocol" | "unknown";

export interface CoreClientErrorInit {
  cause?: unknown;
  category?: CoreClientErrorCategory;
  code: string;
  details?: Record<string, unknown>;
  message: string;
  method: string;
  requestId?: string;
  retryable?: boolean;
  status: number;
  url: string;
}

export interface CoreClientErrorJson {
  category: CoreClientErrorCategory;
  code: string;
  details: Record<string, unknown>;
  message: string;
  method: string;
  requestId: string;
  retryable: boolean;
  status: number;
  url: string;
}

export class CoreClientError extends Error {
  readonly category: CoreClientErrorCategory;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly method: string;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly url: string;

  constructor(init: CoreClientErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "CoreClientError";
    this.category = init.category ?? "unknown";
    this.code = init.code;
    this.details = init.details ?? {};
    this.method = init.method;
    this.requestId = init.requestId ?? "";
    this.retryable = init.retryable ?? (init.status === 429 || init.status >= 500);
    this.status = init.status;
    this.url = init.url;
  }

  toJSON(): CoreClientErrorJson {
    return {
      category: this.category,
      code: this.code,
      details: this.details,
      message: this.message,
      method: this.method,
      requestId: this.requestId,
      retryable: this.retryable,
      status: this.status,
      url: this.url,
    };
  }
}

export function protocolError(
  method: string,
  url: string,
  message: string,
  requestId = "",
  details: Record<string, unknown> = {},
  cause?: unknown,
): CoreClientError {
  return new CoreClientError({
    cause,
    category: "protocol",
    code: "client.protocol_mismatch",
    details,
    message,
    method,
    requestId,
    retryable: false,
    status: 0,
    url,
  });
}

export function networkError(method: string, url: string, cause: unknown): CoreClientError {
  return new CoreClientError({
    cause,
    category: "network",
    code: "client.network_error",
    details: { cause: cause instanceof Error ? cause.message : String(cause) },
    message: `TAgent Core request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    method,
    retryable: true,
    status: 0,
    url,
  });
}

export function errorCategory(value: unknown, status: number): CoreClientErrorCategory {
  if (value === "validation" || value === "unauthenticated" || value === "permission_denied" || value === "not_found"
    || value === "conflict" || value === "rate_limited" || value === "unavailable" || value === "internal") return value;
  if (status === 400 || status === 422) return "validation";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "permission_denied";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  if (status >= 500) return "internal";
  return "unknown";
}
