export interface OneShotPort<T extends object> {
  readonly port: T;
  bind(implementation: T): void;
  assertBound(): void;
}

/**
 * Breaks constructor-time orchestration cycles without exposing a partially
 * initialized service object. A port can be bound exactly once and every access
 * fails closed until composition validates all bindings.
 */
export function createOneShotPort<T extends object>(name: string): OneShotPort<T> {
  let implementation: T | undefined;
  const port = new Proxy({} as T, {
    get(_target, property) {
      if (!implementation) throw new Error(`${name} is not bound`);
      const member = Reflect.get(implementation, property);
      return typeof member === "function" ? member.bind(implementation) : member;
    },
  });
  return Object.freeze({
    port,
    bind(value: T) {
      if (implementation) throw new Error(`${name} is already bound`);
      implementation = value;
    },
    assertBound() {
      if (!implementation) throw new Error(`${name} is not bound`);
    },
  });
}
