import { decodeAbi, SuccessEnvelopeSchema } from "@tagent/abi";
import { createCoreTransport } from "@tagent/core-client";

const coreClient = createCoreTransport();
const configuredCoreOrigin = configuredOrigin(import.meta.env.VITE_TAGENT_CORE_ORIGIN);
const oidcTokenStorageKey = "tagent.oidc.access_token";

function configuredOrigin(value: string | undefined): string {
  const candidate = value?.trim();
  if (!candidate) return "";
  const parsed = new URL(candidate);
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)
    || parsed.origin === "null"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash) {
    throw new Error("VITE_TAGENT_CORE_ORIGIN must be an http(s) origin without credentials, path, query, or fragment");
  }
  return parsed.origin;
}

function oidcAccessToken(): string | undefined {
  try {
    return globalThis.sessionStorage?.getItem(oidcTokenStorageKey)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface AuthenticatedCoreRequestOptions {
  origin?: string;
  accessToken?: string;
}

export function authenticatedCoreRequest(
  pathname: string,
  init: RequestInit = {},
  options: AuthenticatedCoreRequestOptions = {},
): { url: string; init: RequestInit } {
  const origin = options.origin === undefined ? configuredCoreOrigin : configuredOrigin(options.origin);
  const accessToken = options.accessToken === undefined ? oidcAccessToken() : options.accessToken.trim();
  const headers = new Headers(init.headers);
  if (accessToken && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${accessToken}`);
  return {
    url: origin ? new URL(pathname, `${origin}/`).toString() : pathname,
    init: { ...init, credentials: "omit", headers },
  };
}

export async function authenticatedCoreFetch(
  pathname: string,
  init: RequestInit = {},
  options: AuthenticatedCoreRequestOptions = {},
): Promise<Response> {
  const prepared = authenticatedCoreRequest(pathname, init, options);
  const response = await fetch(prepared.url, prepared.init);
  if (!response.ok) throw new Error(`Core request failed with HTTP ${response.status}`);
  return response;
}

export type ApiRequest = <T>(
  url: string,
  init: RequestInit | undefined,
  decode: (payload: unknown) => T | Promise<T>,
) => Promise<T>;

export const request: ApiRequest = async (url, init, decode) => {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const prepared = authenticatedCoreRequest(url, { ...init, headers });
  return coreClient.request(prepared.url, {
    ...prepared.init,
    decode: (payload) => decode(decodeAbi(SuccessEnvelopeSchema, payload).data),
  });
};

export async function downloadArtifact(
  runId: string,
  artifactId: string,
  filename: string,
  options: AuthenticatedCoreRequestOptions = {},
): Promise<void> {
  const response = await authenticatedCoreFetch(
    `/api/v1/task-runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/download`,
    {},
    options,
  );
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  try {
    anchor.href = objectUrl;
    anchor.download = filename.trim() || "artifact";
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}
