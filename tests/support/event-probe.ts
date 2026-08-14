import type { RunEvent, RunEventType } from "@tagent/execution/domain";

interface Waiter {
  predicate: (event: RunEvent) => boolean;
  resolve: (event: RunEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Event-driven synchronization for tests; the timer is only a failure guard. */
export class RunEventProbe {
  readonly observed: RunEvent[] = [];
  private readonly waiters = new Set<Waiter>();

  observe = (event: RunEvent) => {
    this.observed.push(event);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(event)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(event);
    }
  };

  waitFor<TType extends RunEventType>(
    type: TType,
    predicate: (event: RunEvent<TType>) => boolean = () => true,
    timeoutMs = 2_000,
  ): Promise<RunEvent<TType>> {
    const matches = (event: RunEvent): event is RunEvent<TType> => event.type === type
      && predicate(event as RunEvent<TType>);
    const existing = this.observed.find(matches);
    if (existing) return Promise.resolve(existing);
    return new Promise<RunEvent<TType>>((resolve, reject) => {
      const waiter: Waiter = {
        predicate: matches,
        resolve: (event) => resolve(event as RunEvent<TType>),
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out waiting for RunEvent ${type}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  dispose() {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("RunEventProbe disposed"));
    }
    this.waiters.clear();
  }
}
