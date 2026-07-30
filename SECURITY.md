# Security Policy

## Supported versions

`0.1.0-alpha.1` is an alpha source preview. Security fixes are applied to the latest prerelease only.

## Deployment boundary

- Run one TAgent Core process against one SQLite database and one trusted workspace.
- Bind to localhost or place the service behind an authenticated private-network reverse proxy.
- Do not expose the Fastify API directly to the public Internet. This alpha has no built-in authentication, authorization, CSRF protection, or multi-tenant isolation.
- Run under a dedicated low-privilege operating-system account. Do not use a workspace containing credentials, SSH keys, cloud configuration, or unrelated sensitive files.
- Treat `bash` as privileged code execution inside the configured workspace. The command denylist is not a sandbox.
- Keep `.env`, provider keys, the SQLite database, logs, and artifacts out of source control.

## Reporting a vulnerability

Do not open a public issue containing exploit details or credentials. Use GitHub private vulnerability reporting for `imtms/tagent-core`. Include the affected version, deployment model, reproduction steps, impact, and any suggested mitigation.

## Dependency policy

Release candidates must pass both `npm audit --omit=dev --audit-level=high` and `npm audit --audit-level=high`. Dependency updates are reviewed explicitly; automated force upgrades are not part of the release process.
