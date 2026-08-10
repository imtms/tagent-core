import { createHash } from "node:crypto";
import { V1HttpError } from "./errors.js";

export type OperatorReadCursorKind = "sessions" | "session_task_runs";

interface OperatorReadTokenPayload {
  version: 1;
  tokenType: "cursor" | "snapshot";
  kind: OperatorReadCursorKind;
  resourceId: string | null;
  filter: "none";
  snapshotRowId: number;
  afterCreatedAt: number | null;
  afterId: string | null;
}

function checksum(payload: string): string {
  return createHash("sha256").update("tagent.operator.read.v1\0").update(payload).digest("base64url").slice(0, 22);
}

function encode(payload: OperatorReadTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${checksum(body)}`;
}

function invalidCursor(): V1HttpError {
  return new V1HttpError(400, "pagination.cursor_invalid", "Pagination cursor is invalid or does not match this query", "validation");
}

export function decodeOperatorReadCursor(
  token: string,
  expected: { kind: OperatorReadCursorKind; resourceId: string | null },
): { snapshotRowId: number; after: { createdAt: number; id: string } } {
  try {
    const [body, digest, ...rest] = token.split(".");
    if (!body || !digest || rest.length || checksum(body) !== digest) throw invalidCursor();
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<OperatorReadTokenPayload>;
    if (value.version !== 1 || value.tokenType !== "cursor" || value.kind !== expected.kind
      || value.resourceId !== expected.resourceId || value.filter !== "none"
      || !Number.isSafeInteger(value.snapshotRowId) || Number(value.snapshotRowId) < 0
      || !Number.isSafeInteger(value.afterCreatedAt) || Number(value.afterCreatedAt) < 0
      || typeof value.afterId !== "string" || !value.afterId) throw invalidCursor();
    return {
      snapshotRowId: Number(value.snapshotRowId),
      after: { createdAt: Number(value.afterCreatedAt), id: value.afterId },
    };
  } catch (error) {
    if (error instanceof V1HttpError) throw error;
    throw invalidCursor();
  }
}

export function encodeOperatorReadCursor(input: {
  kind: OperatorReadCursorKind;
  resourceId: string | null;
  snapshotRowId: number;
  after: { createdAt: number; id: string };
}): string {
  return encode({
    version: 1, tokenType: "cursor", kind: input.kind, resourceId: input.resourceId, filter: "none",
    snapshotRowId: input.snapshotRowId, afterCreatedAt: input.after.createdAt, afterId: input.after.id,
  });
}

export function encodeOperatorReadSnapshot(input: {
  kind: OperatorReadCursorKind;
  resourceId: string | null;
  snapshotRowId: number;
}): string {
  return encode({
    version: 1, tokenType: "snapshot", kind: input.kind, resourceId: input.resourceId, filter: "none",
    snapshotRowId: input.snapshotRowId, afterCreatedAt: null, afterId: null,
  });
}
