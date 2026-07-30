# TAgent Core

A minimal persistent TAgent control plane built around [`@mariozechner/pi-agent-core`](https://www.npmjs.com/package/@mariozechner/pi-agent-core).

Project records:

- [Development status](docs/STATUS.md)
- [Agent runtime decision](docs/RUNTIME.md)

## Current scope

- Persistent sessions and messages in SQLite
- Durable TaskRun state with plans, checks, artifacts, ordered events, and a deterministic completion gate
- Replaceable AgentRuntime boundary with an in-process pi implementation
- Streaming events, cancellation, and steering
- Workspace-scoped `read`, `write`, `edit`, `bash`, and `task_run` tools
- Fastify HTTP/SSE API
- Responsive React workbench for conversations and TaskRun visibility

Knowledge, memory, scheduling, policy, and worker modules remain outside the core and will be added behind explicit interfaces.

## Run

```bash
cp .env.example .env
# Set OPENAI_API_KEY in the environment. Do not commit it.
npm install
npm run build
npm start
```

Open http://localhost:3100.

Development mode:

```bash
npm run dev
```

## Default model

TAgent Core uses an explicit OpenAI-compatible model instead of pi's built-in OpenAI catalog:

- API: `openai-completions`
- Base URL: `https://one.tms.im/v1`
- Model: `gpt-5.6-sol`
- API key: `OPENAI_API_KEY`

The base URL is configurable because OpenAI-compatible services are not guaranteed to use `https://api.openai.com/v1`.

## Configuration

- `TAGENT_RUNTIME`: enabled runtime, currently `in-process`
- `TAGENT_PROVIDER`: provider label persisted in pi messages, default `openai-compatible`
- `TAGENT_API_BASE`: OpenAI-compatible API base, default `https://one.tms.im/v1`
- `TAGENT_MODEL`: model ID, default `gpt-5.6-sol`
- `TAGENT_CONTEXT_WINDOW`: advertised context size, default `200000`
- `TAGENT_MAX_TOKENS`: maximum output tokens, default `32768`
- `TAGENT_REASONING`: enable reasoning metadata, default `true`
- `TAGENT_PROVIDER_TIMEOUT_MS`: timeout for each provider request, default `120000`
- `TAGENT_PROVIDER_MAX_RETRIES`: provider retry count, default `1`
- `TAGENT_RUN_TIMEOUT_MS`: hard wall-clock ceiling for a run attempt, default `7200000`
- `TAGENT_MAX_CONTINUATIONS`: hard continuation ceiling, default `128`
- `TAGENT_MAX_RUN_TOKENS`: hard cumulative token ceiling, default `2000000`
- `TAGENT_DYNAMIC_BUDGET`: enable task/progress-based soft budgets, default `true`
- `OPENAI_API_KEY`: credential sent to the OpenAI-compatible provider
- `TAGENT_DB`: SQLite path, default `./data/tagent.db`
- `TAGENT_WORKSPACE`: tool workspace, default current directory unless configured
- `PORT`: API and Web port, default `3100`

Dynamic budgets are recomputed from the goal, required plan/check surface, remaining work, and continuation history. The default tiers are:

| Tier | Continuations | Cumulative tokens | Attempt timeout |
| --- | ---: | ---: | ---: |
| simple | 4 | 80,000 | 5 minutes |
| standard | 12 | 240,000 | 15 minutes |
| complex | 32 | 640,000 | 45 minutes |
| extended | 96 | 1,600,000 | 120 minutes |

Environment limits remain hard ceilings. Set `TAGENT_DYNAMIC_BUDGET=false` to use the hard limits directly.

## Runtime scheduling

The primary interactive agent uses pi in-process. This keeps TAgent-owned tools, event persistence, cancellation, and TaskRun updates in one control-plane process.

pi RPC is planned for isolated and concurrent worker tasks. The AgentRuntime factory added to the core prevents pi-specific implementation details from leaking into AgentService. See [Agent runtime decision](docs/RUNTIME.md) for the criteria and migration gates.

## Verification

```bash
npm run check
npm test
npm run build
npm audit --omit=dev
```

## Architecture

```text
React workbench
      |
Fastify HTTP + SSE
      |
AgentService -------- SQLite Store
      |                   |
AgentRuntime Factory   TaskRun gate
      |
In-process pi adapter
      |
TAgent-owned tools
```

pi owns the bounded model/tool loop. TAgent Core owns durable identity, execution state, event ordering, evidence, policy boundaries, and completion.
