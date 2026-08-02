export class OpenAiSseIdleTimeoutError extends Error {
  constructor(readonly idleTimeoutMs: number) {
    super(`OpenAI-compatible SSE stream was idle for ${idleTimeoutMs}ms`);
    this.name = "OpenAiSseIdleTimeoutError";
  }
}

interface ChatCompletionChunk {
  choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
  error?: { message?: string };
}

/**
 * Read an OpenAI-compatible chat completion as SSE with an inactivity timeout.
 * The timer is refreshed whenever bytes arrive, so a long generation is allowed
 * to continue indefinitely while the upstream keeps making progress.
 */
export async function readOpenAiChatSse(response: Response, options: { idleTimeoutMs: number; controller: AbortController }): Promise<string> {
  if (!response.body) throw new Error("OpenAI-compatible SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimedOut = false;

  const refreshIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      const error = new OpenAiSseIdleTimeoutError(options.idleTimeoutMs);
      options.controller.abort(error);
      void reader.cancel(error).catch(() => undefined);
    }, options.idleTimeoutMs);
  };
  const consumeEvent = (event: string) => {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data) as ChatCompletionChunk;
    if (chunk.error?.message) throw new Error(`OpenAI-compatible SSE error: ${chunk.error.message}`);
    for (const choice of chunk.choices ?? []) content += choice.delta?.content ?? choice.message?.content ?? "";
  };

  refreshIdleTimer();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (idleTimedOut) throw new OpenAiSseIdleTimeoutError(options.idleTimeoutMs);
      if (done) break;
      refreshIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) consumeEvent(event);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeEvent(buffer);
    return content;
  } catch (error) {
    if (idleTimedOut) throw new OpenAiSseIdleTimeoutError(options.idleTimeoutMs);
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    reader.releaseLock();
  }
}

export async function readOpenAiChatContent(response: Response, options: { idleTimeoutMs: number; controller: AbortController }): Promise<string> {
  if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    return readOpenAiChatSse(response, options);
  }
  const envelope = await response.json() as ChatCompletionChunk;
  return envelope.choices?.[0]?.message?.content ?? "";
}
