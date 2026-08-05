export class CapabilityGrantUnsupportedError extends Error {
  readonly grantId: string;

  constructor(grantId: string) {
    super(`Capability grant ${grantId} is unsupported by the approval-bound execution handler`);
    this.name = "CapabilityGrantUnsupportedError";
    this.grantId = grantId;
  }
}

export class CapabilityOutcomeUnknownError extends Error {
  readonly commandId: string;
  readonly effectError?: unknown;

  constructor(commandId: string, cause: unknown, effectError?: unknown) {
    super(`Capability command ${commandId} completed an external effect but its durable outcome is unknown`, { cause });
    this.name = "CapabilityOutcomeUnknownError";
    this.commandId = commandId;
    this.effectError = effectError;
  }
}
