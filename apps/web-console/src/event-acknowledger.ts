export interface EventAcknowledger {
  schedule(sequence: number): void;
  flush(): void;
  close(): void;
}

/** Coalesces monotonic SSE acknowledgements without losing the final cursor on cleanup. */
export function createEventAcknowledger(
  acknowledge: (sequence: number) => void,
  delayMs = 500,
): EventAcknowledger {
  let highestSequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const flush = () => {
    if (closed || highestSequence === 0) return;
    const sequence = highestSequence;
    highestSequence = 0;
    acknowledge(sequence);
  };

  return {
    schedule(sequence) {
      if (closed || !Number.isSafeInteger(sequence) || sequence <= 0) return;
      highestSequence = Math.max(highestSequence, sequence);
      if (!timer) timer = setTimeout(() => { timer = undefined; flush(); }, delayMs);
    },
    flush,
    close() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      flush();
      closed = true;
    },
  };
}
