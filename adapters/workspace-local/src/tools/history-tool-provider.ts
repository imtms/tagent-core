import { Type, type Static } from "typebox";
import type { ToolProvider } from "@tagent/execution/composition";
import type { RuntimeTool, ToolCapabilityApplicationPort } from "@tagent/execution/ports";
import { textResult } from "./shared.js";

const SearchSchema = Type.Object({
  action: Type.Optional(Type.Union([Type.Literal("search"), Type.Literal("get")])),
  mode: Type.Optional(Type.Union([Type.Literal("literal"), Type.Literal("terms")])),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000]+$" })),
  beforeSeq: Type.Optional(Type.Integer({ minimum: 1 })),
  seq: Type.Optional(Type.Integer({ minimum: 1 })),
  attempt: Type.Optional(Type.Integer({ minimum: 1 })),
  role: Type.Optional(Type.Union([
    Type.Literal("user"), Type.Literal("assistant"), Type.Literal("toolResult"),
    Type.Literal("bashExecution"), Type.Literal("custom"), Type.Literal("branchSummary"), Type.Literal("compactionSummary"),
  ])),
  kind: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("thinking"), Type.Literal("tool")])),
  createdAfter: Type.Optional(Type.Integer({ minimum: 0 })),
  createdBefore: Type.Optional(Type.Integer({ minimum: 1 })),
});

export class HistoryToolProvider implements ToolProvider {
  readonly id = "history.tool";
  constructor(private readonly capabilities: ToolCapabilityApplicationPort) {}

  provideTools(): readonly RuntimeTool[] {
    const history = this.capabilities.history;
    if (!history) return [];
    const search: RuntimeTool<Static<typeof SearchSchema>, Record<string, unknown>> = {
      name: "history_search",
      label: "Search task history",
      description: "Search or retrieve earlier durable transcript entries in this TaskRun. Literal search is exact and case-sensitive; terms mode uses Unicode full-text search. Search supports attempt, role, rendered kind, write-time filters, and exclusive beforeSeq pagination. action=get retrieves one exact seq. Results exclude the current assistant tool-call message.",
      parameters: SearchSchema,
      executionMode: "sequential",
      execute: async (_id, params, signal) => {
        if (params.action === "get") {
          if (!params.seq) throw new Error('history_search action="get" requires seq');
          const entry = await history.get(params.seq, signal);
          if (!entry) throw new Error(`Transcript entry ${params.seq} is unavailable or is not earlier than the current tool call`);
          return textResult(JSON.stringify({ action: "get", exactSeq: params.seq, entry }, null, 2));
        }
        if (!params.query) throw new Error("history_search requires a non-empty literal query");
        const result = await history.search(params.query, {
          mode: params.mode,
          beforeSeq: params.beforeSeq,
          attempt: params.attempt,
          role: params.role,
          kind: params.kind,
          createdAfter: params.createdAfter,
          createdBefore: params.createdBefore,
        }, signal);
        return textResult(JSON.stringify({
          action: "search",
          query: params.query,
          semantics: params.mode === "terms" ? "unicode terms (all terms)" : "case-sensitive literal",
          ...result,
        }, null, 2));
      },
    };
    return [search];
  }
}
