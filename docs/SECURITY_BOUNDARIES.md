# Security boundaries

## Trust model

TAgent Core 0.2.0 supports one trusted Core process, one trusted tool workspace, and one SQLite writer. It is not a public multi-tenant sandbox. Run it under a dedicated OS identity and keep it behind a private network boundary.

## Authentication modes

If `TAGENT_SERVICE_CREDENTIALS` is empty, protected v1 routes use a `local-admin` principal. This mode is for localhost development only. Core rejects non-loopback `HOST` values; leave `TAGENT_CORS_ALLOWED_ORIGINS` empty.

If credentials are configured, Core fails closed. Requests must present an opaque Bearer token whose configured scopes include the route capability. Available scopes are:

```text
sessions:read       sessions:write
runs:read           runs:control
events:consume      workflows:teach
workflows:govern    workflows:approve
admin               internal
```

A credential may bind a subject and `user`, `workspace`, `project`, or `session` resource scopes. Core takes these values only from server configuration; identity-bearing client headers are not trusted.

## Gateway boundary

Core does not validate OIDC/JWT tokens. The public Gateway owns browser authentication and must replace the browser token with a minimal Core service credential. Core must remain inaccessible from the public network.

Exact-origin CORS is a browser transport boundary, not authentication. A non-empty CORS allowlist requires Core credentials. Core does not use credentialed cookies.

## Workspace and process boundary

`@tagent/workspace-local` normalizes and contains filesystem paths, and command policy rejects known unsafe operations. These checks do not isolate the process from the host. A permitted `bash` command runs with the Core OS account's privileges.

Use a dedicated workspace without SSH keys, provider credentials, cloud config, production secrets, or unrelated files. Apply OS/container controls for filesystem, network, process, and resource isolation when stronger containment is required.

## Durable authority

The following are server-owned and cannot be asserted by a caller:

- OS instance lock, writer lease, fence, and connection mutation guard;
- canonical TaskRun/Attempt transition authority;
- approval and capability authorization receipts;
- event-consumer generation and acknowledged sequence;
- internal evaluation receipt verification;
- Learning projection authority and migration issue state.

State-changing handlers persist through guarded repositories and a synchronous Unit of Work. Losing writer authority clears readiness and shuts Core down.

## Secrets and data

Provider credentials are read from runtime configuration and must not enter source control, browser bundles, transcripts, or Pi auth files. Protect SQLite/WAL/SHM, PostgreSQL, Cold Memory, logs, artifacts, release manifests, and backups according to their data sensitivity.

Memory capture and Learning policy reduce accidental persistence and promotion; they do not replace encryption, authorization, data retention review, or human approval.

See [WEB_CONSOLE_SECURITY.md](WEB_CONSOLE_SECURITY.md), [PERSISTENCE_AND_RECOVERY.md](PERSISTENCE_AND_RECOVERY.md), and the root [security policy](../SECURITY.md).
