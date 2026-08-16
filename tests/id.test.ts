import { describe, expect, it, vi } from "vitest";
import { createRequestId, getOrCreateEventConsumerId } from "../apps/web-console/src/id";

describe("createRequestId", () => {
  it("uses randomUUID when available", () => {
    const cryptoApi = { randomUUID: () => "native-id" } as unknown as Crypto;
    expect(createRequestId(cryptoApi)).toBe("native-id");
  });

  it("creates an RFC 4122 v4 id with getRandomValues", () => {
    const cryptoApi = {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.set(Array.from({ length: 16 }, (_, index) => index));
        return bytes;
      },
    } as unknown as Crypto;
    expect(createRequestId(cryptoApi)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("falls back without Web Crypto", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.123456789);
    expect(createRequestId(null)).toMatch(/^req-[a-z0-9]+-[a-z0-9]+-[a-z0-9]{12}$/);
    vi.restoreAllMocks();
  });
});

describe("getOrCreateEventConsumerId", () => {
  function storage() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
  }

  it("persists one identity per tab-scoped storage", () => {
    const firstTab = storage();
    const secondTab = storage();
    expect(getOrCreateEventConsumerId(firstTab, () => "first")).toBe("web-first");
    expect(getOrCreateEventConsumerId(firstTab, () => "unused")).toBe("web-first");
    expect(getOrCreateEventConsumerId(secondTab, () => "second")).toBe("web-second");
  });

  it("still creates an ephemeral identity when browser storage is unavailable", () => {
    const unavailable = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(getOrCreateEventConsumerId(unavailable, () => "ephemeral")).toBe("web-ephemeral");
  });
});
