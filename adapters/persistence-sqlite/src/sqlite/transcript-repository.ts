import type Database from "better-sqlite3";
import type { RunId, TaskRun } from "@tagent/execution/domain";
import type { RuntimeMessage as AgentMessage } from "@tagent/execution/ports";
import type { TranscriptEntryQuery, TranscriptFilters, TranscriptSearchOptions } from "@tagent/execution/ports";

const now = () => Date.now();

function transcriptFilterSql(alias: string, options: TranscriptFilters, params: Array<string | number>): string[] {
  const filters: string[] = [];
  if (options.attempt !== undefined) { filters.push(`${alias}.attempt=?`); params.push(options.attempt); }
  if (options.role !== undefined) { filters.push(`${alias}.role=?`); params.push(options.role); }
  if (options.createdAfter !== undefined) { filters.push(`${alias}.created_at>=?`); params.push(options.createdAfter); }
  if (options.createdBefore !== undefined) { filters.push(`${alias}.created_at<?`); params.push(options.createdBefore); }
  if (options.kind === "user") filters.push(`${alias}.role='user'`);
  else if (options.kind === "assistant") filters.push(`${alias}.role='assistant' AND EXISTS (
    SELECT 1 FROM json_each(${alias}.message_json,'$.content') part WHERE json_extract(part.value,'$.type')='text'
  )`);
  else if (options.kind === "thinking") filters.push(`${alias}.role='assistant' AND EXISTS (
    SELECT 1 FROM json_each(${alias}.message_json,'$.content') part WHERE json_extract(part.value,'$.type')='thinking'
  )`);
  else if (options.kind === "tool") filters.push(`(${alias}.role='toolResult' OR ${alias}.role='assistant' AND EXISTS (
    SELECT 1 FROM json_each(${alias}.message_json,'$.content') part WHERE json_extract(part.value,'$.type')='toolCall'
  ))`);
  return filters;
}

/** SQLite-owned transcript storage and wire-view projection. */
export class SqliteTranscriptRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly getRun: (runId: RunId) => TaskRun | undefined,
  ) {}

  getLastTranscriptSeq(runId: RunId): number {
    return (this.db.prepare("SELECT COALESCE(MAX(seq), 0) as seq FROM run_transcript WHERE run_id = ?")
      .get(runId) as { seq: number }).seq;
  }

  getTranscriptCount(runId: RunId): number {
    return (this.db.prepare("SELECT COALESCE(MAX(seq), 0) as count FROM run_transcript WHERE run_id = ?")
      .get(runId) as { count: number }).count;
  }

  appendTranscript(runId: RunId, attempt: number, message: AgentMessage): number {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 as seq FROM run_transcript WHERE run_id = ?")
        .get(runId) as { seq: number };
      this.db.prepare("INSERT INTO run_transcript (run_id, seq, attempt, attempt_id, role, message_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(runId, row.seq, attempt, `attempt:${runId}:${attempt}`, message.role, JSON.stringify(message), now());
      if (message.role === "assistant") {
        this.db.prepare(`UPDATE runs SET
          usage_input = usage_input + ?, usage_output = usage_output + ?,
          usage_cache_read = usage_cache_read + ?, usage_cache_write = usage_cache_write + ?,
          usage_total_tokens = usage_total_tokens + ?, usage_cost = usage_cost + ?, updated_at = ?
          WHERE id = ?`).run(
          message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.cacheWrite,
          message.usage.totalTokens, message.usage.cost.total, now(), runId,
        );
      }
      return row.seq;
    })();
  }

  listTranscriptEntries(runId: RunId, options: TranscriptEntryQuery = {}) {
    const limit = options.limit === undefined ? undefined : Math.max(1, Math.floor(options.limit));
    const params: Array<string | number> = [runId];
    const filters = [`t.run_id=?`, ...transcriptFilterSql("t", options, params)];
    if (options.after !== undefined) { filters.push("t.seq>?"); params.push(options.after); }
    const select = `SELECT t.seq,t.attempt,t.role,t.message_json as messageJson,t.created_at as createdAt
      FROM run_transcript t WHERE ${filters.join(" AND ")}`;
    let sql: string;
    if (limit === undefined) sql = `${select} ORDER BY t.seq`;
    else if (options.after !== undefined) { sql = `${select} ORDER BY t.seq LIMIT ?`; params.push(limit); }
    else { sql = `SELECT * FROM (${select} ORDER BY t.seq DESC LIMIT ?) ORDER BY seq`; params.push(limit); }
    const rows = this.db.prepare(sql).all(...params);
    return (rows as Array<{ seq: number; attempt: number; role: string; messageJson: string; createdAt: number }>)
      .map(({ messageJson, ...row }) => ({ ...row, message: JSON.parse(messageJson) as AgentMessage }));
  }

  searchTranscriptLiteral(runId: RunId, query: string, options: TranscriptSearchOptions = {}) {
    if (!query) throw new Error("Transcript literal search query cannot be empty");
    if (query.includes("\0") || query.length > 256) throw new Error("Transcript literal search query is invalid");
    const limit = Math.min(20, Math.max(1, Math.floor(options.limit ?? 8)));
    const snippetChars = Math.min(1_000, Math.max(80, Math.floor(options.snippetChars ?? 320)));
    const encodedQuery = JSON.stringify(query).slice(1, -1);
    const beforeSeq = options.beforeSeq ?? Number.MAX_SAFE_INTEGER;
    const params: Array<string | number> = [runId, beforeSeq, encodedQuery];
    const filters = ["t.run_id=?", "t.seq<?", "instr(t.message_json,?)>0", ...transcriptFilterSql("t", options, params)];
    params.push(limit + 1);
    const rows = this.db.prepare(`SELECT t.seq,t.attempt,t.role,t.message_json as messageJson,t.created_at as createdAt
      FROM run_transcript t WHERE ${filters.join(" AND ")}
      ORDER BY t.seq DESC LIMIT ?`).all(...params) as Array<{
        seq: number; attempt: number; role: string; messageJson: string; createdAt: number;
      }>;
    const matches = rows.slice(0, limit).map(({ messageJson, ...row }) => {
      const index = messageJson.indexOf(encodedQuery);
      const available = Math.max(0, snippetChars - encodedQuery.length);
      let start = Math.max(0, index - Math.floor(available / 2));
      const end = Math.min(messageJson.length, start + snippetChars);
      start = Math.max(0, end - snippetChars);
      return {
        ...row,
        snippet: `${start > 0 ? "…" : ""}${messageJson.slice(start, end)}${end < messageJson.length ? "…" : ""}`,
      };
    });
    return { matches, truncated: rows.length > limit };
  }

  searchTranscriptTerms(runId: RunId, query: string, options: TranscriptSearchOptions = {}) {
    if (query.includes("\0") || query.length > 256) throw new Error("Transcript term search query is invalid");
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (!terms.length) throw new Error("Transcript term search query cannot be empty");
    const limit = Math.min(20, Math.max(1, Math.floor(options.limit ?? 8)));
    const snippetChars = Math.min(1_000, Math.max(80, Math.floor(options.snippetChars ?? 320)));
    const beforeSeq = options.beforeSeq ?? Number.MAX_SAFE_INTEGER;
    const expression = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" AND ");
    const params: Array<string | number> = [runId, beforeSeq, expression];
    const filters = ["t.run_id=?", "t.seq<?", "run_transcript_fts MATCH ?", ...transcriptFilterSql("t", options, params)];
    params.push(limit + 1);
    const rows = this.db.prepare(`SELECT t.seq,t.attempt,t.role,
      snippet(run_transcript_fts,2,'[',']','…',24) AS rawSnippet,t.created_at as createdAt
      FROM run_transcript_fts JOIN run_transcript t
        ON t.run_id=run_transcript_fts.run_id AND t.seq=run_transcript_fts.seq
      WHERE ${filters.join(" AND ")} ORDER BY t.seq DESC LIMIT ?`).all(...params) as Array<{
        seq: number; attempt: number; role: string; rawSnippet: string; createdAt: number;
      }>;
    const matches = rows.slice(0, limit).map(({ rawSnippet, ...row }) => ({
      ...row,
      snippet: rawSnippet.length <= snippetChars ? rawSnippet : `${rawSnippet.slice(0, Math.max(0, snippetChars - 1))}…`,
    }));
    return { matches, truncated: rows.length > limit };
  }

  listTranscript(runId: RunId): AgentMessage[] {
    return this.listTranscriptEntries(runId).map((entry) => entry.message);
  }

  repairTranscript(runId: RunId, reason: "cancelled" | "resume" | "continuation") {
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Unknown run ${runId}`);
      const pending = new Map<string, string>();
      for (const message of this.listTranscript(runId)) {
        if (message.role === "assistant") {
          for (const part of message.content) if (part.type === "toolCall") pending.set(part.id, part.name);
        } else if (message.role === "toolResult") pending.delete(message.toolCallId);
      }
      const repaired: Array<{ toolCallId: string; toolName: string }> = [];
      for (const [toolCallId, toolName] of pending) {
        const message: AgentMessage = {
          role: "toolResult", toolCallId, toolName,
          content: [{ type: "text", text: `Tool result synthesized by TAgent Core because the ${reason} boundary interrupted this call.` }],
          details: { synthetic: true, reason }, isError: true,
          error: { name: "ToolExecutionError", code: "ABORTED", message: `Tool call interrupted by ${reason} boundary` },
          timestamp: now(),
        };
        this.appendTranscript(runId, run.attempt, message);
        repaired.push({ toolCallId, toolName });
      }
      return repaired;
    })();
  }

  listTranscriptView(runId: RunId, options: TranscriptEntryQuery = {}) {
    type TranscriptViewItem =
      | { seq: number; index?: number; attempt: number; kind: "user" | "assistant"; text: string; createdAt: number }
      | { seq: number; index: number; attempt: number; kind: "thinking"; text: string; redacted: boolean; createdAt: number }
      | { seq: number; index: number; attempt: number; kind: "tool"; toolCallId: string; toolName: string; arguments: unknown; result: string; isError: boolean; error?: Extract<AgentMessage, { role: "toolResult" }>["error"]; status: "pending" | "completed" | "failed"; createdAt: number };
    const toolResults = new Map<string, {
      content: string; isError: boolean; error?: Extract<AgentMessage, { role: "toolResult" }>["error"];
      toolName: string; seq: number; attempt: number; createdAt: number;
    }>();
    const entries = [...this.listTranscriptEntries(runId, options)];
    const supplementalEntrySeqs = new Set<number>();
    const toolCallIds = new Set<string>();
    const completedToolCallIds = new Set<string>();
    for (const entry of entries) {
      const message = entry.message;
      if (message.role === "assistant") {
        for (const part of message.content) if (part.type === "toolCall") toolCallIds.add(part.id);
      }
      if (message.role !== "toolResult") continue;
      completedToolCallIds.add(message.toolCallId);
      const content = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      toolResults.set(message.toolCallId, {
        content, isError: message.isError, error: message.error, toolName: message.toolName,
        seq: entry.seq, attempt: entry.attempt, createdAt: entry.createdAt,
      });
    }
    const missingToolCallSources = [...completedToolCallIds].filter((id) => !toolCallIds.has(id));
    if (missingToolCallSources.length) {
      const rows = this.db.prepare(`SELECT DISTINCT t.seq,t.attempt,t.role,t.message_json as messageJson,t.created_at as createdAt
        FROM run_transcript t, json_each(t.message_json,'$.content') part
        WHERE t.run_id=? AND t.role='assistant' AND json_extract(part.value,'$.type')='toolCall'
          AND json_extract(part.value,'$.id') IN (SELECT value FROM json_each(?))`)
        .all(runId, JSON.stringify(missingToolCallSources)) as Array<{ seq: number; attempt: number; role: string; messageJson: string; createdAt: number }>;
      const existingSeq = new Set(entries.map((entry) => entry.seq));
      for (const { messageJson, ...row } of rows) {
        if (existingSeq.has(row.seq)) continue;
        entries.push({ ...row, message: JSON.parse(messageJson) as AgentMessage });
        supplementalEntrySeqs.add(row.seq);
        existingSeq.add(row.seq);
        const message = JSON.parse(messageJson) as Extract<AgentMessage, { role: "assistant" }>;
        for (const part of message.content) if (part.type === "toolCall") toolCallIds.add(part.id);
      }
      entries.sort((left, right) => left.seq - right.seq);
    }
    // Do not fetch a result beyond the selected durable-entry window. Doing so
    // would move the rendered tool item to a later sequence and can turn the
    // current cursor page into an empty page. A selected result may still fetch
    // its earlier call source above, while an earlier call remains pending until
    // its result's own sequence is selected.
    const view: TranscriptViewItem[] = [];
    const selectedKind = options.kind;
    for (const entry of entries) {
      const message = entry.message;
      if (message.role === "user") {
        if (selectedKind === undefined || selectedKind === "user") {
          view.push({ seq: entry.seq, attempt: entry.attempt, kind: "user", text: typeof message.content === "string" ? message.content : "", createdAt: entry.createdAt });
        }
        continue;
      }
      if (message.role !== "assistant") continue;
      for (const [index, part] of message.content.entries()) {
        if (supplementalEntrySeqs.has(entry.seq) && (part.type !== "toolCall" || !completedToolCallIds.has(part.id))) continue;
        if (part.type === "text" && part.text && (selectedKind === undefined || selectedKind === "assistant")) {
          view.push({ seq: entry.seq, index, attempt: entry.attempt, kind: "assistant", text: part.text, createdAt: entry.createdAt });
        } else if (part.type === "thinking" && (part.thinking || part.redacted) && (selectedKind === undefined || selectedKind === "thinking")) {
          view.push({ seq: entry.seq, index, attempt: entry.attempt, kind: "thinking", text: part.redacted ? "Reasoning was redacted by the model provider." : part.thinking, redacted: Boolean(part.redacted), createdAt: entry.createdAt });
        } else if (part.type === "toolCall" && (selectedKind === undefined || selectedKind === "tool")) {
          const result = toolResults.get(part.id);
          view.push({
            seq: result?.seq ?? entry.seq, index, attempt: result?.attempt ?? entry.attempt, kind: "tool",
            toolCallId: part.id, toolName: part.name, arguments: part.arguments, result: result?.content ?? "",
            isError: result?.isError ?? false, error: result?.error,
            status: result ? (result.isError ? "failed" : "completed") : "pending",
            createdAt: result?.createdAt ?? entry.createdAt,
          });
        }
      }
    }
    return view;
  }
}
