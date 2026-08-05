export type SynchronousResult<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * Mutation boundary used by persistence adapters.
 *
 * The callback is deliberately synchronous so a SQLite transaction or writer
 * fence cannot be escaped by work that continues after `run` returns.
 */
export interface UnitOfWork {
  run<T>(work: () => T & SynchronousResult<T>): T;
}

export type MutationUnitOfWork = UnitOfWork;
