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

The v1 Channel, base Operator profile, independent Operator Read profile, and eight full-feature capability profiles are ready for Gateway integration. Core readiness cannot prove Gateway-local identity, persistence, routing, or external delivery; both repositories must pass their own release gates.

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

The Core archive includes `scripts/deploy-release.sh`. It rejects unsafe archive entries, verifies the manifest/runtime and both Host/Generation entrypoints, and stages the commit under `<release-root>/releases/<commit>`. It does not switch an existing `current`, restart systemd, or probe health. On the first installation only, it initializes `current` so the Host has a boot target.

```bash
sudo /path/to/deploy-release.sh \
  /path/to/tagent-core-v0.8.5-linux-x64-node24-abi137.tar.gz \
  /opt/tagent-core
```

For an already running installation, submit `core_generation_activate` with the staged 40-character commit. The tool is available only under a managed immutable Host and always consumes an explicit human external-action approval. Its exact parameters are stored in a writer-fenced operation receipt before the Host is notified. `targetRelease=current` performs a same-release Generation restart.

The Host drains Runtime and background work, prepares a durable TaskRun handoff, releases writer authority, starts the candidate, and changes `current` only after the candidate reports `READY` with the expected Host/state protocols and a positive writer fence. Candidate bootstrap failure restores the previous release and resumes the handoff there. A short API readiness gap is intentional; the Host does not proxy HTTP or allow overlapping SQLite writers.

One suitable systemd boundary is:

```ini
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

The service account must be able to atomically replace `/opt/tagent-core/current` and write `/opt/tagent-core/runtime/activation.json`. Only the deployment path should add verified directories under `/opt/tagent-core/releases`; their contents are made read-only. A Generation crash is normally handled inside the Host. systemd remains the recovery boundary if the Host itself exits or exhausts its durable crash budget.

Ordinary compatible releases replace only the Generation. A Host implementation or Host IPC protocol change still requires a conventional full systemd restart and a release whose manifest declares the matching protocol.

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

A rollback build may reuse a database only when its release manifest declares `tagent-core/state-0.8` and it accepts the exact `tagent-core/0.8` schema and current ABI/profile tuple. Otherwise keep the current release running or deploy the replacement with a new empty database. Never point an incompatible binary at the current database or overwrite live database files.

## Web deployment

Build-time configuration:

```env
VITE_TAGENT_CORE_ORIGIN=https://api.example.com
```

Serve the unpacked `dist` directory as immutable static content. Use HTTPS, cache hashed assets, disable caching for `index.html`, and review browser security headers. The Web Console has no built-in OIDC login/refresh interface; the hosting integration owns those flows.
