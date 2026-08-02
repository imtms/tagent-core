import { describe, expect, it } from "vitest";
import { OpenAiSseIdleTimeoutError, readOpenAiChatContent } from "../src/core/openai-sse.js";

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
});
