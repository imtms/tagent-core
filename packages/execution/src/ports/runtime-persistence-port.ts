import type { OperationRepository } from "@tagent/governance/ports";
import type { ToolPersistencePort } from "./tool-persistence-port.js";
import type { TranscriptRepository } from "./transcript-repository.js";

export type RuntimePersistencePort =
  & ToolPersistencePort
  & Pick<OperationRepository, "recordToolAttempt" | "completeToolAttempt">
  & Pick<TranscriptRepository, "appendTranscript">;
