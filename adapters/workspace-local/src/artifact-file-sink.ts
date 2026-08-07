import { createHash } from "node:crypto";
import type { ArtifactSinkPort, ArtifactSinkWriteInput } from "@tagent/execution/ports";
import { writeWorkspaceFile } from "./workspace-path.js";

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "output";
}

/** Workspace-backed durable sink. Artifact descriptors remain owned by Core persistence. */
export class WorkspaceArtifactFileSink implements ArtifactSinkPort {
  constructor(private readonly workspace: string, readonly maxBytes = 16 * 1024 * 1024) {}

  async write(input: ArtifactSinkWriteInput) {
    const source = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, "utf8");
    const buffer = source.subarray(0, this.maxBytes);
    const truncatedAtSource = (input.truncatedAtSource ?? false) || source.length > buffer.length;
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const extension = input.mediaType === "application/json" ? "json" : "log";
    const uri = `.tagent/artifacts/${safeSegment(input.runId)}/${safeSegment(input.artifactId)}-${sha256.slice(0, 16)}.${extension}`;
    await writeWorkspaceFile(this.workspace, uri, buffer);
    return {
      artifactId: input.artifactId,
      title: input.title,
      kind: input.kind,
      uri,
      mediaType: input.mediaType ?? "text/plain; charset=utf-8",
      sha256,
      totalBytes: input.totalBytes ?? source.length,
      storedBytes: buffer.length,
      truncatedAtSource,
    };
  }
}

export function createWorkspaceArtifactSink(workspace: string, maxBytes?: number): ArtifactSinkPort {
  return new WorkspaceArtifactFileSink(workspace, maxBytes);
}
