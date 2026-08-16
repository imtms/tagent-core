# Contributing

## Development environment

Use Node.js `24.18.1` and npm `12+`.

```bash
npm ci
npm run build:packages
```

## Workspace ownership

Place code in the workspace that owns the behavior:

- `packages/abi`: versioned wire contracts and runtime codecs;
- `packages/core-client`: typed Core transport client;
- `packages/{admission,execution,governance,memory}`: domain and application policy;
- `adapters/{http-fastify,persistence-sqlite,runtime-pi,workspace-local}`: infrastructure implementations;
- `apps/core-service`: composition and lifecycle only;
- `apps/web-console`: browser application only.

Keep the dependency graph acyclic. Domain packages depend on contracts and ports, not adapters. Adapters implement ports. The Core application composes domains and adapters. The Web Console may depend only on `@tagent/abi`, `@tagent/core-client`, and third-party UI libraries. Core must not depend on the Web Console.

## Imports and public ABI

- Import another workspace only through its declared `package.json` exports.
- Do not deep-import another workspace's `src` or `dist` tree.
- Do not add root compatibility facades or unversioned HTTP routes.
- Put stable wire shapes in `@tagent/abi`; validate both ingress and egress.
- Keep supported HTTP routes under `/api/v1`.
- Use `@tagent/core-client` from channels and Web code instead of duplicating transport logic.

Follow [docs/NAMING_CONVENTIONS.md](docs/NAMING_CONVENTIONS.md). Use `TaskRun`, `Attempt`, `submission`, `event consumer`, `authority`, and `Unit of Work` consistently.

## Change workflow

When work is executed as a substantial TaskRun, follow [the TaskRun finalization workflow](docs/TASKRUN_FINALIZATION.md). Reuse existing plan keys, finish all Git, release, migration, deployment, and production operations before registering final required checks, then require every plan to be terminal and every check to be passed and non-stale before submitting the final candidate.

Before a non-trivial behavioral, contract, lifecycle, security, or testing change, search [.agents/notes](.agents/notes/README.md) for its decision owner. Update that record instead of creating a duplicate, and add a proposal first when the choice is still undecided. `npm run check` includes the `.agents` consistency gate.

1. Add or update regression tests before changing behavior.
2. Make the smallest workspace-owned change.
3. Update ABI fixtures and client behavior together when a wire contract changes.
4. Update maintained documentation for changed configuration, operations, security, or API behavior.
5. Run the relevant targeted tests, then the repository gates.

```bash
npm run lint
npm run check
npm test -- --run
npm run build
git diff --check
```

Changes to compaction or durable transcript recall also require `npm run benchmark:compaction`; keep its deterministic corpus, checked thresholds, and limitations synchronized with the owning decision record.

Changes to PostgreSQL-backed Memory also require:

```bash
TAGENT_TEST_POSTGRES_URL=postgresql://tagent_test:tagent_test@127.0.0.1:5432/tagent_memory_test \
  npx vitest run tests/postgres-memory.test.ts
```

## Persistence changes

- Never bypass the active writer fence or connection mutation guard.
- Keep multi-repository mutations inside a synchronous Unit of Work.
- Add forward migration, preflight, recovery, and rollback documentation for schema changes.
- Do not describe a code rollback as safe after a schema upgrade; rollback requires a compatible database backup.

## Documentation and releases

Maintained documents are listed in [docs/README.md](docs/README.md). Remove superseded product/operation documents after their durable facts move into a canonical document; Git history retains release evidence. Decision rationale belongs in the owning `.agents` record and must be updated or moved to `rejected/` rather than copied into another note.

Do not claim that lint, tests, audits, artifacts, migrations, or release workflows passed without fresh evidence. A release entry in [CHANGELOG.md](CHANGELOG.md) must be non-empty and describe breaking changes and upgrade requirements.
