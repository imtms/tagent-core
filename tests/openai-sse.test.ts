import { describe, expect, it } from "vitest";
import { OpenAiSseIdleTimeoutError, readOpenAiChatContent } from "@tagent/core-service/composition";

const encoder = new TextEncoder();
function sseResponse(parts: Array<{ delayMs: number; data: string }>) {
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const part of parts) {
        await new Promise((resolve) => setTimeout(resolve, part.delayMs));
        controller.enqueue(encoder.encode(part.data));
      }
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

describe("OpenAI-compatible SSE idle timeout", () => {
  it("keeps a long stream alive while bytes continue arriving", async () => {
    const controller = new AbortController();
    const response = sseResponse([
      { delayMs: 5, data: 'data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n' },
      { delayMs: 20, data: 'data: {"choices":[{"delta":{"content":"true}"}}]}\n\n' },
      { delayMs: 20, data: "data: [DONE]\n\n" },
    ]);
    await expect(readOpenAiChatContent(response, { idleTimeoutMs: 30, controller })).resolves.toBe('{"ok":true}');
  });

  it("aborts only after the SSE stream is inactive for the configured interval", async () => {
    const controller = new AbortController();
    const response = sseResponse([
      { delayMs: 1, data: 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' },
      { delayMs: 50, data: "data: [DONE]\n\n" },
    ]);
    await expect(readOpenAiChatContent(response, { idleTimeoutMs: 15, controller })).rejects.toBeInstanceOf(OpenAiSseIdleTimeoutError);
  });

  it("retains compatibility with non-streaming JSON responses", async () => {
    const controller = new AbortController();
    const response = new Response(JSON.stringify({ choices: [{ message: { content: "result" } }] }), { headers: { "content-type": "application/json" } });
    await expect(readOpenAiChatContent(response, { idleTimeoutMs: 15, controller })).resolves.toBe("result");
  });
  it("aborts a non-streaming JSON body that stops making progress after headers", async () => {
    const controller = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(encoder.encode('{"choices":[')); },
    }), { headers: { "content-type": "application/json" } });
    await expect(readOpenAiChatContent(response, { idleTimeoutMs: 15, controller })).rejects.toBeInstanceOf(OpenAiSseIdleTimeoutError);
  });
  it("reports streamed usage to callers", async () => {
    const controller = new AbortController();
    const observed: unknown[] = [];
    const response = new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\ndata: [DONE]\n\n')); stream.close(); } }), { headers: { "content-type": "text/event-stream" } });
    await readOpenAiChatContent(response, { idleTimeoutMs: 30, controller, onUsage: (usage) => observed.push(usage) });
    expect(observed).toEqual([{ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10 }]);
  });

});
