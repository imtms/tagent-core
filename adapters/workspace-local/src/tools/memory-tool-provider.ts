import { Type, type Static } from "typebox";
import type { ToolProvider } from "@tagent/execution/composition";
import type { RuntimeTool, ToolCapabilityApplicationPort } from "@tagent/execution/ports";
import { textResult } from "./shared.js";

const SearchSchema = Type.Object({ query: Type.String(), kinds: Type.Optional(Type.Array(Type.Union([Type.Literal("fact"), Type.Literal("preference"), Type.Literal("episode"), Type.Literal("procedure")]))), maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) });
const RecordSchema = Type.Object({ id: Type.String() });
const TopicSchema = Type.Object({ topicId: Type.String() });
const ForgetSchema = Type.Union([
  Type.Object({ ids: Type.Array(Type.String(), { minItems: 1 }), topicIds: Type.Optional(Type.Array(Type.String())), reason: Type.Optional(Type.String()), gracePeriodMs: Type.Optional(Type.Number({ minimum: 1 })) }),
  Type.Object({ ids: Type.Optional(Type.Array(Type.String())), topicIds: Type.Array(Type.String(), { minItems: 1 }), reason: Type.Optional(Type.String()), gracePeriodMs: Type.Optional(Type.Number({ minimum: 1 })) }),
]);

export class MemoryToolProvider implements ToolProvider {
  readonly id = "memory.tools";
  constructor(private readonly capabilities: ToolCapabilityApplicationPort) {}
  provideTools(): readonly RuntimeTool[] {
    const memory = this.capabilities.memory;
    if (!memory) return [];
    const search: RuntimeTool<Static<typeof SearchSchema>, Record<string, unknown>> = { name: "memory_search", label: "Search memory", description: "Search long-term memory when automatic recall is insufficient. Returns cards, topic IDs, confidence and provenance routes.", parameters: SearchSchema, execute: async (_id, params, signal) => textResult(JSON.stringify(await memory.search(params.query, params.kinds, params.maxResults, signal), null, 2)) };
    const topic: RuntimeTool<Static<typeof TopicSchema>, Record<string, unknown>> = { name: "memory_topic_get", label: "Read memory topic", description: "Read one complete canonical Cold Topic page by exact topic ID.", parameters: TopicSchema, execute: async (_id, params, signal) => { const value = await memory.getTopic(params.topicId, signal); if (!value) throw new Error("Memory topic not found"); return textResult(value.body, { topicId: params.topicId, revision: value.revision, checksum: value.checksum }); } };
    const record: RuntimeTool<Static<typeof RecordSchema>, Record<string, unknown>> = { name: "memory_record_get", label: "Read memory record", description: "Read one full memory record including source references, provenance, status, validity and canonical semantics.", parameters: RecordSchema, execute: async (_id, params, signal) => { const value = await memory.getRecord(params.id, signal); if (!value) throw new Error("Memory record not found"); return textResult(JSON.stringify(value, null, 2)); } };
    const forget: RuntimeTool<Static<typeof ForgetSchema>, Record<string, unknown>> = { name: "memory_forget", label: "Forget memory", description: "Forget specified memory record IDs or Topic IDs. Use only when the user explicitly requests deletion or correction.", parameters: ForgetSchema, executionMode: "sequential", policy: { operationType: "tool.memory_forget", workspaceAccess: "mutation", externalAction: true }, execute: async (_id, params, signal) => { if (!params.ids?.length && !params.topicIds?.length) throw new Error("Memory forget requires at least one record ID or Topic ID"); return textResult(JSON.stringify(await memory.forget(params, signal), null, 2)); } };
    return [search, topic, record, forget];
  }
}
