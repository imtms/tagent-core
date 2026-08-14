import { Type, type Static } from "typebox";
import type { ToolProvider } from "@tagent/execution/composition";
import type { RuntimeTool, ToolCapabilityApplicationPort } from "@tagent/execution/ports";
import { textResult } from "./shared.js";

const SearchSchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 256 }),
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
      description: "Search earlier durable transcript text in this TaskRun for a known exact path, ID, error code, or phrase. Matching is case-sensitive literal text, not regex or semantic search. Results exclude the current assistant tool-call message.",
      parameters: SearchSchema,
      executionMode: "sequential",
      execute: async (_id, params, signal) => {
        if (!params.query) throw new Error("history_search requires a non-empty literal query");
        const result = await history.search(params.query, signal);
        return textResult(JSON.stringify({
          query: params.query,
          semantics: "case-sensitive literal",
          ...result,
        }, null, 2));
      },
    };
    return [search];
  }
}
