# Security Policy

## Supported versions

Security fixes are applied to the latest `0.1.x` release on `main`.

## Supported deployment boundary

TAgent Core `0.1.0` is stable for the documented trusted single-service profile, not for direct untrusted multi-tenant exposure.

- Run one TAgent Core process against one SQLite database and one trusted workspace.
- Bind to localhost or a private network, preferably behind an authenticated reverse proxy.
- Do not expose the Fastify/Web administrative surface directly to the public Internet. Optional scoped service Bearer credentials protect supported automation routes, but the interactive Web does not provide built-in login, CSRF protection, or complete multi-tenant authorization.
- Run under a dedicated low-privilege operating-system account.
- Do not place credentials, SSH keys, cloud configuration, or unrelated sensitive data in the tool workspace.
- Treat `bash` as privileged code execution inside the configured workspace. The command denylist is not an operating-system sandbox.
- Keep `.env`, provider credentials, SQLite/PostgreSQL data, Local Cold pages, logs, backups, and artifacts out of source control.
- Memory policy gates reduce accidental sensitive-data persistence; they are not a substitute for access control, encrypted storage, backup protection, and operator review.

## Reporting a vulnerability

Do not open a public issue containing exploit details or credentials. Use GitHub private vulnerability reporting for `imtms/tagent-core`. Include the affected version, deployment model, reproduction steps, impact, and suggested mitigation if available.

## Dependency policy

Release candidates must pass both:

```bash
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
```

Dependency updates are reviewed explicitly. Automated force upgrades are not part of the release process.
