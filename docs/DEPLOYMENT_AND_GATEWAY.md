# Deployment and Gateway

## Deployment model

Deploy three separate boundaries:

```text
Browser -> Web Console static host -> identity Gateway -> private TAgent Core
```

The Web host may also be the Gateway host, but Web assets and Core remain independent artifacts. Core is API-only and listens on `127.0.0.1:3100` by default.

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

0.2.0 keeps legacy approval handlers authoritative while schema 31 canonical projections and receipts are validated. Requesting `canonical` fails closed because the release does not declare canonical request/decide/consume handlers ready.

## Deployment order

Use Core-before-Gateway order:

1. stop new Gateway traffic;
2. stop the old Core writer and confirm its process/lease is gone;
3. back up SQLite with WAL/SHM, optional PostgreSQL/Cold state, current artifact, config, and watermarks;
4. verify the Core archive and checksum;
5. switch to the new Core artifact and start it;
6. allow migration to schema 33 and resolve no issue by bypassing `migration_issues`;
7. require `GET /api/v1/health` to report `data.ok=true` and `data.writer.ready=true`;
8. start one Gateway consumer, claim a new event-consumer generation, replay, persist, then ACK;
9. run the readiness probe and require zero lag and no terminal unacknowledged events;
10. deploy the matching Web artifact with its Gateway origin;
11. reopen traffic and monitor writer fence, consumer lag, Learning authority, and provider errors.

Use [GATEWAY_PRODUCTION_READINESS.md](GATEWAY_PRODUCTION_READINESS.md) for exact gates.

## Immutable Core deployment

The Core archive includes `scripts/deploy-release.sh`. The script verifies archive paths, rejects links, verifies the release manifest and runtime, installs an immutable commit directory, switches the `current` symlink, restarts systemd, and probes `/api/v1/health`.

```bash
sudo TAGENT_HEALTH_URL=http://127.0.0.1:3100/api/v1/health \
  /path/to/deploy-release.sh /path/to/tagent-core-COMMIT-linux-x64-node24-abi137.tar.gz
```

The script's service rollback changes the binary pointer only. It does not downgrade a migrated database.

## Backup and rollback

Code rollback within schema 33 requires a binary that understands schema 33 and the v1 contracts. Rollback to 0.1.x requires stopping all writers and restoring the matching pre-upgrade SQLite/WAL/SHM backup plus the matching Memory state.

Never run 0.1.x against schema 33 and never overwrite a live schema 33 database with partial old files. Preserve the last successful readiness snapshot and consumer/learning watermarks before changing Gateway ownership.

## Web deployment

Build-time configuration:

```env
VITE_TAGENT_CORE_ORIGIN=https://api.example.com
```

Serve the unpacked `dist` directory as immutable static content. Configure HTTPS, cache policy for hashed assets, no-cache for `index.html`, and reviewed browser security headers. The Web Console has no built-in OIDC login/refresh interface; the hosting integration owns those flows.
