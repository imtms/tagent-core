import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalBlobStore } from "../src/memory/storage/local-blob-store.js";

describe("LocalBlobStore", () => {
  it("treats retrying the same immutable payload as idempotent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tagent-cold-")); const blobs = new LocalBlobStore(root);
    const first = await blobs.putImmutable("topic/rev-000001.md", "same", {});
    expect(await blobs.putImmutable("topic/rev-000001.md", "same", {})).toEqual(first);
    await expect(blobs.putImmutable("topic/rev-000001.md", "different", {})).rejects.toThrow("different content");
    expect(await readFile(path.join(root, "topic/rev-000001.md"), "utf8")).toBe("same");
  });
});
