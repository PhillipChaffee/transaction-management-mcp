# Contributing

Thanks for helping improve this unofficial Transaction Management MCP server.

## Before you start

- You need Node.js 20+.
- Do not commit secrets, raw OpenAPI/swagger, production data, or SkySlope logos.
- Runtime behavior changes need tests. Prefer MSW fakes; do not call live
  SkySlope APIs from CI or default tests.

## Setup

```bash
npm ci
npm run build
npm test
```

Optional generation (fetches the public swagger into a temp directory only):

```bash
npm run openapi:pin
npm run openapi:generate
```

`openapi:pin` / `openapi:generate` are explicit developer actions. Ordinary
`npm test` / `npm run build` stay offline to SkySlope.

## Checks to run before opening a PR

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run verify:manifest
npm run build
npm run package:check
npm run validate:server-json
```

On Node ≥ 22.19 you can also run `npm run inspector:smoke`.

## Documentation and metadata

- Keep README host configs accurate for Claude Desktop, Claude Code, Agent SDK,
  Cursor, and VS Code.
- Keep `package.json` `mcpName` identical to `server.json` `name`
  (`io.github.PhillipChaffee/transaction-management-mcp`).
- Bump `package.json` version and `server.json` versions together for releases.
- Update [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

## Security

Follow [SECURITY.md](SECURITY.md). Never paste credentials or production tenant
data into issues or PRs.

## License

By contributing, you agree your contributions are licensed under the MIT License
in this repository. Contributions do not grant anyone vendor API rights.
