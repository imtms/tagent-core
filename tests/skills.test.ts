import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { CoreSkillApplication } from "@tagent/core-service/application";
import { Store } from "@tagent/persistence-sqlite/store";

function skillSource(name: string, body: string, description = "A bounded test Skill") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

function application(store: Store, workspace: string) {
  return new CoreSkillApplication({
    createRevision: (input) => store.createSkillRevision(input),
    listSkills: () => store.listSkills(),
    getRevision: (id) => store.getSkillRevision(id),
    getSessionSkill: (id) => store.getSessionSkill(id),
    bindSessionSkill: (sessionId, revisionId) => store.bindSessionSkill(sessionId, revisionId),
    unbindSessionSkill: (sessionId) => store.unbindSessionSkill(sessionId),
  }, { getSession: (id) => store.getSession(id) }, workspace);
}

describe("Core-managed Skills", () => {
  it("uploads, binds, revisions, and freezes the selected revision in a TaskRun contract", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "tagent-skill-"));
    const store = new Store(":memory:");
    const session = store.createSession();
    const skills = application(store, workspace);
    const first = await skills.uploadSkill(session.id, {
      filename: "SKILL.md",
      contentBase64: Buffer.from(skillSource("release-check", "First checklist.")).toString("base64"),
    });
    const contract = {
      sourceInput: "ship", summary: "Ship", objectives: [], acceptanceCriteria: [], scope: "repo", nonGoals: [],
      sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const,
      decisionReason: "test", routerVersion: "test",
    };
    const firstRun = store.createRun(session.id, "ship first", undefined, contract);
    const second = await skills.uploadSkill(session.id, {
      filename: "release-check.zip",
      contentBase64: Buffer.from(zipSync({
        "release-check/SKILL.md": strToU8(skillSource("release-check", "Second checklist.")),
        "release-check/references/notes.md": strToU8("supporting notes"),
      })).toString("base64"),
    });
    const secondRun = store.createRun(session.id, "ship second", undefined, contract);

    expect(second.revision).toBe(first.revision + 1);
    expect(store.getRun(firstRun.id)?.contract?.skill).toMatchObject({ revisionId: first.id, content: "First checklist." });
    expect(store.getRun(secondRun.id)?.contract?.skill).toMatchObject({ revisionId: second.id, content: "Second checklist." });
    expect(readFileSync(path.join(workspace, second.filePath), "utf8")).toContain("Second checklist.");
    expect(readFileSync(path.join(path.dirname(path.join(workspace, second.filePath)), "references/notes.md"), "utf8")).toBe("supporting notes");
    store.close();
  });

  it("rejects malformed metadata and ZIP traversal", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "tagent-skill-invalid-"));
    const store = new Store(":memory:");
    const session = store.createSession();
    const skills = application(store, workspace);
    await expect(skills.uploadSkill(session.id, {
      filename: "SKILL.md",
      contentBase64: Buffer.from("No frontmatter").toString("base64"),
    })).rejects.toThrow("requires YAML frontmatter");
    await expect(skills.uploadSkill(session.id, {
      filename: "unsafe.zip",
      contentBase64: Buffer.from(zipSync({
        "safe/SKILL.md": strToU8(skillSource("safe", "Safe body.")),
        "../escape.txt": strToU8("escape"),
      })).toString("base64"),
    })).rejects.toThrow("Unsafe Skill archive path");
    const symlink = zipSync({
      "unsafe-link/SKILL.md": strToU8(skillSource("unsafe-link", "Unsafe link body.")),
      "unsafe-link/reference": [strToU8("SKILL.md"), { os: 3, attrs: 0o120777 << 16 }],
    });
    await expect(skills.uploadSkill(session.id, {
      filename: "unsafe-link.zip",
      contentBase64: Buffer.from(symlink).toString("base64"),
    })).rejects.toThrow("ZIP symlinks are not allowed");
    const macSymlink = zipSync({
      "unsafe-mac-link/SKILL.md": strToU8(skillSource("unsafe-mac-link", "Unsafe macOS link body.")),
      "unsafe-mac-link/reference": [strToU8("SKILL.md"), { os: 19, attrs: 0o120777 << 16 }],
    });
    await expect(skills.uploadSkill(session.id, {
      filename: "unsafe-mac-link.zip",
      contentBase64: Buffer.from(macSymlink).toString("base64"),
    })).rejects.toThrow("ZIP symlinks are not allowed");
    await expect(skills.uploadSkill(session.id, {
      filename: "truncated.zip",
      contentBase64: Buffer.from("PK").toString("base64"),
    })).rejects.toThrow("Invalid Skill ZIP central directory");
    store.close();
  });

  it("rejects tampered pre-existing content-addressed revisions", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "tagent-skill-tamper-"));
    const store = new Store(":memory:");
    const session = store.createSession();
    const skills = application(store, workspace);
    const source = skillSource("tamper-check", "Do not trust a pre-created directory.");
    const bundle = zipSync({
      "tamper-check/SKILL.md": strToU8(source),
      "tamper-check/references/notes.md": strToU8("expected"),
    });
    const uploaded = await skills.uploadSkill(session.id, { filename: "tamper-check.zip", contentBase64: Buffer.from(bundle).toString("base64") });
    const root = path.dirname(path.join(workspace, uploaded.filePath));
    writeFileSync(path.join(root, "unexpected.txt"), "not part of the immutable bundle");
    await expect(skills.uploadSkill(session.id, { filename: "tamper-check.zip", contentBase64: Buffer.from(bundle).toString("base64") }))
      .rejects.toThrow("unexpected content");
    mkdirSync(path.join(root, "nested"));
    symlinkSync(path.join(root, "SKILL.md"), path.join(root, "nested", "link"));
    await expect(skills.uploadSkill(session.id, { filename: "tamper-check.zip", contentBase64: Buffer.from(bundle).toString("base64") }))
      .rejects.toThrow(/unexpected content|unsafe symlink/);
    store.close();
  });
});
