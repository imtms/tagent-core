# Deployment and Gateway

## Deployment model

Deploy three separate boundaries:

```text
Browser -> Web Console static host -> identity Gateway -> private TAgent Core
```

The Web host may also be the Gateway host, but Web assets and Core remain independent artifacts. Core is API-only and listens on `127.0.0.1:3100` by default.

The schema-40 Channel and declared Operator profiles are ready for Gateway integration. Review [GATEWAY_HANDOFF_STATUS.md](GATEWAY_HANDOFF_STATUS.md) for the exact Core/Gateway responsibility boundary. Production cutover still requires both repositories' release gates; Core readiness cannot prove Gateway-local persistence, identity or external delivery behavior.

## Production prerequisites

- Linux x64, Node.js `24.18.1`, Node ABI 137;
- one dedicated low-privilege Core OS account;
- one writable SQLite data directory and one trusted tool workspace;
- a private Core listener inaccessible from the public Internet;
- a Gateway that validates OIDC and translates identity to opaque scoped Core credentials;
- an independent static-hosting path for the Web Console;
- consistent backup for SQLite/WAL/SHM and optional Memory stores.

## Artifacts

`scripts/build-release.sh` produces:

- `tagent-core-<commit>-linux-x64-node24-abi137.tar.gz` plus checksum;
- `tagent-web-console-<commit>.tar.gz` plus checksum.

Both contain a release manifest and commit marker. The Core archive materializes runtime workspaces, rejects symbolic links and unexpected files, and excludes Web assets.

The tag-triggered release workflow builds both archives in one release job, uploads both archives and checksums as a 30-day Actions artifact, and attaches all four files to the GitHub Release.

## Core configuration

Minimum production boundary:

```env
HOST=127.0.0.1
PORT=3100
TAGENT_DB=/var/lib/tagent/tagent.db
TAGENT_WORKSPACE=/srv/tagent/workspace
TAGENT_GOVERNANCE_APPROVAL_AUTHORITY=legacy
TAGENT_SERVICE_CREDENTIALS=[{"token":"REPLACE_WITH_24_PLUS_CHAR_TOKEN","scopes":["sessions:read","sessions:write","runs:read","runs:control","events:consume"]}]
```

If the browser origin reaches Core directly, set an exact allowlist:

```env
TAGENT_CORS_ALLOWED_ORIGINS=https://console.example.com
```

Do not put provider keys or Core credentials in the Web artifact.

The current release keeps legacy approval handlers authoritative while schema 31 canonical projections and receipts are validated. Requesting `canonical` fails closed because the release does not declare canonical request/decide/consume/execute handlers ready.

## Deployment order

Use Core-before-Gateway order:

1. stop new Gateway traffic;
2. stop the old Core writer and confirm its process/lease is gone;
3. back up SQLite with WAL/SHM, optional PostgreSQL/Cold state, current artifact, config, and watermarks;
4. verify the Core archive and checksum;
5. switch to the new Core artifact and start it;
6. allow migration to schema 40; if `migration_issues` contains an open row, correct the source data rather than bypassing the ledger;
7. require `GET /api/v1/health` to report `data.ok=true` and `data.writer.ready=true`;
8. require `GET /api/v1/capabilities` to report schema 40, the required command/event catalogs, Operator endpoint allowlist, active Approval authority, exact receipt-recovery protocol, retention policy and current limits;
9. start one Gateway consumer, claim a new event-consumer generation, replay, persist, then ACK;
10. run the readiness probe and require zero lag, no settled/final unacknowledged events, no `outcome_unknown` receipts and no stale `started` receipts;
11. deploy the matching Web artifact with its Gateway origin;
12. reopen traffic and monitor writer fence, command/Goal receipt counts and age, consumer lag, Learning authority, and provider errors.

Use [GATEWAY_PRODUCTION_READINESS.md](GATEWAY_PRODUCTION_READINESS.md) for exact gates.

## Immutable Core deployment

The Core archive includes `scripts/deploy-release.sh`. The script verifies archive paths, rejects links, verifies the release manifest and runtime, installs an immutable commit directory, switches the `current` symlink, restarts systemd, and probes `/api/v1/health`.

```bash
sudo TAGENT_HEALTH_URL=http://127.0.0.1:3100/api/v1/health \
  /path/to/deploy-release.sh /path/to/tagent-core-COMMIT-linux-x64-node24-abi137.tar.gz
```

The script's service rollback changes the binary pointer only. It does not downgrade a migrated database.

## Gateway command boundary

Gateway must persist its own external intent before calling Core, use stable Session/Submission/command/Goal request identities, and query Core receipts after ambiguous network failures. Core never accepts browser identity as authority and never receives Telegram/Feishu SDK objects or platform secrets. Gateway must persist each SSE event before ACK and treat `blocked` as settled but recoverable, not final.

Core bounds SSE replay at 256 rows per database read and the replay/live handoff at 1,000 events. A closed slow-consumer stream is reconnected from its durable ACK. Current v40 retention does not automatically delete TaskRun events or expire cursors.

## Backup and rollback

Code rollback within schema 40 requires a binary that understands schema 40 and the current ABI window. Rollback to an older incompatible release requires stopping all writers and restoring the matching pre-upgrade SQLite/WAL/SHM backup plus the matching Memory state.

Never run a schema-39-only or otherwise incompatible binary against schema 40 and never overwrite a live schema 40 database with partial old files. Preserve the last successful capability negotiation, readiness snapshot, command/Goal receipts and consumer/learning watermarks before changing Gateway ownership.

## Web deployment

Build-time configuration:

```env
VITE_TAGENT_CORE_ORIGIN=https://api.example.com
```

Serve the unpacked `dist` directory as immutable static content. Configure HTTPS, cache policy for hashed assets, no-cache for `index.html`, and reviewed browser security headers. The Web Console has no built-in OIDC login/refresh interface; the hosting integration owns those flows.
