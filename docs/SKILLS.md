# Skills center

TAgent Core owns one durable Skills center shared by every Workspace. Operators upload or edit a Skill once, then choose any number of catalog entries for each Workspace. `pi-agent-core` owns execution and receives only the immutable revisions frozen into a new `TaskRun`.

```text
Shared Skills center
  -> upload or edit creates an immutable revision
  -> Workspace references Skill identities
  -> TaskRun freezes the latest revision of every reference
  -> Execution projects all frozen Skills to AgentHarness.resources.skills
  -> Pi can select a matching Skill; one-Skill Workspaces keep explicit invocation
```

Core does not flatten Skill instructions into the system prompt. With one referenced Skill it invokes `AgentHarness.skill(name, prompt)` explicitly for compatibility with the 0.6 behavior. With multiple referenced Skills it supplies the frozen set to `AgentHarness.resources.skills`; Pi sees their names, descriptions and locations and applies the matching Skill. No modification to `pi-agent-core` is required.

## Managing the shared catalog

Open **Skills** in any conversation header. The popover shows the same catalog in every Workspace:

- upload or drop a UTF-8 `.md` file or ZIP bundle;
- check or uncheck entries to replace the current Workspace references;
- edit a Skill's name, description, instructions, or manual-invocation flag;
- delete a Skill from the catalog and remove all of its Workspace references.

An edit creates a new immutable revision rather than rewriting earlier bytes. Every Workspace that references that Skill identity automatically resolves the new revision for its next admitted TaskRun. Delete removes catalog metadata and references, but its content-addressed files remain available to already frozen or running TaskRuns.

At most 32 Skills may be referenced by one Workspace. Upload itself does not select a Workspace, so adding a shared Skill never silently changes another Workspace.

## Skill format

The bundle contains exactly one `SKILL.md`, with optional supporting files below its directory:

```markdown
---
name: release-check
description: Verify and prepare a TAgent Core release.
disable-model-invocation: false
---

Follow the repository release checklist, preserve evidence, and stop on a failed gate.
```

`name` is 1–64 lowercase letters, digits, or single hyphens. `description` is 1–1024 characters. `disable-model-invocation`, when present, must be boolean. The Web editor preserves supporting bundle files and replaces only `SKILL.md` when it creates the next revision.

## Snapshot semantics

Workspace references point to stable Skill identities, not revision IDs. Admission resolves every identity to its latest revision and copies the complete set into `TaskRun.contract.skills`. The snapshot includes name, description, instruction body, revision and content hash, model-visible path, and invocation flag.

Changing a reference, editing, or deleting a catalog entry affects only TaskRuns admitted afterward. Existing Runs, retries, and continuations retain their frozen revisions. The Context Manifest records one selected `skill` item for every frozen revision.

## Upload limits and validation

| Limit | Value |
| --- | ---: |
| Encoded source archive | 8 MiB |
| HTTP JSON body | 12 MiB |
| Expanded bundle | 16 MiB |
| One bundle file | 4 MiB |
| `SKILL.md` | 512 KiB |
| ZIP entries | 128 |
| Workspace references | 32 |

Core rejects invalid base64 or UTF-8, missing or multiple `SKILL.md` files, invalid frontmatter, absolute and traversal paths, duplicate ZIP paths, symlinks, ZIP64/multi-disk or inconsistent archives, files outside the Skill root, bounds violations, duplicate names, and tampered content-addressed revisions.

Skills are untrusted instructions, not capabilities. They do not add tools, widen Workspace access, change service scopes, or weaken approval, receipts, completion evidence, and settlement rules. Skill validation is not an operating-system sandbox.

## Console API

```text
GET    /api/v1/console/skills
POST   /api/v1/console/skills
GET    /api/v1/console/skills/:id
PATCH  /api/v1/console/skills/:id
DELETE /api/v1/console/skills/:id
GET    /api/v1/console/skills/:id/revisions
GET    /api/v1/console/workspaces/:id/skills
PUT    /api/v1/console/workspaces/:id/skills
```

Reads require `sessions:read`; mutations require `sessions:write`. Upload uses bounded JSON `{ "filename": string, "contentBase64": string }`; editing requires `{ "name", "description", "content", "disableModelInvocation"? }`; Workspace replacement uses `{ "skillIds": string[] }`. These are first-party Console contracts, not stable Gateway Operator endpoints.
