import { describe, expect, it } from "vitest";
import { SemanticJudge } from "@tagent/learning";
import { SemanticJudgeModelError } from "@tagent/learning/ports";
import { OpenAiSemanticJudgeModelAdapter } from "@tagent/core-service/composition";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAI semantic judge model adapter", () => {
  it("owns provider request shape, authentication, and token extraction", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new OpenAiSemanticJudgeModelAdapter({
      baseUrl: "https://semantic.test/v1/",
      apiKey: "secret",
      modelId: "semantic-model",
      timeoutMs: 1_000,
      fetch: (async (input, init) => {
        requests.push({ url: String(input), init });
        return response({
          choices: [{ message: { content: JSON.stringify({ similar: true }) } }],
          usage: { prompt_tokens: 11, completion_tokens: 3 },
        });
      }) as typeof globalThis.fetch,
    });

    await expect(adapter.request({ prompt: "judge this", maxAttempts: 1 })).resolves.toEqual({
      value: { similar: true },
      inputTokens: 11,
      outputTokens: 3,
      attemptsUsed: 1,
      timeouts: 0,
    });
    expect(requests[0].url).toBe("https://semantic.test/v1/chat/completions");
    expect(requests[0].init?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer secret",
    });
    expect(JSON.parse(String(requests[0].init?.body))).toMatchObject({
      model: "semantic-model",
      messages: [{ role: "user", content: "judge this" }],
      temperature: 0,
      response_format: { type: "json_object" },
    });
  });

  it("retries provider failures inside the Core adapter", async () => {
    let calls = 0;
    const adapter = new OpenAiSemanticJudgeModelAdapter({
      baseUrl: "https://semantic.test/v1",
      apiKey: "secret",
      modelId: "semantic-model",
      timeoutMs: 1_000,
      fetch: (async () => {
        calls += 1;
        return calls === 1
          ? response({ error: "temporary" }, 503)
          : response({ choices: [{ message: { content: "{\"similar\":true}" } }] });
      }) as typeof globalThis.fetch,
    });

    await expect(adapter.request({ prompt: "retry", maxAttempts: 2 })).resolves.toMatchObject({
      value: { similar: true },
      attemptsUsed: 2,
      timeouts: 0,
    });
    expect(calls).toBe(2);
  });

  it("enforces provider timeout outside the Learning package", async () => {
    const adapter = new OpenAiSemanticJudgeModelAdapter({
      baseUrl: "https://semantic.test/v1",
      apiKey: "secret",
      modelId: "semantic-model",
      timeoutMs: 5,
      fetch: ((_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as typeof globalThis.fetch,
    });

    await expect(adapter.request({ prompt: "timeout", maxAttempts: 1 })).rejects.toMatchObject({
      name: SemanticJudgeModelError.name,
      attemptsUsed: 1,
      timeouts: 1,
      lastFailure: "aborted",
    });
  });

  it("reports mixed transport failures without exceeding the supplied budget", async () => {
    let calls = 0;
    const adapter = new OpenAiSemanticJudgeModelAdapter({
      baseUrl: "https://semantic.test/v1",
      apiKey: "secret",
      modelId: "semantic-model",
      timeoutMs: 1_000,
      fetch: (async () => {
        calls += 1;
        if (calls === 1) throw new DOMException("first timeout", "AbortError");
        if (calls === 2) return response({ error: "temporary" }, 503);
        return response({ choices: [{ message: { content: "{\"similar\":true,\"confidence\":0.9,\"reason\":\"same\"}" } }] });
      }) as typeof globalThis.fetch,
    });

    await expect(adapter.request({ prompt: "mixed", maxAttempts: 3 })).resolves.toMatchObject({
      value: { similar: true, confidence: 0.9, reason: "same" },
      attemptsUsed: 3,
      timeouts: 1,
    });
    expect(calls).toBe(3);
  });

  it("spends the same budget across envelope and JSON decoding failures", async () => {
    let calls = 0;
    const adapter = new OpenAiSemanticJudgeModelAdapter({
      baseUrl: "https://semantic.test/v1",
      apiKey: "secret",
      modelId: "semantic-model",
      timeoutMs: 1_000,
      fetch: (async () => {
        calls += 1;
        if (calls === 1) return new Response("{broken", { status: 200 });
        if (calls === 2) return response({ choices: [] });
        if (calls === 3) return response({ choices: [{ message: { content: "{broken" } }] });
        return response({ choices: [{ message: { content: "{\"similar\":true}" } }] });
      }) as typeof globalThis.fetch,
    });

    await expect(adapter.request({ prompt: "decode", maxAttempts: 4 })).resolves.toMatchObject({
      value: { similar: true },
      attemptsUsed: 4,
      timeouts: 0,
    });
    expect(calls).toBe(4);
  });

  it("throws neutral attempt metadata when transport exhausts the budget", async () => {
    let calls = 0;
    const adapter = new OpenAiSemanticJudgeModelAdapter({
      baseUrl: "https://semantic.test/v1",
      apiKey: "secret",
      modelId: "semantic-model",
      timeoutMs: 1_000,
      fetch: (async () => {
        calls += 1;
        return response({ error: `failure-${calls}` }, 503);
      }) as typeof globalThis.fetch,
    });

    await expect(adapter.request({ prompt: "exhaust", maxAttempts: 2 })).rejects.toMatchObject({
      name: SemanticJudgeModelError.name,
      attemptsUsed: 2,
      timeouts: 0,
      lastFailure: expect.stringContaining("failure-2"),
    });
    expect(calls).toBe(2);
  });

  it("retries a domain-invalid decision in Learning with one shared attempt budget", async () => {
    let calls = 0;
    const adapter = new OpenAiSemanticJudgeModelAdapter({
      baseUrl: "https://semantic.test/v1",
      apiKey: "secret",
      modelId: "semantic-model",
      timeoutMs: 1_000,
      fetch: (async () => {
        calls += 1;
        const value = calls === 1
          ? { similar: "invalid", confidence: 0.9, reason: "wrong type" }
          : { similar: true, confidence: 0.95, reason: "same intent" };
        return response({ choices: [{ message: { content: JSON.stringify(value) } }] });
      }) as typeof globalThis.fetch,
    });
    const judge = new SemanticJudge({ model: adapter, maxAttempts: 2 });

    await expect(judge.cluster("left", "right")).resolves.toEqual({
      similar: true,
      confidence: 0.95,
      reason: "same intent",
    });
    expect(calls).toBe(2);
    expect(judge.snapshot()).toMatchObject({
      calls: 2,
      timeouts: 0,
      failures: 0,
      lastFailure: null,
    });
  });

  it("does not multiply Core retries after transport consumes the whole Learning budget", async () => {
    let calls = 0;
    const adapter = new OpenAiSemanticJudgeModelAdapter({
      baseUrl: "https://semantic.test/v1",
      apiKey: "secret",
      modelId: "semantic-model",
      timeoutMs: 1_000,
      fetch: (async () => {
        calls += 1;
        return response({ error: "still unavailable" }, 503);
      }) as typeof globalThis.fetch,
    });
    const judge = new SemanticJudge({ model: adapter, maxAttempts: 3 });

    await expect(judge.cluster("left", "right")).resolves.toBeUndefined();
    expect(calls).toBe(3);
    expect(judge.snapshot()).toMatchObject({
      calls: 3,
      timeouts: 0,
      failures: 1,
      lastFailure: expect.stringContaining("still unavailable"),
    });
  });

  it("preserves provider-attempt timeout and terminal failure metrics", async () => {
    let calls = 0;
    const adapter = new OpenAiSemanticJudgeModelAdapter({
      baseUrl: "https://semantic.test/v1",
      apiKey: "secret",
      modelId: "semantic-model",
      timeoutMs: 1_000,
      fetch: (async () => {
        calls += 1;
        throw new DOMException(`timeout-${calls}`, "AbortError");
      }) as typeof globalThis.fetch,
    });
    const judge = new SemanticJudge({ model: adapter, maxAttempts: 2 });

    await expect(judge.cluster("left", "right")).resolves.toBeUndefined();
    expect(calls).toBe(2);
    expect(judge.snapshot()).toMatchObject({
      calls: 2,
      timeouts: 2,
      failures: 1,
      lastFailure: "timeout-2",
    });
  });
});
