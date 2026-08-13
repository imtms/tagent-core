# Workspace Skills

TAgent Core owns the durable Skill lifecycle while `pi-agent-core` owns execution. A Workspace operator chooses the exact instructions that a future `TaskRun` will use; the runtime receives only the immutable revision frozen into that Run.

```text
Web Console upload or selection
  -> Core validation and immutable revision
  -> Session binding
  -> TaskRun contract snapshot
  -> Execution RuntimeSkill projection
  -> AgentHarness.resources.skills
  -> AgentHarness.skill(name, task prompt)
```

Core never converts a selected Skill into an ordinary user prompt. The Pi adapter registers the frozen Skill as a native `AgentHarness` resource and invokes it explicitly. No change to `pi-agent-core` is required.

## Loading a Skill

Open the Skill control in the conversation header. You can choose a saved Skill, select a file, or drop one of these inputs:

- a UTF-8 Markdown file ending in `.md`, normally named `SKILL.md`;
- a ZIP bundle containing exactly one `SKILL.md` and any files below the directory that contains it.

The `SKILL.md` starts with YAML frontmatter and has a non-empty instruction body:

```markdown
---
name: release-check
description: Verify and prepare a TAgent Core release.
disable-model-invocation: false
---

Follow the repository release checklist, preserve evidence, and stop on a failed gate.
```

`name` is 1–64 lowercase letters, digits, or single hyphens. `description` is 1–1024 characters. `disable-model-invocation`, when present, must be a boolean. TAgent explicitly invokes the operator-selected Skill; the flag is retained in the Pi resource for native model-invocation policy.

A successful upload creates or reuses a content-addressed revision below `.tagent/skills/<name>/<sha256>/`, records the revision in SQLite, and selects it for the current Session. Uploading changed content under the same name creates the next revision. Selecting a saved entry binds its latest listed revision; disabling removes the binding for future TaskRuns without deleting history.

## Snapshot semantics

Only one Skill revision may be active for a Session at a time. Admission copies the selected revision into the immutable `TaskRun` contract, including its name, description, instruction body, content hash, model-visible workspace-relative path, and invocation flag. Bundle files remain under the content-addressed revision directory covered by the hash.

Changing the Session binding affects only TaskRuns admitted after the change. Existing Runs, retries, and continuations keep the revision already frozen into their contract. The Context Manifest records the Skill as a selected `skill` source, and runtime invocation emits `skill.invoked` with its name and hash.

## Upload limits and validation

The upload boundary is deliberately bounded:

| Limit | Value |
| --- | ---: |
| Encoded source archive | 8 MiB |
| HTTP JSON body | 12 MiB |
| Expanded bundle | 16 MiB |
| One bundle file | 4 MiB |
| `SKILL.md` | 512 KiB |
| ZIP entries | 128 |

Core rejects invalid base64 or UTF-8, missing or multiple `SKILL.md` files, invalid frontmatter, absolute and traversal paths, duplicate paths, ZIP symlinks, ZIP64/multi-disk or inconsistent central directories, files outside the Skill root, and bounds violations. Reusing an existing content-addressed directory verifies every expected file and rejects extra content, changed bytes, and symlinks.

Skills are untrusted instructions, not capabilities. They do not add tools, widen workspace access, change service scopes, or weaken approval, operation receipt, completion evidence, and settlement rules. Use a dedicated OS/container boundary when untrusted `bash` execution requires stronger isolation; Skill validation is not an operating-system sandbox.

## Console API

The first-party Console surface provides:

```text
GET    /api/v1/console/skills
GET    /api/v1/console/sessions/:id/skill
POST   /api/v1/console/sessions/:id/skill/upload
PUT    /api/v1/console/sessions/:id/skill
DELETE /api/v1/console/sessions/:id/skill
```

Reads require `sessions:read`; mutations require `sessions:write`. Upload uses bounded JSON `{ "filename": string, "contentBase64": string }`. These routes are first-party Console contracts, not part of the stable Gateway Operator profile. See [API_V1.md](API_V1.md) for envelopes and authentication.
