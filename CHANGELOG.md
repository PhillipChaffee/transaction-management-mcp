# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-02

### Added

- Initial public TypeScript MCP package `transaction-management-mcp`.
- Stdio binary (default) and opt-in single-tenant Streamable HTTP binary.
- Generated binders for the pinned Transaction Management REST surface
  (207 operations; 91 GET / 116 non-GET).
- Read-only-by-default startup with 19 toolsets, six capability gates, and
  default registration of 30 curated read tools.
- HMAC session client, rate limiting, high-risk intent-echo confirmation,
  optional elicitation, and MCP-side binary/bulk limits.
- Derived-only OpenAPI pipeline (`openapi:pin` / `openapi:generate`) with
  pinned `openapi.sha256` and no raw spec in the package.
- Offline MSW tests, packed-tarball contract, and Inspector smoke helper.
- Community docs (`README`, `SECURITY`, `CONTRIBUTING`), MCP Registry
  `server.json`, offline CI, weekly OpenAPI drift detection, and tag-gated
  release workflow (npm trusted publishing + `mcp-publisher`).
