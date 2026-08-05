export const CORE_WRITER_LOCK_NAME = "core-writer";
export const DEFAULT_WRITER_HEARTBEAT_MS = 5_000;
export const DEFAULT_WRITER_LEASE_MS = 20_000;
export const DEFAULT_WRITER_SKEW_MARGIN_MS = 2_000;

export interface WriterOwnerIdentity {
  ownerId: string;
  pid: number;
  host: string;
}

export interface WriterAuthority extends WriterOwnerIdentity {
  lockName: string;
  fence: number;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
  releasedAt: number | null;
}

export class WriterAuthorityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriterAuthorityUnavailableError";
  }
}

export class WriterAuthorityLostError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WriterAuthorityLostError";
  }
}
