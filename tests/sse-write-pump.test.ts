import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { SseWritePump } from "../adapters/http-fastify/src/v1/sse-write-pump.js";

class ControlledWritable extends EventEmitter {
  readonly chunks: string[] = [];
  acceptWrites = true;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.acceptWrites;
  }
}

function writablePort(value: ControlledWritable) {
  return value as unknown as Pick<ServerResponse, "off" | "once" | "write">;
}

describe("SSE write pump", () => {
  it("does not perform the next write until the backpressured writer drains", async () => {
    const writable = new ControlledWritable();
    writable.acceptWrites = false;
    const pump = new SseWritePump(writablePort(writable), {
      maxPending: 4,
      onError: vi.fn(),
      onOverflow: vi.fn(),
    });

    const first = pump.enqueue(() => "first");
    const second = pump.enqueue(() => "second");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writable.chunks).toEqual(["first"]);
    expect(pump.backpressured).toBe(true);

    writable.acceptWrites = true;
    writable.emit("drain");
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(writable.chunks).toEqual(["first", "second"]);
  });

  it("closes through the overflow callback instead of growing an unbounded live queue", async () => {
    const writable = new ControlledWritable();
    writable.acceptWrites = false;
    const overflow = vi.fn(() => pump.stop());
    const pump = new SseWritePump(writablePort(writable), {
      maxPending: 2,
      onError: vi.fn(),
      onOverflow: overflow,
    });

    const first = pump.enqueue(() => "first");
    const second = pump.enqueue(() => "second");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pump.backpressured).toBe(true);
    await expect(pump.enqueue(() => "third")).resolves.toBe(false);
    expect(overflow).toHaveBeenCalledOnce();
    expect(pump.pendingCount).toBeLessThanOrEqual(2);
    expect(pump.backpressured).toBe(false);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });
});
