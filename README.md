# TAgent Core

A minimal persistent TAgent control plane built around [`@mariozechner/pi-agent-core`](https://www.npmjs.com/package/@mariozechner/pi-agent-core).

## Current scope

- Persistent sessions and messages in SQLite
- Durable TaskRun state with plans, checks, artifacts, ordered events, and a deterministic completion gate
- pi agent runtime adapter with streaming events, cancellation, and steering
- Workspace-scoped `read`, `write`, `edit`, `bash`, and `task_run` tools
- Fastify HTTP/SSE API
- Responsive React workbench for conversations and TaskRun visibility

Knowledge, memory, scheduling, policy, and worker modules are intentionally left outside the core and can be added behind explicit interfaces later.

## Run

```bash
cp .env.example .env
# Set the provider API key in your shell or environment.
npm install
npm run build
npm start
```

Open http://localhost:3100.

Development mode:

```bash
npm run dev
```

## Configuration

- `TAGENT_PROVIDER`: pi provider ID, default `openai`
- `TAGENT_MODEL`: pi model ID, default `gpt-4o-mini`
- Provider API keys use the environment variables recognized by `@mariozechner/pi-ai`, such as `OPENAI_API_KEY`
- `TAGENT_DB`: SQLite path, default `./data/tagent.db`
- `TAGENT_WORKSPACE`: tool workspace, default current directory in production setup
- `PORT`: API and Web port, default `3100`

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
PiRuntimeAdapter       TaskRun gate
      |
pi agent core
      |
workspace tools
```

pi owns the bounded model/tool loop. TAgent Core owns durable identity, execution state, event ordering, evidence, and completion.
