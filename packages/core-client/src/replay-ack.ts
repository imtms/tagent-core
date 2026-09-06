export interface ReplayAckOptions<T> {
  ack: (sequence: number) => Promise<void>;
  initialAcknowledgedSequence?: number;
  persist: (event: T) => Promise<void>;
  sequence: (event: T) => number;
}

export type ReplayAckResult = "acknowledged" | "duplicate";

export interface ReplayAckCoordinator<T> {
  getAcknowledgedSequence: () => number;
  handle: (event: T) => Promise<ReplayAckResult>;
  idle: () => Promise<void>;
}

export function createReplayAckCoordinator<T>(options: ReplayAckOptions<T>): ReplayAckCoordinator<T> {
  let acknowledgedSequence = options.initialAcknowledgedSequence ?? 0;
  let failed: { error: unknown; sequence: number } | undefined;
  let tail = Promise.resolve();
  const handle = (event: T): Promise<ReplayAckResult> => {
    const operation = tail.then(async (): Promise<ReplayAckResult> => {
      const sequence = options.sequence(event);
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error(`Invalid replay sequence: ${sequence}`);
      if (sequence <= acknowledgedSequence) return "duplicate";
      if (failed && sequence !== failed.sequence) {
        throw new Error(`Replay ACK coordinator is blocked until sequence ${failed.sequence} is durably replayed`, { cause: failed.error });
      }
      try {
        await options.persist(event);
        await options.ack(sequence);
      } catch (error) {
        failed = { error, sequence };
        throw error;
      }
      acknowledgedSequence = sequence;
      failed = undefined;
      return "acknowledged";
    });
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  return {
    getAcknowledgedSequence: (): number => acknowledgedSequence,
    handle,
    idle: (): Promise<void> => tail,
  };
}
