# TAgent Core

**TAgent Core is designed by TMs and developed with AI assistance.**

TAgent Core is a durable, self-hosted control plane for an in-process coding agent. It combines Pi's model and tool loop with TAgent-owned persistence, TaskRun supervision, verification gates, operation receipts, a responsive Web workbench, scoped automation credentials, and an optional Hot/Warm/Cold long-term memory platform.

Version `0.1.3` is the current stable source release; `0.1.4` is prepared on `main` and remains unreleased until its tag is published. `0.1.0` was the first stable source release for the documented **trusted single-service deployment profile**. Stable means the supported profile has passed the repository's release gates; it does not mean that the service is a public multi-tenant sandbox.

## Highlights

- Durable SQLite sessions, messages, transcripts, TaskRuns, events, plans, checks, artifacts, continuations, queues, and operation receipts
- Deterministic completion gates with verification evidence invalidated after workspace mutations
- Transactional continuation claims, leases, recovery, and bounded automatic continuation
- Idempotent mutating tools with restart-safe `outcome_unknown` handling
- Pi `0.83.0` `AgentSession` integration for model/tool execution, retry, steering, follow-up, and compaction
- Workspace-contained `ls`, `read`, `write`, `edit`, `bash`, and `task_run` tools
- Fastify HTTP/SSE API and React workbench with queue management, run diagnostics, Markdown, and tool inspection
- Optional scoped Bearer credentials for external automation clients
- Optional PostgreSQL/pgvector memory with Local Cold Markdown pages and a Web Memory Center

## Supported 0.1 Profile

The stable `0.1.x` support boundary is:

- one trusted TAgent Core process;
- one trusted workspace;
- one SQLite control-plane database;
- Node.js `24.18.1` on Linux x64 for the production artifact;
- localhost or a private network, preferably behind an authenticated reverse proxy;
- optional memory in a single service using PostgreSQL 17, pgvector, pg_trgm, and Local Cold storage.

Not included in the stable boundary:

- public-Internet exposure without a separate authentication proxy;
- browser login, CSRF protection, or complete multi-tenant user/workspace membership;
- an operating-system sandbox for `bash`;
- multiple processes sharing one SQLite database;
- S3 Cold and independently deployed memory workers as release-gated production profiles.

Read [SECURITY.md](SECURITY.md) before deployment.

## Requirements

- Node.js `>=24.18.1`
- npm `>=12`
- an OpenAI Chat Completions-compatible provider and `OPENAI_API_KEY`
- a trusted workspace directory
- optional: PostgreSQL 17 with `vector` and `pg_trgm` when persistent memory is enabled

## Quick Start

```bash
cp .env.example .env
# Edit .env and set OPENAI_API_KEY and TAGENT_WORKSPACE.
npm ci
npm run build
npm start
```

Open <http://localhost:3100>.

For development:

```bash
npm run dev
```

The checked-in provider defaults are examples and can be replaced:

```env
TAGENT_PROVIDER=openai-compatible
TAGENT_API_BASE=https://one.tms.im/v1
TAGENT_MODEL=gpt-5.6-sol
OPENAI_API_KEY=
```

Credentials are supplied at runtime and are not written to Pi auth files, SQLite, transcripts, or source control.

## Core Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | none | Runtime model credential |
| `TAGENT_RUNTIME` | `in-process` | Runtime implementation; only `in-process` is supported |
| `TAGENT_PROVIDER` | `openai-compatible` | Pi provider identifier |
| `TAGENT_API_BASE` | `https://one.tms.im/v1` | OpenAI-compatible API base URL |
| `TAGENT_MODEL` | `gpt-5.6-sol` | Upstream model identifier |
| `TAGENT_CONTEXT_WINDOW` | `200000` | Advertised model context window |
| `TAGENT_MAX_TOKENS` | `32768` | Maximum output tokens per provider response |
| `TAGENT_PROVIDER_TIMEOUT_MS` | `120000` | Provider request timeout |
| `TAGENT_PROVIDER_MAX_RETRIES` | `1` | Pi retry count per attempt |
| `TAGENT_RUN_TIMEOUT_MS` | `7200000` | Run inactivity ceiling |
| `TAGENT_RUN_HARD_TIMEOUT_MS` | `86400000` | Absolute Run wall-clock ceiling |
| `TAGENT_MAX_CONTINUATIONS` | `128` | Automatic continuation ceiling |
| `TAGENT_MAX_RUN_TOKENS` | `8000000` | Cumulative Run hard token ceiling |
| `TAGENT_MAX_CONTEXT_TURNS` | `20` | Complete turns loaded into a new runtime |
| `TAGENT_CONTROL_INBOX_CAPACITY` | `32` | Active-Run control inbox capacity |
| `TAGENT_DYNAMIC_BUDGET` | `true` | Enable complexity-based soft budgets |
| `TAGENT_DB` | `./data/tagent.db` | SQLite database path |
| `TAGENT_WORKSPACE` | current directory | Workspace exposed to tools |
| `PORT` | `3100` | HTTP, SSE, and Web port |
| `TAGENT_SERVICE_CREDENTIALS` | none | Optional scoped Bearer credentials for automation |
| `TAGENT_MEMORY_ENABLED` | `false` | Opt in to long-term memory |

See [.env.example](.env.example) for every supported setting.

### Dynamic budgets

| Tier | Guidance checkpoint | Idle timeout |
| --- | ---: | ---: |
| simple | 80,000 tokens | 5 minutes |
| standard | 240,000 tokens | 15 minutes |
| complex | 640,000 tokens | 45 minutes |
| extended | 1,600,000 tokens | 120 minutes |

Dynamic tiers are soft guidance, not termination limits. Crossing a tier token checkpoint emits `run.token_budget.warning` and steers the active agent to compact context, avoid repeated investigation, and prioritize unresolved required work. A Run is stopped only at the configured hard ceilings `TAGENT_MAX_RUN_TOKENS`, `TAGENT_MAX_CONTINUATIONS`, or `TAGENT_RUN_HARD_TIMEOUT_MS`. This preserves a firm safety bound while allowing a normally progressing task to use the full configured allowance. Set `TAGENT_DYNAMIC_BUDGET=false` to disable tier guidance and use only the fixed limits.

## Optional Long-Term Memory

Memory is disabled by default. In disabled mode TAgent Core does not connect to PostgreSQL, initialize memory adapters or workers, or access Local Cold/S3 storage:

```env
TAGENT_MEMORY_ENABLED=false
```

To run the stable persistent Local Cold profile:

```bash
docker compose -f deploy/postgres/compose.yml up -d
```

```env
TAGENT_MEMORY_ENABLED=true
TAGENT_MEMORY_BACKEND=postgres
TAGENT_MEMORY_POSTGRES_URL=postgresql://tagent:tagent@127.0.0.1:5432/tagent_memory
TAGENT_MEMORY_COLD_BACKEND=local
TAGENT_MEMORY_COLD_PATH=./data/memory-cold
TAGENT_MEMORY_WORKSPACE_SCOPE_ID=default

# Recommended semantic-quality profile
TAGENT_MEMORY_EMBEDDING_PROVIDER=openai
TAGENT_MEMORY_EMBEDDING_BASE_URL=https://embedding-provider.example/v1
TAGENT_MEMORY_EMBEDDING_API_KEY=
TAGENT_MEMORY_EMBEDDING_MODEL=
TAGENT_MEMORY_EXTRACTOR_PROVIDER=hybrid
```

The design separates facts from preferences and uses:

```text
Hot/Warm records + lexical/vector/graph routing
                      -> Topic ID
                      -> complete immutable Cold Markdown page
```

Cold page bodies are not chunk-vectorized. Capture, persistence, embedding, publication, recall, and prompt injection pass through policy gates. The Web displays Memory Center only when memory is enabled. Start with [docs/MEMORY.md](docs/MEMORY.md).

## Execution Model

Each admitted user request is associated with a durable TaskRun:

```text
discover -> plan -> implement -> verify -> review -> done
                                             \-> blocked
```

A Run completes only when its durable completion gate passes:

- at least one required plan item exists and all required items are done;
- all required checks pass;
- verification evidence is fresh after the last workspace mutation.

Pi owns the ephemeral model/tool loop inside an attempt. TAgent Core owns durable state, operation receipts, supervision, continuation policy, transcripts, queues, and terminal completion.

## API and Authentication

The Fastify API provides health/config status, sessions, durable submissions, runs, replayable SSE events, transcripts, operations, cancellation, controls, compaction, resume, and optional memory administration.

`TAGENT_SERVICE_CREDENTIALS` enables least-privilege Bearer credentials for external automation scopes such as `sessions:read`, `sessions:write`, `runs:read`, `runs:control`, and `events:consume`. These credentials intentionally do not provide administrator/Web access.

The interactive Web and administrative routes do **not** include a built-in login boundary in `0.1.x`. Keep the service private or put it behind an authenticated reverse proxy. See [docs/core-api-contract.md](docs/core-api-contract.md).

## Security Boundary

- Run under a dedicated low-privilege operating-system account.
- Do not expose port 3100/3220 directly to the public Internet.
- Do not use a workspace containing provider keys, SSH keys, cloud credentials, or unrelated secrets.
- Treat `bash` as code execution. The command policy is a guardrail, not a sandbox.
- Keep `.env`, databases, Cold memory, logs, backups, and release artifacts out of Git.
- Back up SQLite (including WAL state) and PostgreSQL/Local Cold together before upgrades.

## Verification and Release

```bash
npm run lint
npm run check
npm test -- --run
TAGENT_TEST_POSTGRES_URL=postgresql://... npm test -- --run tests/postgres-memory.test.ts
npm run build
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
git diff --check
```

For immutable Linux x64 production artifacts:

```bash
npm run release:build
```

See [docs/PRODUCTION_DEPLOYMENT.md](docs/PRODUCTION_DEPLOYMENT.md) and [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).

## Documentation

- [Development status](docs/STATUS.md)
- [Runtime architecture](docs/RUNTIME.md)
- [Pi runtime boundary](docs/PI_RUNTIME_BOUNDARY.md)
- [Automation API contract](docs/core-api-contract.md)
- [Long-term memory](docs/MEMORY.md)
- [Memory architecture](docs/MEMORY_ARCHITECTURE.md)
- [Memory operations](docs/MEMORY_OPERATIONS.md)
- [Memory API and UI](docs/MEMORY_API.md)
- [Security policy](SECURITY.md)
- [0.1.0 release audit](docs/RELEASE_AUDIT_0.1.0.md)
- [0.1.4 release audit](docs/RELEASE_AUDIT_0.1.4.md)
- [Changelog](CHANGELOG.md)

## Authorship and License

TAgent Core was **designed by TMs** and **developed with AI assistance**, under TMs's direction and review. AI assistance is a development method and does not replace human project ownership or release accountability.

Copyright (c) 2026 TMs and TAgent Core contributors.

Licensed under the [MIT License](LICENSE).
