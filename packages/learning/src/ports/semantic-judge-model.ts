export interface SemanticJudgeModelRequest {
  prompt: string;
  /** Total provider attempts still available for this request. */
  maxAttempts: number;
}

export interface SemanticJudgeModelResponse {
  value: unknown;
  inputTokens?: number;
  outputTokens?: number;
  attemptsUsed: number;
  timeouts: number;
}

/** Provider-neutral terminal failure with consumed attempt metadata. */
export class SemanticJudgeModelError extends Error {
  override readonly name = "SemanticJudgeModelError";

  constructor(
    readonly lastFailure: string,
    readonly attemptsUsed: number,
    readonly timeouts: number,
    options?: ErrorOptions,
  ) {
    super(lastFailure, options);
  }
}

/** Provider-neutral outbound port used by Learning's semantic policy. */
export interface SemanticJudgeModelPort {
  readonly modelId: string;
  request(input: SemanticJudgeModelRequest): Promise<SemanticJudgeModelResponse>;
}
