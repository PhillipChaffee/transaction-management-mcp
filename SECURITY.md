# Security Policy

## Reporting a vulnerability

Report security issues privately through
[GitHub Security Advisories](https://github.com/PhillipChaffee/transaction-management-mcp/security/advisories/new)
for this repository. Do not open a public issue for vulnerabilities that could
expose credentials, tenant data, or remote HTTP misconfiguration.

Please include:

- Affected version / commit
- Reproduction steps without production credentials or production data
- Impact assessment

## Credential and storage boundaries

This package never ships SkySlope credentials. Operators supply:

- `SKYSLOPE_TM_CLIENT_ID`
- `SKYSLOPE_TM_CLIENT_SECRET`
- `SKYSLOPE_TM_ACCESS_KEY`
- `SKYSLOPE_TM_ACCESS_SECRET`

For self-hosted HTTP, operators also supply `SKYSLOPE_TM_HTTP_BEARER_TOKEN`.
That MCP bearer is **not** a SkySlope credential.

Do not log, commit, or paste secrets into issues, PRs, advisories, or chat.
Prefer host secret stores / env injection. Tool results can contain sensitive
transaction and contact data that enter the model host you configured.

## Secrets in public history

Any secret that appears in public git history, issues, CI logs, or packages
must be treated as **disclosed**.

1. **Rotate all four** SkySlope API credentials first (and any MCP bearer that
   was exposed).
2. Then purge history or delete/recreate the repository. A follow-up commit that
   only removes the secret from the tip is not enough.

## Reports must not include production data

Do not attach production transaction payloads, contact lists, documents,
credentials, or customer PII to vulnerability reports. Use synthetic fixtures.

## HTTP exposure

- Default bind is loopback (`127.0.0.1`).
- Non-loopback requires `SKYSLOPE_TM_HTTP_ALLOW_REMOTE=true`, a bearer ≥ 32
  bytes, exact `ALLOWED_HOSTS` / `ALLOWED_ORIGINS`, and TLS termination in
  front of the process.
- This binary does not terminate TLS and is not a multi-tenant hosted service.

## Bad release recovery (npm + MCP Registry)

Publication is tag-gated. Prefer a **prerelease** for the first tag.

If a bad version ships:

1. Cancel in-flight release workflows.
2. **npm succeeded, Registry failed:** retry Registry publication alone
   (`mcp-publisher login github-oidc` then `mcp-publisher publish`). Do not
   republish npm for the same version.
3. **npm package is bad:**
   - `npm deprecate` is available at any time.
   - `npm unpublish` only within npm's policy window; do not rely on it.
4. **MCP Registry entry is bad:** soft-hide with
   `mcp-publisher status --status deleted <server-name> <version>`
   or
   `mcp-publisher status --status deleted --all-versions <server-name>`
   (after `mcp-publisher login`). This does not unpublish npm.
5. There is no automatic unpublish in CI. Recovery is manual.
