# Security boundaries

## Trust model

TAgent Core supports one trusted service containing a stable Host and one active Generation, one trusted tool workspace, and one SQLite writer. The Host does not open application persistence. It is not a public multi-tenant sandbox. Run it under a dedicated OS identity and keep it behind a private network boundary.

## Authentication modes

If `TAGENT_SERVICE_CREDENTIALS` is empty, protected v1 routes use a `local-admin` principal. This mode is for localhost development only. Core rejects non-loopback `HOST` values; leave `TAGENT_CORS_ALLOWED_ORIGINS` empty.

If credentials are configured, Core fails closed. Requests must present an opaque Bearer token whose configured scopes include the route capability. Available scopes are:

```text
sessions:read       sessions:write
runs:read           runs:control
events:consume      workflows:teach
workflows:govern    workflows:approve
admin               internal
operator:session-settings:read   operator:session-settings:write
operator:inbox:read              operator:inbox:write
operator:inbox:control           operator:context-manifests:read
operator:skills:read             operator:skills:write
admin:memory:read                admin:memory:write
admin:learning:read              admin:learning:write
admin:workflow:read              admin:workflow:write
admin:autonomy:read              admin:autonomy:decide
admin:autonomy:execute           admin:operations:read
```

A credential may bind a subject and `user`, `workspace`, `project`, or `session` resource scopes. Core takes these values only from server configuration. Profile mutation headers may carry delegated actor/request identifiers for audit correlation, but they grant no scope and cannot replace the authenticated principal.

`runs:read` includes the unified TaskRun transcript. Transcript items preserve model reasoning, commands, paths, tool arguments, and tool results without a Web-only or Console-only projection, so grant this scope only to principals allowed to inspect complete execution history.

## Gateway boundary

Core does not validate OIDC/JWT tokens. The public Gateway owns browser authentication and must replace the browser token with a minimal Core service credential. Core must remain inaccessible from the public network.

Exact-origin CORS is a browser transport boundary, not authentication. A non-empty CORS allowlist requires Core credentials. Core does not use credentialed cookies.

## Workspace and process boundary

`@tagent/workspace-local` normalizes and contains filesystem paths, and command policy rejects known unsafe operations. These checks do not isolate the process from the host. Every local child process, including the descriptor-relative filesystem helper and permitted `bash` commands, crosses `SubprocessPort`; it does not inherit Core's ambient credential or `TAGENT_*` environment. The local port constructs a scrubbed environment and terminates the process group on abort, timeout, or Attempt disposal. Explicit environment overrides are a trusted composition capability and are never derived from model tool arguments. `history_search` derives its Run from the fenced Attempt capability, searches only that Run before the current tool call, and fixes result/snippet bounds in Core; model arguments cannot widen its authority.

Use a dedicated workspace without SSH keys, provider credentials, cloud config, production secrets, release roots, or unrelated files. The supported activation path is the receipt-backed `core_generation_activate` tool, but TAgent's tool containment is not an OS sandbox: if the Generation's OS identity can mutate the release root, permitted process tools may be able to reach it too. Apply OS/container controls for filesystem, network, process, and resource isolation when stronger containment is required.

Uploaded Skills are untrusted instructions, not capabilities. Core accepts a bounded UTF-8 `SKILL.md` or ZIP bundle, validates frontmatter, rejects absolute/traversal paths and ZIP symlinks, bounds entry count and expanded size, and stores an immutable revision below `.tagent/skills`. A Skill cannot add tools or weaken the existing approval, receipt, path, and settlement boundaries. ZIP validation is an ingestion boundary; `bash` remains subject to the process-level limitation above.

## Durable authority

The following are server-owned and cannot be asserted by a caller:

- OS instance lock, writer lease, fence, and connection mutation guard;
- canonical TaskRun/Attempt transition authority and the closed `RunEventMap` event vocabulary;
- approval and capability authorization receipts;
- Attempt-bound external-action approval consumption before mutation-capable tools, with fresh approval required before any later Attempt retries the action;
- current-Attempt Bash bindings and Core-derived check evidence;
- immutable ToolRegistry snapshots and the Core-owned ToolExecutionPipeline guard/receipt/settlement path;
- explicit external-action approval and a writer-fenced successful operation receipt before a managed Generation activation can reach the Host;
- Host-owned verified release containment, protocol compatibility, activation identity, crash budget, and post-readiness `current` commit;
- caller-owned cancellation through Runtime, subprocess, workspace, Artifact, Memory, and history seams, including distinct before-dispatch and after-invocation failure codes;
- hash-verified Attempt request envelopes persisted before provider network dispatch;
- event-consumer generation and acknowledged sequence;
- internal evaluation receipt verification;
- the single Learning integration consumer, delivery generation, checkpoint, and effect receipts.

State-changing handlers persist through guarded repositories and a synchronous Unit of Work. Losing writer authority clears readiness and shuts Core down.

## Secrets and data

Provider credentials are named in configuration by `CredentialReference` and resolved only inside trusted adapters for an outbound operation. Plaintext values must not enter `AppConfig`, TaskRun contracts, SQLite request envelopes, events, transcripts, tool payloads, browser bundles, source control, or Pi auth files. Rotation takes effect on the next resolution without rebuilding durable state. Protect SQLite/WAL/SHM, PostgreSQL, Cold Memory, logs, artifacts, release manifests, and backups according to their data sensitivity.

Memory capture and Learning policy reduce accidental persistence and promotion; they do not replace encryption, authorization, data retention review, or human approval.

See [WEB_CONSOLE_SECURITY.md](WEB_CONSOLE_SECURITY.md), [PERSISTENCE_AND_RECOVERY.md](PERSISTENCE_AND_RECOVERY.md), and the root [security policy](../SECURITY.md).
