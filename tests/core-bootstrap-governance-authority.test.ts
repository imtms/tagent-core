import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "@tagent/core-service/config";
import { bootstrapCore } from "@tagent/core-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("core bootstrap Governance approval authority", () => {
  it("rejects the dormant canonical authority before creating workspace or database resources", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "tagent-canonical-bootstrap-"));
    temporaryDirectories.push(parent);
    const workspace = path.join(parent, "workspace", "nested");
    const databaseDirectory = path.join(parent, "database", "nested");
    const config: AppConfig = {
      ...loadConfig({}),
      governanceApprovalAuthority: "canonical",
      workspace,
      database: path.join(databaseDirectory, "core.sqlite"),
    };

    const bootstrap = bootstrapCore(config).then(async (core) => {
      await core.close();
      return core;
    });
    await expect(bootstrap).rejects.toMatchObject({
      name: "GovernanceApprovalAuthoritySwitchRejectedError",
      decision: {
        requestedAuthority: "canonical",
        effectiveAuthority: "legacy",
        switchApproved: false,
        blockers: expect.arrayContaining([
          "request_handler_not_ready",
          "decide_handler_not_ready",
          "consume_handler_not_ready",
          "execute_handler_not_ready",
          "no_bypass_evidence_unapproved",
        ]),
      },
    });
    await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(databaseDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
