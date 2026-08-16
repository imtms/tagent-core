export function createRequestId(cryptoApi: Crypto | null | undefined = globalThis.crypto): string {
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  const timestamp = Date.now().toString(36);
  const monotonic = typeof performance !== "undefined" ? Math.floor(performance.now() * 1000).toString(36) : "0";
  const random = Math.random().toString(36).slice(2).padEnd(12, "0").slice(0, 12);
  return `req-${timestamp}-${monotonic}-${random}`;
}

type BrowserStorage = Pick<Storage, "getItem" | "setItem">;

export function getOrCreateEventConsumerId(
  storage: BrowserStorage | null | undefined = globalThis.sessionStorage,
  createId: () => string = createRequestId,
): string {
  const key = "tagent.eventConsumerId";
  try {
    const existing = storage?.getItem(key)?.trim();
    if (existing) return existing;
    const created = `web-${createId()}`;
    storage?.setItem(key, created);
    return created;
  } catch {
    return `web-${createId()}`;
  }
}
