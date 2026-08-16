import { createServer, type Server, type ServerResponse } from "node:http";

export type WireFaultStep =
  | { kind: "reset_before_headers" }
  | { kind: "rate_limit"; retryAfterSeconds: number }
  | { kind: "partial_sse_reset"; content: string }
  | { kind: "clean_eof_without_done"; content: string }
  | { kind: "malformed_sse"; data?: string }
  | { kind: "empty_completion" }
  | { kind: "success"; content: string };

export interface WireRequestRecord {
  ordinal: number;
  receivedAt: number;
  method: string;
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: string;
  json: unknown;
  step: WireFaultStep;
}

function chunk(content: string, finishReason: "stop" | null = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-wire-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "wire-model",
    choices: [{ index: 0, delta: finishReason ? {} : { role: "assistant", content }, finish_reason: finishReason }],
    ...(finishReason ? { usage: { prompt_tokens: 3, completion_tokens: content ? 1 : 0, total_tokens: content ? 4 : 3 } } : {}),
  })}\n\n`;
}

function sseHeaders(response: ServerResponse) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
}

function applyStep(step: WireFaultStep, response: ServerResponse) {
  if (step.kind === "reset_before_headers") {
    response.socket?.destroy();
    return;
  }
  if (step.kind === "rate_limit") {
    response.writeHead(429, { "content-type": "application/json", "retry-after": String(step.retryAfterSeconds) });
    response.end(JSON.stringify({ error: { message: "rate limit exceeded" } }));
    return;
  }
  sseHeaders(response);
  if (step.kind === "partial_sse_reset") {
    response.write(chunk(step.content), () => response.socket?.destroy());
    return;
  }
  if (step.kind === "clean_eof_without_done") {
    response.end(chunk(step.content) + chunk("", "stop"));
    return;
  }
  if (step.kind === "malformed_sse") {
    response.end(`data: ${step.data ?? "{not-json"}\n\n`);
    return;
  }
  if (step.kind === "empty_completion") {
    response.end(chunk("", "stop") + "data: [DONE]\n\n");
    return;
  }
  response.end(chunk(step.content) + chunk("", "stop") + "data: [DONE]\n\n");
}

/** Deterministic fault selection for repeatable randomized transport scenarios. */
export function seededWireFaultScript(seed: number, candidates: readonly WireFaultStep[], length: number): WireFaultStep[] {
  if (!candidates.length) throw new Error("At least one wire-fault candidate is required");
  let state = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  return Array.from({ length }, () => structuredClone(candidates[next() % candidates.length]));
}

export class WireFaultServer {
  readonly requests: WireRequestRecord[] = [];
  private readonly server: Server;
  private base?: string;

  constructor(private readonly script: readonly WireFaultStep[]) {
    if (!script.length) throw new Error("Wire-fault script cannot be empty");
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (value: Buffer) => chunks.push(value));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const ordinal = this.requests.length + 1;
        const step = this.script[Math.min(ordinal - 1, this.script.length - 1)];
        let json: unknown;
        try { json = JSON.parse(body); } catch { json = undefined; }
        this.requests.push({ ordinal, receivedAt: Date.now(), method: request.method ?? "", url: request.url ?? "", headers: { ...request.headers }, body, json, step });
        applyStep(step, response);
      });
    });
  }

  async start() {
    if (this.base) return this.base;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Wire-fault server did not bind");
    this.base = `http://127.0.0.1:${address.port}/v1`;
    return this.base;
  }

  async close() {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
}
