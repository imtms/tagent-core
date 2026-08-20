import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { CoreSkillApplication } from "@tagent/core-service/application";
import { renameConflictMayReferenceExistingDirectory } from "../apps/core-service/src/application/skill-application.js";
import { Store } from "@tagent/persistence-sqlite/store";

function skillSource(name: string, body: string, description = "A bounded test Skill") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

function application(store: Store, workspace: string) {
  return new CoreSkillApplication({
    createRevision: (input) => store.createSkillRevision(input),
    listSkills: () => store.listSkills(),
    getSkill: (id) => store.getSkill(id),
    listRevisions: (id) => store.listSkillRevisions(id),
    listWorkspaceSkills: (id) => store.listWorkspaceSkills(id),
    replaceWorkspaceSkills: (workspaceId, skillIds) => store.replaceWorkspaceSkills(workspaceId, skillIds),
    deleteSkill: (id) => store.deleteSkill(id),
    getCatalogRevision: () => store.getCatalogRevision(),
    getSkillResourceRevision: (id) => store.getSkillResourceRevision(id),
    getWorkspaceSkillRevision: (id) => store.getWorkspaceSkillRevision(id),
    listProfileSkillsPage: (query) => store.listProfileSkillsPage(query),
    listProfileSkillRevisionsPage: (id, query) => store.listProfileSkillRevisionsPage(id, query),
    listProfileWorkspaceSkillsPage: (id, query) => store.listProfileWorkspaceSkillsPage(id, query),
    createRevisionProfile: (input, mutation) => store.createRevisionProfile(input, mutation),
    deleteSkillProfile: (id, mutation) => store.deleteSkillProfile(id, mutation),
    replaceWorkspaceSkillsProfile: (id, skillIds, mutation) => store.replaceWorkspaceSkillsProfile(id, skillIds, mutation),
  }, { getSession: (id) => store.getSession(id) }, workspace);
}

describe("Core-managed Skills", () => {
  it("recognizes only genuine platform-specific existing-directory rename conflicts", () => {
    expect(renameConflictMayReferenceExistingDirectory({ code: "EPERM" }, "win32")).toBe(true);
    expect(renameConflictMayReferenceExistingDirectory({ code: "EACCES" }, "win32")).toBe(true);
    expect(renameConflictMayReferenceExistingDirectory({ code: "EPERM" }, "linux")).toBe(false);
    expect(renameConflictMayReferenceExistingDirectory({ code: "EACCES" }, "darwin")).toBe(false);
    expect(renameConflictMayReferenceExistingDirectory({ code: "ENOENT" }, "win32")).toBe(false);
  });

  it("uploads, binds, revisions, and freezes the selected revision in a TaskRun contract", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "tagent-skill-"));
    const store = new Store(":memory:");
    const session = store.createSession();
    const skills = application(store, workspace);
    const first = await skills.uploadSkill({
      filename: "SKILL.md",
      contentBase64: Buffer.from(skillSource("release-check", "First checklist.")).toString("base64"),
    });
    skills.replaceWorkspaceSkills(session.id, [first.skillId]);
    const contract = {
      sourceInput: "ship", summary: "Ship", objectives: [], acceptanceCriteria: [], scope: "repo", nonGoals: [],
      sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const,
      decisionReason: "test", routerVersion: "test",
    };
    const firstRun = store.createRun(session.id, "ship first", undefined, contract);
    const second = await skills.uploadSkill({
      filename: "release-check.zip",
      contentBase64: Buffer.from(zipSync({
        "release-check/SKILL.md": strToU8(skillSource("release-check", "Second checklist.")),
        "release-check/references/notes.md": strToU8("supporting notes"),
      })).toString("base64"),
    });
    const secondRun = store.createRun(session.id, "ship second", undefined, contract);

    expect(second.revision).toBe(first.revision + 1);
    expect(store.getRun(firstRun.id)?.contract?.skills).toEqual([expect.objectContaining({ revisionId: first.id, content: "First checklist." })]);
    expect(store.getRun(secondRun.id)?.contract?.skills).toEqual([expect.objectContaining({ revisionId: second.id, content: "Second checklist." })]);
    expect(readFileSync(path.join(workspace, second.filePath), "utf8")).toContain("Second checklist.");
    expect(readFileSync(path.join(path.dirname(path.join(workspace, second.filePath)), "references/notes.md"), "utf8")).toBe("supporting notes");
    store.close();
  });

  it("reuses an identical content-addressed Skill bundle", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "tagent-skill-repeat-"));
    const store = new Store(":memory:");
    store.createSession();
    const skills = application(store, workspace);
    const upload = { filename: "repeat.md", contentBase64: Buffer.from(skillSource("repeat-check", "Repeat safely.")).toString("base64") };
    const first = await skills.uploadSkill(upload);
    const second = await skills.uploadSkill(upload);
    expect(second).toMatchObject({ skillId: first.skillId, sha256: first.sha256, filePath: first.filePath });
    expect(readFileSync(path.join(workspace, second.filePath), "utf8")).toContain("Repeat safely.");
    store.close();
  });

  it("rejects malformed metadata and ZIP traversal", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "tagent-skill-invalid-"));
    const store = new Store(":memory:");
    store.createSession();
    const skills = application(store, workspace);
    await expect(skills.uploadSkill({
      filename: "SKILL.md",
      contentBase64: Buffer.from("No frontmatter").toString("base64"),
    })).rejects.toThrow("requires YAML frontmatter");
    await expect(skills.uploadSkill({
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
    await expect(skills.uploadSkill({
      filename: "unsafe-link.zip",
      contentBase64: Buffer.from(symlink).toString("base64"),
    })).rejects.toThrow("ZIP symlinks are not allowed");
    const macSymlink = zipSync({
      "unsafe-mac-link/SKILL.md": strToU8(skillSource("unsafe-mac-link", "Unsafe macOS link body.")),
      "unsafe-mac-link/reference": [strToU8("SKILL.md"), { os: 19, attrs: 0o120777 << 16 }],
    });
    await expect(skills.uploadSkill({
      filename: "unsafe-mac-link.zip",
      contentBase64: Buffer.from(macSymlink).toString("base64"),
    })).rejects.toThrow("ZIP symlinks are not allowed");
    await expect(skills.uploadSkill({
      filename: "truncated.zip",
      contentBase64: Buffer.from("PK").toString("base64"),
    })).rejects.toThrow("Invalid Skill ZIP central directory");
    store.close();
  });

  it("rejects tampered pre-existing content-addressed revisions", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "tagent-skill-tamper-"));
    const store = new Store(":memory:");
    store.createSession();
    const skills = application(store, workspace);
    const source = skillSource("tamper-check", "Do not trust a pre-created directory.");
    const bundle = zipSync({
      "tamper-check/SKILL.md": strToU8(source),
      "tamper-check/references/notes.md": strToU8("expected"),
    });
    const uploaded = await skills.uploadSkill({ filename: "tamper-check.zip", contentBase64: Buffer.from(bundle).toString("base64") });
    const root = path.dirname(path.join(workspace, uploaded.filePath));
    writeFileSync(path.join(root, "unexpected.txt"), "not part of the immutable bundle");
    await expect(skills.uploadSkill({ filename: "tamper-check.zip", contentBase64: Buffer.from(bundle).toString("base64") }))
      .rejects.toThrow("unexpected content");
    mkdirSync(path.join(root, "nested"));
    symlinkSync(path.join(root, "SKILL.md"), path.join(root, "nested", "link"));
    await expect(skills.uploadSkill({ filename: "tamper-check.zip", contentBase64: Buffer.from(bundle).toString("base64") }))
      .rejects.toThrow(/unexpected content|unsafe symlink/);
    store.close();
  });

  it("shares the catalog across Workspaces, snapshots multiple latest revisions, edits, and deletes safely", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "tagent-skill-center-"));
    const store = new Store(":memory:");
    const firstWorkspace = store.createSession("First");
    const secondWorkspace = store.createSession("Second");
    const skills = application(store, workspace);
    const release = await skills.uploadSkill({ filename: "release.md", contentBase64: Buffer.from(skillSource("release-check", "Release v1.")).toString("base64") });
    const docs = await skills.uploadSkill({ filename: "docs.md", contentBase64: Buffer.from(skillSource("docs-check", "Review docs.")).toString("base64") });
    skills.replaceWorkspaceSkills(firstWorkspace.id, [release.skillId, docs.skillId]);
    skills.replaceWorkspaceSkills(secondWorkspace.id, [release.skillId]);
    expect(store.listSkills()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: release.skillId, workspaceCount: 2 }),
      expect.objectContaining({ id: docs.skillId, workspaceCount: 1 }),
    ]));

    const edited = await skills.updateSkill(release.skillId, {
      name: "release-check", description: "Updated release verification", content: "Release v2.", disableModelInvocation: false,
    });
    expect(edited.revision).toBe(2);
    expect(store.listWorkspaceSkills(secondWorkspace.id)).toEqual([expect.objectContaining({ id: edited.id })]);
    const contract = { sourceInput: "ship", summary: "Ship", objectives: [], acceptanceCriteria: [], scope: "repo", nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "test" };
    const run = store.createRun(firstWorkspace.id, "ship", undefined, contract);
    expect(store.getRun(run.id)?.contract?.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "release-check", revision: 2, content: "Release v2." }),
      expect.objectContaining({ name: "docs-check", revision: 1, content: "Review docs." }),
    ]));

    skills.deleteSkill(release.skillId);
    expect(store.listWorkspaceSkills(firstWorkspace.id)).toEqual([expect.objectContaining({ name: "docs-check" })]);
    expect(store.getRun(run.id)?.contract?.skills).toEqual(expect.arrayContaining([expect.objectContaining({ name: "release-check", revision: 2 })]));
    expect(readFileSync(path.join(workspace, edited.filePath), "utf8")).toContain("Release v2.");
    store.close();
  });
});
