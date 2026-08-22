import { createHash } from "node:crypto";
import { V1HttpError } from "./errors.js";

export type ProfileCursorKind = "session_inbox" | "context_manifests" | "skills" | "skill_revisions" | "workspace_skills" | "admin_collection";
export type OperatorReadCursorKind = "sessions" | "session_task_runs";

interface CursorTokenPayload<Kind extends string, ResourceId extends string | null> {
  version: 1;
  tokenType: "cursor" | "snapshot";
  kind: Kind;
  resourceId: ResourceId;
  filter: "none";
  snapshotRowId: number;
  afterCreatedAt: number | null;
  afterId: string | null;
}

function invalidCursor(): V1HttpError {
  return new V1HttpError(400, "pagination.cursor_invalid", "Pagination cursor is invalid or does not match this query", "validation");
}

function createCursorCodec<Kind extends string, ResourceId extends string | null>(namespace: string) {
  const checksum = (payload: string) => createHash("sha256")
    .update(namespace).update(payload).digest("base64url").slice(0, 22);
  const encode = (payload: CursorTokenPayload<Kind, ResourceId>) => {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${checksum(body)}`;
  };
  return {
    decode(token: string, expected: { kind: Kind; resourceId: ResourceId }) {
      try {
        const [body, digest, ...rest] = token.split(".");
        if (!body || !digest || rest.length || checksum(body) !== digest) throw invalidCursor();
        const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<CursorTokenPayload<Kind, ResourceId>>;
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
    },
    encodeCursor(input: { kind: Kind; resourceId: ResourceId; snapshotRowId: number; after: { createdAt: number; id: string } }) {
      return encode({
        version: 1, tokenType: "cursor", kind: input.kind, resourceId: input.resourceId, filter: "none",
        snapshotRowId: input.snapshotRowId, afterCreatedAt: input.after.createdAt, afterId: input.after.id,
      });
    },
    encodeSnapshot(input: { kind: Kind; resourceId: ResourceId; snapshotRowId: number }) {
      return encode({
        version: 1, tokenType: "snapshot", kind: input.kind, resourceId: input.resourceId, filter: "none",
        snapshotRowId: input.snapshotRowId, afterCreatedAt: null, afterId: null,
      });
    },
  };
}

const profileCursor = createCursorCodec<ProfileCursorKind, string>("tagent.capability.profiles.v1\0");
const operatorReadCursor = createCursorCodec<OperatorReadCursorKind, string | null>("tagent.operator.read.v1\0");

export function decodeProfileCursor(token: string, expected: { kind: ProfileCursorKind; resourceId: string }) {
  return profileCursor.decode(token, expected);
}

export function encodeProfileCursor(input: Parameters<typeof profileCursor.encodeCursor>[0]): string {
  return profileCursor.encodeCursor(input);
}

export function encodeProfileSnapshot(input: Parameters<typeof profileCursor.encodeSnapshot>[0]): string {
  return profileCursor.encodeSnapshot(input);
}

export function decodeOperatorReadCursor(token: string, expected: { kind: OperatorReadCursorKind; resourceId: string | null }) {
  return operatorReadCursor.decode(token, expected);
}

export function encodeOperatorReadCursor(input: Parameters<typeof operatorReadCursor.encodeCursor>[0]): string {
  return operatorReadCursor.encodeCursor(input);
}

export function encodeOperatorReadSnapshot(input: Parameters<typeof operatorReadCursor.encodeSnapshot>[0]): string {
  return operatorReadCursor.encodeSnapshot(input);
}
