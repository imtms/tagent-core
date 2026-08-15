# Deployment and Gateway

## Deployment model

Deploy three separate boundaries:

```text
Browser -> Web Console static host -> identity Gateway -> private TAgent Core
```

The Web host may also be the Gateway host, but Web assets and Core remain independent artifacts. Core is API-only and listens on `127.0.0.1:3100` by default.

The v1 Channel, base Operator profile, independent Operator Read profile, and eight full-feature capability profiles are ready for Gateway integration. Core readiness cannot prove Gateway-local identity, persistence, routing, or external delivery; both repositories must pass their own release gates.

## Production prerequisites

- Linux x64 and Node.js `24.18.1` / ABI 137;
- a dedicated low-privilege Core OS account;
- a private Core listener inaccessible from the public Internet;
- a new writable SQLite path and a dedicated tool workspace;
- a Gateway that validates OIDC and translates identity to opaque scoped Core credentials;
- independent static hosting for the Web Console;
- consistent backup for the current SQLite schema and optional Memory stores.

## Artifacts

The release workflow publishes four version-matched artifacts and their checksums:

- `tagent-core-<tag>-linux-x64-node24-abi137.tar.gz`;
- `tagent-web-console-<tag>.tar.gz`;
- `tagent-abi-<version>.tgz`;
- `tagent-core-client-<version>.tgz`.

Core and Web archives contain a release manifest and commit marker. The Core archive materializes required runtime workspaces, contains no Web assets or symbolic links, and includes the native SQLite binding. SDK archives contain compiled exports, declarations, source maps, and package metadata.

## Core configuration

Minimum private Channel configuration:

```env
HOST=127.0.0.1
PORT=3100
TAGENT_DB=/var/lib/tagent/tagent.db
TAGENT_WORKSPACE=/srv/tagent/workspace
TAGENT_SERVICE_CREDENTIALS=[{"token":"REPLACE_WITH_24_PLUS_CHAR_TOKEN","scopes":["sessions:read","sessions:write","runs:read","runs:control","events:consume"]}]
```

Add the fine-grained Operator/Admin scopes and resource grants only for enabled capability profiles. If a browser origin reaches Core directly, use an exact allowlist:

```env
TAGENT_CORS_ALLOWED_ORIGINS=https://console.example.com
```

Do not put provider keys or Core credentials in the Web artifact.

## Fresh database requirement

Core 0.8 creates one current schema identified by `tagent-core/0.8` and reports numeric schema version `1`. It accepts only an empty database or an exact current-schema database. Earlier Core databases are not upgraded.

Before first start, stop all writers and point `TAGENT_DB` at a nonexistent file or verified empty database. A marker mismatch or schema drift is a deployment failure; create a new database instead of editing the marker or copying rows.

## Deployment order

Use a Core-before-Gateway order: establish writer readiness, validate replay and ACK watermarks, and only then reopen Gateway traffic.

1. stop new Gateway traffic and all Core writers;
2. verify Core, Web, ABI, and Core Client checksums and release manifests;
3. provision a new empty SQLite path and matching optional Memory stores;
4. validate the production credential and resource-scope configuration;
5. start Core and require `/api/v1/health` to report `data.ok=true` and `data.writer.ready=true`;
6. require base capabilities to report schema version `1`, current catalogs, Operator endpoints, ready Approval, receipt recovery, retention, limits, and `operator.read.v1`;
7. validate Operator Read and every enabled capability-profile summary/detail using the real Gateway principal;
8. start one Gateway consumer, claim a generation, replay, persist, and then ACK;
9. run `scripts/gateway-readiness-probe.mjs` and require zero lag/ACK gaps, no unknown or stale receipts, and `learningProjectionReady=true`;
10. deploy the matching Web artifact with its Gateway/Core origin and reopen traffic.

See [GATEWAY_PRODUCTION_READINESS.md](GATEWAY_PRODUCTION_READINESS.md) for exact commands and thresholds.

## Immutable Core deployment

The Core archive includes `scripts/deploy-release.sh`. It verifies paths, rejects links, verifies the release manifest/runtime, installs an immutable commit directory, switches `current`, restarts systemd, and probes health.

```bash
sudo TAGENT_HEALTH_URL=http://127.0.0.1:3100/api/v1/health \
  /path/to/deploy-release.sh /path/to/tagent-core-v0.8.4-linux-x64-node24-abi137.tar.gz
```

The script changes the binary pointer only. It does not transform database state.

## Gateway command and event boundary

Gateway persists its external intent before calling Core, uses stable Session/Submission/command/Goal identities, and queries the original receipt after ambiguous network failure. Core never accepts browser identity as authority and never receives channel SDK objects or platform secrets.

Gateway persists each SSE event under the exact consumer generation and event identity before ACK. `blocked` is settled but recoverable, not final. Slow consumers reconnect from durable ACK; Core bounds replay reads at 256 rows and replay/live buffering at 1,000 events. Operator Read provides authoritative inventory for rebuilding a disposable Gateway projection.

## Backup and rollback

Back up only while Core is stopped, copying SQLite with its WAL/SHM files as one recovery set and recording the release tag, commit, checksum, configuration, schema ID, and optional Memory state. Test restore with the identical release artifact.

A rollback build may reuse a database only when it accepts the exact `tagent-core/0.8` schema and current ABI/profile tuple. Otherwise keep the current release running or deploy the replacement with a new empty database. Never point an incompatible binary at the current database or overwrite live database files.

## Web deployment

Build-time configuration:

```env
VITE_TAGENT_CORE_ORIGIN=https://api.example.com
```

Serve the unpacked `dist` directory as immutable static content. Use HTTPS, cache hashed assets, disable caching for `index.html`, and review browser security headers. The Web Console has no built-in OIDC login/refresh interface; the hosting integration owns those flows.
