export interface RuntimeModelSpec {
  id: string;
  provider: string;
  api: string;
  baseUrl: string;
  reasoning?: boolean;
  contextWindow: number;
  maxTokens: number;
}
