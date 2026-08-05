import {
  SemanticJudgeModelError,
  type SemanticJudgeModelPort,
  type SemanticJudgeModelRequest,
  type SemanticJudgeModelResponse,
} from "@tagent/learning/ports";

export interface OpenAiSemanticJudgeModelOptions {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}

interface OpenAiChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Core-owned OpenAI-compatible transport for Learning's provider-neutral model port. */
export class OpenAiSemanticJudgeModelAdapter implements SemanticJudgeModelPort {
  readonly modelId: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: OpenAiSemanticJudgeModelOptions) {
    this.modelId = options.modelId;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async request(input: SemanticJudgeModelRequest): Promise<SemanticJudgeModelResponse> {
    const maxAttempts = Number.isInteger(input.maxAttempts) && input.maxAttempts > 0
      ? input.maxAttempts
      : 1;
    let attemptsUsed = 0;
    let timeouts = 0;
    let lastError: unknown;
    while (attemptsUsed < maxAttempts) {
      attemptsUsed += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await this.fetch(
          `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${this.options.apiKey}`,
            },
            body: JSON.stringify({
              model: this.modelId,
              messages: [{ role: "user", content: input.prompt }],
              temperature: 0,
              response_format: { type: "json_object" },
            }),
            signal: controller.signal,
          },
        );
        const body = await response.text();
        if (!response.ok) {
          throw new Error(`Semantic judge API ${response.status}: ${body.slice(0, 300)}`);
        }
        const parsed = JSON.parse(body) as OpenAiChatCompletionResponse;
        const content = parsed.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
          throw new Error("Semantic judge API returned an invalid response envelope");
        }
        return {
          value: JSON.parse(content),
          inputTokens: parsed.usage?.prompt_tokens,
          outputTokens: parsed.usage?.completion_tokens,
          attemptsUsed,
          timeouts,
        };
      } catch (error) {
        lastError = error;
        if ((error as { name?: string })?.name === "AbortError") timeouts += 1;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new SemanticJudgeModelError(
      failureMessage(lastError),
      attemptsUsed,
      timeouts,
      { cause: lastError },
    );
  }
}
