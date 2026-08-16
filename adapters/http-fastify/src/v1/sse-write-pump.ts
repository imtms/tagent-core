import type { ServerResponse } from "node:http";

type SseWritable = Pick<ServerResponse, "off" | "once" | "write">;

export interface SseWritePumpOptions {
  maxPending: number;
  onError(error: unknown): void;
  onOverflow(): void;
}

/** Serializes SSE writes and turns Node's advisory write() result into a real flow-control boundary. */
export class SseWritePump {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private stopped = false;
  private waitingForDrain = false;
  private releaseBackpressure?: () => void;

  constructor(
    private readonly writable: SseWritable,
    private readonly options: SseWritePumpOptions,
  ) {
    if (!Number.isSafeInteger(options.maxPending) || options.maxPending <= 0) {
      throw new TypeError("SSE write-pump maxPending must be a positive safe integer");
    }
  }

  get pendingCount(): number {
    return this.pending;
  }

  get backpressured(): boolean {
    return this.waitingForDrain;
  }

  stop(): void {
    this.stopped = true;
    this.releaseBackpressure?.();
  }

  enqueue(frame: () => string | undefined): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    if (this.pending >= this.options.maxPending) {
      this.options.onOverflow();
      return Promise.resolve(false);
    }
    this.pending += 1;
    const operation = this.tail.then(async () => {
      if (this.stopped) return false;
      const chunk = frame();
      if (chunk === undefined || this.stopped) return false;
      if (this.writable.write(chunk)) return true;
      return this.waitForWritable();
    }).catch((error: unknown) => {
      this.options.onError(error);
      return false;
    }).finally(() => {
      this.pending -= 1;
    });
    this.tail = operation.then(() => undefined);
    return operation;
  }

  private waitForWritable(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    this.waitingForDrain = true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        this.writable.off("drain", onDrain);
        this.writable.off("close", onClose);
        this.writable.off("error", onError);
        if (this.releaseBackpressure === stopWaiting) this.releaseBackpressure = undefined;
        this.waitingForDrain = false;
        resolve(accepted && !this.stopped);
      };
      const onDrain = () => finish(true);
      const onClose = () => finish(false);
      const onError = () => finish(false);
      const stopWaiting = () => finish(false);
      this.releaseBackpressure = stopWaiting;
      this.writable.once("drain", onDrain);
      this.writable.once("close", onClose);
      this.writable.once("error", onError);
    });
  }
}
