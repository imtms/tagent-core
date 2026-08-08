# Security policy

## Supported versions

Security fixes are applied to the latest supported `0.3.x` release and the current `main` line.

## Deployment boundary

TAgent Core is a trusted single-writer control plane, not an untrusted multi-tenant sandbox.

- Run one Core process against one SQLite database and one trusted tool workspace.
- Keep Core on localhost or a private upstream network. Do not expose port 3100 directly to the public Internet.
- Run Core under a dedicated low-privilege operating-system account.
- Do not place provider keys, SSH keys, cloud credentials, or unrelated secrets in the configured workspace.
- Treat `bash` as code execution. Workspace path checks and command policy are guardrails, not an operating-system sandbox.
- Protect `.env`, opaque service credentials, SQLite/WAL/SHM, PostgreSQL, Cold Memory, logs, backups, and artifacts.

## Core authentication modes

With no `TAGENT_SERVICE_CREDENTIALS`, protected v1 routes run as `local-admin`. This mode is intended only for local development; Core refuses to start unless `HOST` is `127.0.0.1`, `::1`, or `localhost`.

When one or more service credentials are configured, Core fails closed. Each opaque Bearer credential grants only explicit route scopes and may carry a server-configured subject and resource scopes. Never place a Core service credential in a browser bundle or browser storage.

## Browser, Gateway, and CORS

Core does not implement OIDC or validate JWTs. A production Gateway must:

1. authenticate the browser with Authorization Code and PKCE;
2. validate JWT signature, issuer, audience, expiry, not-before, and required scopes;
3. remove the browser `Authorization` value;
4. forward a dedicated, minimal-permission opaque Core credential;
5. keep Core inaccessible from the public network.

`TAGENT_CORS_ALLOWED_ORIGINS` accepts exact canonical HTTP(S) origins only. A non-empty allowlist requires at least one Core service credential. Core does not enable credentialed browser cookies.

The Web Console has no built-in OIDC login or refresh UI. Its hosting shell may provide a short-lived Gateway access token through session storage; logout and refresh remain hosting responsibilities. See [docs/WEB_CONSOLE_SECURITY.md](docs/WEB_CONSOLE_SECURITY.md).

## Governance and durable state

Writer fencing, synchronous Unit of Work, connection-level mutation guards, event-consumer generations, resource scopes, approval authority, trusted Bash/check bindings, and internal evaluation receipts are server-side boundaries. Callers cannot assert them through headers or payloads.

Memory and Learning policy reduce accidental persistence and unsafe promotion, but do not replace storage encryption, access control, backup protection, or human review. Active Learning actions remain approval-gated.

## Reporting a vulnerability

Do not open a public issue with exploit details, credentials, or private data. Use GitHub private vulnerability reporting for `imtms/tagent-core`. Include the affected version, deployment model, reproduction steps, impact, and suggested mitigation when available.

## Dependency policy

Release candidates must pass both audits against the official npm registry:

```bash
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
npm audit --audit-level=high --registry=https://registry.npmjs.org
```

Review dependency changes explicitly. Do not use an unreviewed forced audit fix for a stable release.
