import type { RuntimeCapabilityCatalog, RuntimeTool } from "../ports/attempt-runtime.js";

export interface ToolProvider {
  readonly id: string;
  provideTools(): readonly RuntimeTool[];
}

function immutableClone<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  if (typeof value === "function") return value;
  const source = value as object;
  const existing = seen.get(source);
  if (existing) return existing as T;
  const clone: object = Array.isArray(source) ? [] : Object.create(Object.getPrototypeOf(source));
  seen.set(source, clone);
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    Object.defineProperty(clone, key, "value" in descriptor
      ? { ...descriptor, value: immutableClone(descriptor.value, seen) }
      : descriptor);
  }
  return Object.freeze(clone) as T;
}

function immutableTool(tool: RuntimeTool): RuntimeTool {
  return Object.freeze({
    ...tool,
    parameters: immutableClone(tool.parameters),
    policy: tool.policy ? Object.freeze({ ...tool.policy }) : undefined,
  });
}

/** Mutable only during composition; each Attempt receives an immutable catalog snapshot. */
export class ToolRegistry {
  private readonly tools = new Map<string, { registration: symbol; providerId: string; tool: RuntimeTool }>();
  private readonly providers = new Map<string, symbol>();

  register(provider: ToolProvider): () => void {
    const providerId = provider.id.trim();
    if (!providerId) throw new Error("Tool provider id is required");
    if (this.providers.has(providerId)) throw new Error(`Tool provider ${providerId} is already registered`);
    const contributed = provider.provideTools();
    const names = new Set<string>();
    for (const tool of contributed) {
      if (!tool.name.trim()) throw new Error(`Tool provider ${providerId} contributed an empty name`);
      if (names.has(tool.name)) throw new Error(`Tool provider ${providerId} contributed duplicate tool ${tool.name}`);
      names.add(tool.name);
      const existing = this.tools.get(tool.name);
      if (existing) throw new Error(`Duplicate tool ${tool.name} from ${providerId}; already registered by ${existing.providerId}`);
    }
    const registration = Symbol(providerId);
    const tools = contributed.map(immutableTool);
    this.providers.set(providerId, registration);
    for (const tool of tools) this.tools.set(tool.name, { registration, providerId, tool });
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.providers.get(providerId) === registration) this.providers.delete(providerId);
      for (const tool of tools) {
        if (this.tools.get(tool.name)?.registration === registration) this.tools.delete(tool.name);
      }
    };
  }

  snapshot(): RuntimeCapabilityCatalog {
    return Object.freeze({ tools: Object.freeze([...this.tools.values()].map(({ tool }) => tool)) });
  }
}
