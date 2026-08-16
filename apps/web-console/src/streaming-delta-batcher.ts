export interface FrameScheduler {
  request(callback: () => void): unknown;
  cancel(handle: unknown): void;
}

export interface StreamingDeltaBatcher {
  appendOutput(delta: string): void;
  appendThinking(delta: string): void;
  flush(): void;
  discard(): void;
}

const browserFrameScheduler: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle as number),
};

/** Coalesces high-frequency token deltas into at most one React update per animation frame. */
export function createStreamingDeltaBatcher(
  apply: (outputDelta: string, thinkingDelta: string) => void,
  scheduler: FrameScheduler = browserFrameScheduler,
): StreamingDeltaBatcher {
  let outputDelta = "";
  let thinkingDelta = "";
  let scheduled: unknown;

  const drain = () => {
    scheduled = undefined;
    if (!outputDelta && !thinkingDelta) return;
    const output = outputDelta;
    const thinking = thinkingDelta;
    outputDelta = "";
    thinkingDelta = "";
    apply(output, thinking);
  };
  const schedule = () => {
    if (scheduled !== undefined) return;
    scheduled = scheduler.request(drain);
  };
  const cancel = () => {
    if (scheduled === undefined) return;
    scheduler.cancel(scheduled);
    scheduled = undefined;
  };

  return {
    appendOutput(delta) {
      if (!delta) return;
      outputDelta += delta;
      schedule();
    },
    appendThinking(delta) {
      if (!delta) return;
      thinkingDelta += delta;
      schedule();
    },
    flush() {
      cancel();
      drain();
    },
    discard() {
      cancel();
      outputDelta = "";
      thinkingDelta = "";
    },
  };
}
