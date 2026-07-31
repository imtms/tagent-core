# TAgent Core

TAgent Core is a durable control plane for an in-process coding agent. It combines Pi's model and tool loop with TAgent-owned persistence, execution state, verification gates, operation receipts, and a Web workbench.

The current release is `0.1.0-alpha.1`. It is intended for one trusted process, one trusted workspace, and localhost or private-network deployment. It does not provide built-in API authentication, multi-tenant isolation, or an operating-system sandbox.

## What It Provides

- SQLite sessions, messages, transcripts, TaskRuns, events, plans, checks, artifacts, continuations, and operation receipts
- Deterministic completion gates with fresh verification evidence
- Transactional continuation claims, leases, recovery, and bounded automatic continuation
- Idempotent mutating tools with restart-safe `outcome_unknown` handling
- Repeated-call and repeated-failure tool guards
- Pi `0.83.0` `AgentSession` lifecycle, steering, follow-up, retry, and compaction
- Workspace-contained `ls`, `read`, `write`, `edit`, `bash`, and `task_run` tools
- Fastify HTTP/SSE API and a responsive React workbench
- Safe Markdown and paired transcript tool-call inspection

Long-term memory is an optional adapter-based extension and is disabled by default. Scheduling, identity, multi-channel delivery, and isolated workers remain outside this repository's current core.

## Optional Long-Term Memory

Long-term memory is opt-in. With the default setting below, TAgent Core does not initialize memory adapters, workers, PostgreSQL, pgvector, S3, or Local Cold storage. It retains only the original SQLite session/TaskRun history and can be installed and run without any memory service:

```env
TAGENT_MEMORY_ENABLED=false
```

To enable the persistent single-service Local Cold profile:

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
```

Requirements when enabled with this profile:

- PostgreSQL 17 with the `vector` extension (the supplied Compose file uses `pgvector/pgvector:pg17`);
- a reachable database and valid `TAGENT_MEMORY_POSTGRES_URL`;
- a writable `TAGENT_MEMORY_COLD_PATH`;
- enough database/filesystem capacity for Hot/Warm records, vectors, graph metadata, jobs, and immutable Cold revisions.

`TAGENT_MEMORY_BACKEND=memory` is available for development/testing without PostgreSQL, but its Hot/Warm metadata and indexes are not durable. `TAGENT_MEMORY_COLD_BACKEND=s3` additionally requires `TAGENT_MEMORY_S3_BUCKET` and AWS-compatible credentials/settings. Invalid or missing memory-only settings fail startup only when memory is enabled. See `docs/MEMORY_OPERATIONS.md` for details.

## Pi Integration

TAgent Core uses the current latest Pi packages:

```text
@earendil-works/pi-ai             0.83.0
@earendil-works/pi-agent-core     0.83.0
@earendil-works/pi-coding-agent   0.83.0
```

The primary runtime embeds Pi through its official SDK rather than launching the Pi CLI or RPC process.

### LLM and Provider Injection

The configured endpoint is an OpenAI Chat Completions-compatible custom provider. TAgent initializes it in this order:

1. Create an offline `ModelRuntime` with no `models.json` path.
2. Register the custom provider and model when the provider is not already known.
3. Refresh the model runtime with network catalog refresh disabled.
4. Apply `OPENAI_API_KEY` through `setRuntimeApiKey()`.
5. Pass the same `ModelRuntime` and explicit `Model` to `createAgentSession()`.

This follows Pi `0.83.0` SDK authentication precedence: runtime override, stored credential, environment variable, then custom-provider fallback. The runtime override is process-memory only and is not written to `auth.json`, `models.json`, SQLite, events, or transcripts.

TAgent does not set `authHeader: true`. Pi's standard `openai-completions` implementation already turns the resolved API key into the expected Bearer authorization header. `authHeader` is reserved for providers whose non-standard API requires Pi to synthesize that header explicitly.

TAgent also supplies:

- `SessionManager.inMemory()` because SQLite is the durable source of truth
- `SettingsManager.inMemory()` for bounded retry and compaction settings
- a controlled `DefaultResourceLoader` with project extensions, skills, prompts, themes, and context-file discovery disabled
- a per-Run system prompt through `systemPromptOverride`
- TAgent-owned custom tools with Pi built-in tools disabled

See Pi's bundled official documentation in `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`, `providers.md`, `models.md`, and `custom-provider.md`.

## Requirements

- Node.js `>=24.18.1`
- npm `>=12`
- A provider API key available as `OPENAI_API_KEY`
- A trusted workspace directory

## Quick Start

```bash
cp .env.example .env
# Set OPENAI_API_KEY without committing it.
npm install
npm run build
npm start
```

Open http://localhost:3100.

For development:

```bash
npm run dev
```

The default endpoint is:

```text
provider: openai-compatible
api:      openai-completions
base URL: https://one.tms.im/v1
model:    gpt-5.6-sol
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | none | Runtime-only credential for the configured provider |
| `TAGENT_RUNTIME` | `in-process` | Runtime implementation; only `in-process` is enabled |
| `TAGENT_PROVIDER` | `openai-compatible` | Pi provider ID recorded in model messages |
| `TAGENT_API_BASE` | `https://one.tms.im/v1` | OpenAI-compatible API base URL |
| `TAGENT_MODEL` | `gpt-5.6-sol` | Upstream model ID |
| `TAGENT_CONTEXT_WINDOW` | `200000` | Advertised model context window |
| `TAGENT_MAX_TOKENS` | `32768` | Maximum model output tokens |
| `TAGENT_REASONING` | `true` | Enable reasoning metadata and Pi medium thinking level |
| `TAGENT_PROVIDER_TIMEOUT_MS` | `120000` | Timeout applied to one provider request |
| `TAGENT_PROVIDER_MAX_RETRIES` | `1` | Pi automatic retry count per session attempt |
| `TAGENT_RUN_TIMEOUT_MS` | `7200000` | Hard ceiling for Run inactivity; dynamic tiers may choose a lower threshold |
| `TAGENT_RUN_HARD_TIMEOUT_MS` | `86400000` | Absolute wall-clock ceiling for one Run attempt |
| `TAGENT_MAX_CONTINUATIONS` | `128` | Hard automatic continuation ceiling |
| `TAGENT_MAX_RUN_TOKENS` | `2000000` | Hard cumulative Run token ceiling |
| `TAGENT_MAX_CONTEXT_TURNS` | `20` | Maximum complete turns loaded into a new runtime context |
| `TAGENT_CONTROL_INBOX_CAPACITY` | `32` | Maximum queued/delivering steer and follow-up controls for an active Run attempt. |
| `TAGENT_CONTEXT_RESERVE_TOKENS` | automatic | Optional explicit context safety reserve |
| `TAGENT_DYNAMIC_BUDGET` | `true` | Enable complexity-based soft budgets |
| `TAGENT_DB` | `./data/tagent.db` | SQLite database path |
| `TAGENT_WORKSPACE` | current directory | Root exposed to TAgent tools |
| `PORT` | `3100` | HTTP, SSE, and Web port |
| `TAGENT_MEMORY_ENABLED` | `false` | Opt in to the long-term memory platform; disabled mode requires no memory services |

Dynamic budget defaults:

| Tier | Continuations | Cumulative tokens | Idle timeout |
| --- | ---: | ---: | ---: |
| simple | 4 | 80,000 | 5 minutes |
| standard | 12 | 240,000 | 15 minutes |
| complex | 32 | 640,000 | 45 minutes |
| extended | 96 | 1,600,000 | 120 minutes |

Environment values remain hard ceilings. Set `TAGENT_DYNAMIC_BUDGET=false` to use the hard limits directly.

## Execution Model

Each user request creates or reuses a durable TaskRun:

```text
discover -> plan -> implement -> verify -> review -> done
                                             \-> blocked
```

Structured plan, mutation, and check actions advance the phase monotonically. The model cannot move a Run backward to an earlier phase.

A Run completes only when its completion gate passes:

- at least one required plan item exists and every required item is done
- every required check is passed
- passed evidence is not stale after a workspace mutation

If the gate blocks completion, TAgent may claim a persisted continuation lease and start another attempt with the transcript and TaskRun snapshot restored. Continuations stop at configured count, token, idle-time, and wall-clock limits.

Pi owns the ephemeral model/tool loop, retry, queue delivery, and context compaction within one attempt. TAgent owns durable identity, state transitions, transcript audit, operation receipts, continuation policy, and terminal completion.

## API Surface

The Fastify API exposes:

- health and public runtime status
- session creation and history
- message submission and Run creation
- Run inspection, event replay, operations, transcripts, and transcript views
- cancellation, steering, follow-up, manual compaction, and manual resume

Run events are replayable over SSE using monotonically increasing per-Run sequence numbers.

The API is not authenticated in this alpha. Do not expose it directly to the public Internet.

## Architecture

```text
React workbench
      |
Fastify HTTP + SSE
      |
AgentService ---------------- SQLite Store
      |                            |
AgentRuntime                  TaskRun gate
      |
Pi 0.83 AgentSession
      |
ModelRuntime + custom provider
      |
TAgent-owned tools
```

The `AgentRuntime` boundary keeps Pi-specific classes and events out of the durable control-plane schema and leaves room for isolated worker adapters later.

## Security Boundary

- Run one process against one SQLite database and one trusted workspace.
- Bind to localhost or place the service behind an authenticated private-network reverse proxy.
- Run under a dedicated low-privilege operating-system account.
- Do not place credentials, SSH keys, cloud configuration, or unrelated sensitive files in the tool workspace.
- Treat `bash` as code execution. The denylist is a guardrail, not a sandbox.
- Keep `.env`, provider credentials, SQLite files, logs, and artifacts out of source control.

Read [SECURITY.md](SECURITY.md) before deployment.

## Verification

```bash
npm run lint
npm run check
npm test -- --run
npm run build
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
```

The repository includes integration coverage for custom-provider registration, runtime credential resolution, Bearer authentication, retries, steering, follow-up, cancellation during initialization, active-tool abort, transcript persistence, continuation recovery, and completion gates.

## Project Documents

- [Development status](docs/STATUS.md)
- [Runtime boundary and worker direction](docs/RUNTIME.md)
- [Release checklist](docs/RELEASE_CHECKLIST.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

This repository remains an alpha control-plane core, not the complete TAgent product.
