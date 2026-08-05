# Web Console security

## Separate deployment

The Web Console is the static `@tagent/web-console` application. Core is an API-only service. Core never serves Web files or falls back to `index.html`, and its artifact excludes `@tagent/web-console`.

Example origins:

```text
Web Console: https://console.example.com
Gateway API: https://api.example.com
Private Core: http://127.0.0.1:3100
```

Set the Web build-time origin to the public Gateway/API origin:

```env
VITE_TAGENT_CORE_ORIGIN=https://api.example.com
```

The value must be a canonical HTTP(S) origin without credentials, path, query, or fragment.

## OIDC hosting boundary

The Web Console does not implement OIDC login, callback, token refresh, or provider logout. A trusted hosting shell or integration must implement Authorization Code with PKCE.

The current client may read a short-lived Gateway access token from session storage key `tagent.oidc.access_token` and sends it as `Authorization: Bearer <token>` with Fetch `credentials: "omit"`. Do not store refresh tokens in Web storage or put tokens in URLs.

The Gateway must validate signature, issuer, audience, expiration, not-before, and scopes. It must strip the browser token and replace it with a dedicated opaque Core credential. Never expose the Core credential to the browser.

## CORS

When the browser reaches Core/Gateway across origins, configure Core with exact origins only when traffic reaches Core directly from that origin:

```env
TAGENT_CORS_ALLOWED_ORIGINS=https://console.example.com
TAGENT_SERVICE_CREDENTIALS=[{"token":"REPLACE_WITH_24_PLUS_CHAR_TOKEN","scopes":["sessions:read","sessions:write","runs:read","runs:control","events:consume"]}]
```

Core rejects wildcards, `null`, credentials, paths, query strings, fragments, and non-canonical origins. Invalid configuration fails startup. A non-empty allowlist requires at least one service credential.

Allowed responses echo the exact origin and set `Vary: Origin`. Preflight permits `Authorization`, `Content-Type`, `Idempotency-Key`, and `X-Request-Id`. Core does not send `Access-Control-Allow-Credentials`.

## Content and browser controls

Host the Web artifact with HTTPS and set restrictive response headers appropriate to the deployment, including Content Security Policy, `X-Content-Type-Options: nosniff`, frame restrictions, and a referrer policy. Review CSP requirements against the built artifact before enforcing them.

Treat Markdown, transcripts, tool output, artifact names, and model content as untrusted. The Web Console must not turn rendered content into script, HTML authority, or browser credentials.

## Artifact status

`scripts/build-release.sh` creates separate Core and Web Console archives with manifests and checksums. The tag-triggered release workflow builds both in one release job, uploads both archives and checksums as a 30-day Actions artifact, and attaches all four files to the GitHub Release.

See [DEPLOYMENT_AND_GATEWAY.md](DEPLOYMENT_AND_GATEWAY.md).
