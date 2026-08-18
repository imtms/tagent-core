# Deployment and Gateway

## Deployment model

Deploy three separate boundaries:

```text
Browser -> Web Console static host -> identity Gateway -> private TAgent Core
```

The Web host may also be the Gateway host, but Web assets and Core remain independent artifacts. Core is API-only and listens on `127.0.0.1:3100` by default.

Core is one product and one systemd service with two local process layers:

```text
systemd -> stable Core Host -> replaceable Core Generation -> SQLite / Runtime / HTTP
```

The Host verifies immutable releases, supervises exactly one Generation, bounds crash restart/backoff, and performs activation/rollback. It does not import application composition, listen for HTTP, or open the Core database. The Generation remains the modular monolith and the only database writer. This is not a second updater service.

The v1 Channel, base Operator profile, independent Operator Read profile, and five capability profiles are ready for Gateway integration. Core readiness cannot prove Gateway-local identity, persistence, routing, or external delivery; both repositories must pass their own release gates.

## Production prerequisites

- Linux x64 and Node.js `24.18.1` / ABI 137;
- a dedicated low-privilege Core OS account;
- a private Core listener inaccessible from the public Internet;
- a new writable SQLite path and a dedicated tool workspace;
- a Gateway that validates OIDC and translates identity to opaque scoped Core credentials;
- independent static hosting for the Web Console;
- consistent backup for the current SQLite schema and optional Memory stores.
- a release root whose `runtime` directory and `current` link are writable by the Core service account, while staged release contents remain read-only.

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

## Database revision gate

Core 0.8 keeps schema ID `tagent-core/0.8` and reports numeric revision `2`. It creates an empty database through the ordered migration runner and upgrades the exact legacy revision-1 (including pre-`user_version`) 0.8 shape without losing rows. The append-only migration journal, checksums, revision, and complete schema shape are verified on every open.

Before the first revision-2 start, stop all writers and back up SQLite together with WAL/SHM files. A marker mismatch, newer revision, journal mismatch, or schema drift is a deployment failure; restore a verified backup instead of editing metadata or copying rows.

## Deployment order

Use a Core-before-Gateway order: establish writer readiness, validate replay and ACK watermarks, and only then reopen Gateway traffic.

1. stop new Gateway traffic and all Core writers;
2. verify Core, Web, ABI, and Core Client checksums and release manifests;
3. back up and validate the existing exact revision-1 database, or provision an empty SQLite path, plus matching optional Memory stores;
4. validate the production credential and resource-scope configuration;
5. start Core and require `/api/v1/health` to report `data.ok=true` and `data.writer.ready=true`;
6. require base capabilities to report schema version `2`, current catalogs, Operator endpoints, ready Approval, receipt recovery, retention, limits, and `operator.read.v1`;
7. validate Operator Read and every enabled capability-profile summary/detail using the real Gateway principal;
8. start one Gateway consumer, claim a generation, replay, persist, and then ACK;
9. run `scripts/gateway-readiness-probe.mjs` and require zero lag/ACK gaps plus no unknown or stale receipts;
10. deploy the matching Web artifact with its Gateway/Core origin and reopen traffic.

See [GATEWAY_PRODUCTION_READINESS.md](GATEWAY_PRODUCTION_READINESS.md) for exact commands and thresholds.

## Immutable Core deployment

The Core archive includes `scripts/deploy-release.sh`. It rejects unsafe archive entries, verifies the manifest/runtime and both Host/Generation entrypoints, and stages the commit under `<release-root>/releases/<commit>`. The integrity verifier comes from the already trusted deployment tool, never from the candidate. When deployment runs as root, the candidate native SQLite smoke test runs with an empty environment as `TAGENT_SERVICE_USER` (default `tagent`), so candidate native code is not executed with root authority. The trusted verifier must therefore be readable by that account. The script does not switch an existing `current`, restart systemd, or probe health. On the first installation only, it initializes `current` so the Host has a boot target.

```bash
sudo /path/to/deploy-release.sh \
  /path/to/tagent-core-v0.8.7-linux-x64-node24-abi137.tar.gz \
  /opt/tagent-core
```

Set `TAGENT_SERVICE_USER` when the systemd account is not `tagent`. Run the deployment path with root ownership so published release directories and files settle at modes `0555`/`0444`; the service account needs read/execute access but no release-content write access.

For an already running installation, submit `core_generation_activate` with the staged 40-character commit. The tool is available only under a managed immutable Host and always consumes an explicit human external-action approval. Its exact parameters are stored in a writer-fenced operation receipt before the Host is notified. `targetRelease=current` performs a same-release Generation restart.

The Host drains Runtime and background work, prepares a durable TaskRun handoff, releases writer authority, and starts the candidate. `READY` proves HTTP/writer bootstrap, but is not an immediate commit: the candidate must keep sending a writer-fenced IPC heartbeat through the default 12-second stabilization period. Only then does the Host change `current` and settle the activation. A pre-commit crash or heartbeat timeout restores the previous release and resumes the handoff there. A short API readiness gap is intentional; the Host does not proxy HTTP or allow overlapping SQLite writers.

The Generation emits Host heartbeats every 2 seconds; the Host treats 10 seconds without a valid advancing heartbeat as an unresponsive process and feeds that termination through the durable crash budget/restart path. During intentional drain, the 30-second drain deadline replaces the heartbeat deadline. `/api/v1/health` includes the Host-published Generation/release, activation phase, request identity, and crash-budget status when Core is Host-managed.

One suitable systemd boundary is:

```ini
[Unit]
StartLimitIntervalSec=10min
StartLimitBurst=6

[Service]
Type=simple
User=tagent
Group=tagent
WorkingDirectory=/opt/tagent-core/current
Environment=TAGENT_RELEASE_ROOT=/opt/tagent-core
EnvironmentFile=/etc/tagent-core.env
ExecStart=/usr/bin/node /opt/tagent-core/current/dist/host.js
Restart=on-failure
RestartSec=5s
KillMode=control-group
TimeoutStopSec=45s
```

The service account must be able to atomically replace `/opt/tagent-core/current` and write `/opt/tagent-core/runtime/activation.json`. Only the deployment path should add verified directories under `/opt/tagent-core/releases`; their root-owned contents are made read-only. Generation failures before `READY`, heartbeat failures, and later crashes all consume the Host's persistent five-crash/ten-minute budget. A Generation crash is normally handled inside the Host. systemd remains the recovery boundary if the Host itself exits or exhausts that budget; its start limit prevents an infinite Host restart loop.

Ordinary compatible releases replace only the Generation. The current heartbeat/status contract is Host IPC protocol v2. A Host implementation or Host IPC protocol change still requires a conventional full systemd restart and a release whose manifest declares the matching protocol.

### Manual disaster switch

Use this only when the Agent path is unavailable. Stop the service first, verify the target with the currently trusted verifier, atomically replace `current`, then start and check writer readiness:

```bash
sudo systemctl stop tagent-core
sudo -u tagent node /opt/tagent-core/current/scripts/release-manifest.mjs \
  verify /opt/tagent-core/releases/<40-character-commit>
sudo ln -s releases/<40-character-commit> /opt/tagent-core/.current.manual
sudo mv -Tf /opt/tagent-core/.current.manual /opt/tagent-core/current
sudo systemctl start tagent-core
curl -fsS http://127.0.0.1:3100/api/v1/health
```

Never use this procedure to cross a state-protocol boundary. Preserve `/opt/tagent-core/runtime/activation.json` for diagnosis; the Host reconciles an interrupted `starting` activation deterministically from that manifest and `current`.

## Gateway command and event boundary

Gateway persists its external intent before calling Core, uses stable Session/Submission/command/Goal identities, and queries the original receipt after ambiguous network failure. Core never accepts browser identity as authority and never receives channel SDK objects or platform secrets.

Gateway persists each SSE event under the exact consumer generation and event identity before ACK. `blocked` is settled but recoverable, not final. Slow consumers reconnect from durable ACK; Core bounds replay reads at 256 rows and replay/live buffering at 1,000 events. Operator Read provides authoritative inventory for rebuilding a disposable Gateway projection.

## Backup and rollback

Back up only while Core is stopped, copying SQLite with its WAL/SHM files as one recovery set and recording the release tag, commit, checksum, configuration, schema ID, and optional Memory state. Test restore with the identical release artifact.

A rollback build may reuse the migrated database only when its release manifest declares `tagent-core/state-0.8-r2` and it accepts `tagent-core/0.8` revision 2 plus the current ABI/profile tuple. The first r2 deployment requires a full Host/service restart; after migration the Host rejects old r1 release manifests. To return to r1, stop the service and restore the matching pre-upgrade backup. Never point an incompatible binary at the current database or overwrite live database files.

## Web deployment

Build-time configuration:

```env
VITE_TAGENT_CORE_ORIGIN=https://api.example.com
```

Serve the unpacked `dist` directory as immutable static content. Use HTTPS, cache hashed assets, disable caching for `index.html`, and review browser security headers. The Web Console has no built-in OIDC login/refresh interface; the hosting integration owns those flows.
