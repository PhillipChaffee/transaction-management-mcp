# transaction-management-mcp

Independent, unofficial MCP server for Transaction Management REST workflows.
This project is not affiliated with, endorsed by, or sponsored by SkySlope or
any related trademark holder. Do not treat the package name, repository, or docs
as official vendor branding. No SkySlope logo or official marks are used here.

The source code is MIT-licensed. That license covers **this repository's code
only**. It does **not** grant API access, credentials, or any rights to vendor
APIs, documentation, OpenAPI specs, or data. You must have your own agreement
with the API provider and your own credentials.

## Prerequisites

- Node.js **20+**
- Your own SkySlope API agreement and credentials
- All four environment variables:

| Variable                    | Purpose                                        |
| --------------------------- | ---------------------------------------------- |
| `SKYSLOPE_TM_CLIENT_ID`     | API client id from SkySlope API onboarding     |
| `SKYSLOPE_TM_CLIENT_SECRET` | API client secret from SkySlope API onboarding |
| `SKYSLOPE_TM_ACCESS_KEY`    | Access key for HMAC login                      |
| `SKYSLOPE_TM_ACCESS_SECRET` | Access secret for HMAC login                   |

Normal SkySlope account keys alone are **not** enough. `CLIENT_ID` /
`CLIENT_SECRET` require SkySlope API onboarding (typically via your CSM). If you
only have ordinary user/account keys, authentication will fail.

## Install and run

```bash
npx -y transaction-management-mcp
```

Or install globally / as a dependency and run the `transaction-management-mcp`
bin (stdio) or `transaction-management-mcp-http` (opt-in HTTP).

## Local stdio host configuration

Use placeholders only. Put real secrets in your local environment or host secret
store — never commit them.

### Claude Desktop

Edit `claude_desktop_config.json`
([docs](https://modelcontextprotocol.io/docs/develop/connect-local-servers)):

macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`  
Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "transaction-management": {
      "command": "npx",
      "args": ["-y", "transaction-management-mcp"],
      "env": {
        "SKYSLOPE_TM_CLIENT_ID": "YOUR_CLIENT_ID",
        "SKYSLOPE_TM_CLIENT_SECRET": "YOUR_CLIENT_SECRET",
        "SKYSLOPE_TM_ACCESS_KEY": "YOUR_ACCESS_KEY",
        "SKYSLOPE_TM_ACCESS_SECRET": "YOUR_ACCESS_SECRET"
      }
    }
  }
}
```

Fully quit and restart Claude Desktop after saving.

### Claude Code

CLI ([docs](https://code.claude.com/docs/en/mcp)):

```bash
claude mcp add --transport stdio transaction-management \
  --env SKYSLOPE_TM_CLIENT_ID=YOUR_CLIENT_ID \
  --env SKYSLOPE_TM_CLIENT_SECRET=YOUR_CLIENT_SECRET \
  --env SKYSLOPE_TM_ACCESS_KEY=YOUR_ACCESS_KEY \
  --env SKYSLOPE_TM_ACCESS_SECRET=YOUR_ACCESS_SECRET \
  -- npx -y transaction-management-mcp
```

Project `.mcp.json` (prefer `${VAR}` expansion for secrets):

```json
{
  "mcpServers": {
    "transaction-management": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "transaction-management-mcp"],
      "env": {
        "SKYSLOPE_TM_CLIENT_ID": "${SKYSLOPE_TM_CLIENT_ID}",
        "SKYSLOPE_TM_CLIENT_SECRET": "${SKYSLOPE_TM_CLIENT_SECRET}",
        "SKYSLOPE_TM_ACCESS_KEY": "${SKYSLOPE_TM_ACCESS_KEY}",
        "SKYSLOPE_TM_ACCESS_SECRET": "${SKYSLOPE_TM_ACCESS_SECRET}"
      }
    }
  }
}
```

### Agent SDK

TypeScript ([docs](https://docs.claude.com/en/docs/agent-sdk/mcp)):

```ts
const options = {
  mcpServers: {
    "transaction-management": {
      command: "npx",
      args: ["-y", "transaction-management-mcp"],
      env: {
        SKYSLOPE_TM_CLIENT_ID: process.env.SKYSLOPE_TM_CLIENT_ID!,
        SKYSLOPE_TM_CLIENT_SECRET: process.env.SKYSLOPE_TM_CLIENT_SECRET!,
        SKYSLOPE_TM_ACCESS_KEY: process.env.SKYSLOPE_TM_ACCESS_KEY!,
        SKYSLOPE_TM_ACCESS_SECRET: process.env.SKYSLOPE_TM_ACCESS_SECRET!,
      },
    },
  },
};
```

### Cursor

Project `.cursor/mcp.json` or global `~/.cursor/mcp.json`
([docs](https://cursor.com/docs/mcp)):

```json
{
  "mcpServers": {
    "transaction-management": {
      "command": "npx",
      "args": ["-y", "transaction-management-mcp"],
      "env": {
        "SKYSLOPE_TM_CLIENT_ID": "YOUR_CLIENT_ID",
        "SKYSLOPE_TM_CLIENT_SECRET": "YOUR_CLIENT_SECRET",
        "SKYSLOPE_TM_ACCESS_KEY": "YOUR_ACCESS_KEY",
        "SKYSLOPE_TM_ACCESS_SECRET": "YOUR_ACCESS_SECRET"
      }
    }
  }
}
```

Cursor also supports `${env:NAME}` interpolation and `envFile` for stdio servers.

### VS Code

Workspace `.vscode/mcp.json` or user MCP config
([docs](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)):

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "skyslope-tm-client-id",
      "description": "SkySlope Transaction Management client id",
      "password": true
    },
    {
      "type": "promptString",
      "id": "skyslope-tm-client-secret",
      "description": "SkySlope Transaction Management client secret",
      "password": true
    },
    {
      "type": "promptString",
      "id": "skyslope-tm-access-key",
      "description": "SkySlope Transaction Management access key",
      "password": true
    },
    {
      "type": "promptString",
      "id": "skyslope-tm-access-secret",
      "description": "SkySlope Transaction Management access secret",
      "password": true
    }
  ],
  "servers": {
    "transaction-management": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "transaction-management-mcp"],
      "env": {
        "SKYSLOPE_TM_CLIENT_ID": "${input:skyslope-tm-client-id}",
        "SKYSLOPE_TM_CLIENT_SECRET": "${input:skyslope-tm-client-secret}",
        "SKYSLOPE_TM_ACCESS_KEY": "${input:skyslope-tm-access-key}",
        "SKYSLOPE_TM_ACCESS_SECRET": "${input:skyslope-tm-access-secret}"
      }
    }
  }
}
```

VS Code uses a top-level `servers` key (not `mcpServers`). Prefer `${input:...}`
or `envFile` so secrets are not committed.

## Tool surface

Pinned Transaction Management REST census: **207** operations (**91** GET /
**116** non-GET).

| Mode                                                                                 |            Tools registered |
| ------------------------------------------------------------------------------------ | --------------------------: |
| Default (nine default toolsets, read-only, no capabilities)                          |                      **30** |
| Default toolsets before capability filtering                                         | **31** pre-capability reads |
| `SKYSLOPE_TM_TOOLSETS=all` + `SKYSLOPE_TM_ALLOW=all` (still read-only)               |                      **91** |
| `SKYSLOPE_TM_TOOLSETS=all` + `SKYSLOPE_TM_READ_WRITE=true` + `SKYSLOPE_TM_ALLOW=all` |                     **207** |

### Toolsets (19)

`reference`, `users`, `sales`, `listings`, `contacts`, `listing_contacts`,
`checklists`, `stages`, `offices`, `sale_contacts`, `sale_documents`,
`listing_documents`, `sale_commissions`, `listing_commissions`, `sale_parties`,
`listing_parties`, `v2_sales`, `v2_listings`, `bulk_export`

Default toolsets (when unset): `reference`, `users`, `sales`, `listings`,
`contacts`, `listing_contacts`, `checklists`, `stages`, `offices`.

Special values: `default`, `all`. Do not mix `default`/`all` with other ids.

### Capabilities (6)

`destructive`, `financial`, `admin`, `binary-io`, `bulk-export`, `impersonation`

Grant with `SKYSLOPE_TM_ALLOW` / `--allow` (comma list or `all`). Tools that
require a capability are omitted unless every required capability is granted.
Default mode drops `Sales_GetSales` because it requires both `binary-io` and
`impersonation` (31 → 30).

### Selection, precedence, exclusions, limits

| Concern          | Env                            | CLI                  |
| ---------------- | ------------------------------ | -------------------- |
| Toolsets         | `SKYSLOPE_TM_TOOLSETS`         | `--toolsets`         |
| Explicit tools   | `SKYSLOPE_TM_TOOLS`            | `--tools`            |
| Exclude toolsets | `SKYSLOPE_TM_EXCLUDE_TOOLSETS` | `--exclude-toolsets` |
| Exclude tools    | `SKYSLOPE_TM_EXCLUDE_TOOLS`    | `--exclude-tools`    |
| Read/write       | `SKYSLOPE_TM_READ_WRITE`       | `--read-write`       |
| Capabilities     | `SKYSLOPE_TM_ALLOW`            | `--allow`            |

List selection (`toolsets` / `tools` / excludes): **env wins** when set; otherwise
CLI. `READ_WRITE` and `ALLOW`: if both env and CLI are set, the effective value
is the **intersection** (both must enable / grant). Otherwise the single present
source is used. Default `READ_WRITE` is false (read-only).

Optional MCP-side limits (positive integers; not vendor API limits):

| Env                            | Default               |
| ------------------------------ | --------------------- |
| `SKYSLOPE_TM_MAX_OUTPUT_BYTES` | 1 MiB structured JSON |
| `SKYSLOPE_TM_MAX_BINARY_BYTES` | 10 MiB decoded binary |
| `SKYSLOPE_TM_MAX_UPLOAD_BYTES` | 25 MiB decoded upload |
| `SKYSLOPE_TM_MAX_BULK_ITEMS`   | 100 bulk-export items |

## Safety model

- **Read-only by default.** Writes require explicit `SKYSLOPE_TM_READ_WRITE=true`
  (and matching CLI if both are set).
- **No automatic write retries.** Auth refresh retry applies to GET only.
- **High-risk confirmation.** Destructive / financial / admin / binary-io /
  bulk-export / impersonation tools require an exact **intent echo**: a
  `confirmation` object with `confirm: true` and `resources` (path ids; bulk
  export also echoes filters; impersonation echoes `userBeingImpersonated`).
- **Elicitation** is optional UX when the host supports it. Decline, cancel,
  error, timeout, or mismatch fails closed and never falls back from failed
  elicitation to model confirmation. Hosts without elicitation rely on
  intent-echo alone — a compromised or careless model can still echo values.
- **Binary and bulk limits** bound materialization into the host context.
- **Sensitive data enters your model host.** Tool inputs/outputs (transactions,
  contacts, commissions, documents metadata, etc.) are visible to the MCP host
  and model provider you chose. Treat that as a data-handling decision.

Desktop, Cursor, VS Code, and many generic clients may send every selected tool
schema to the model. Prefer the 30-tool default there. Anthropic's Messages API
MCP connector can use deferred tool loading for large catalogs (below).

## Self-hosted HTTP (optional)

There is **no hosted service**. HTTP is single-tenant and opt-in.

```bash
export SKYSLOPE_TM_TRANSPORT=http
export SKYSLOPE_TM_HTTP_BEARER_TOKEN="YOUR_MCP_BEARER_TOKEN"
# plus the four SKYSLOPE_TM_* credentials
npx -y transaction-management-mcp-http
```

| Env                                | Role                                                                |
| ---------------------------------- | ------------------------------------------------------------------- |
| `SKYSLOPE_TM_TRANSPORT`            | Must be `http` for the HTTP bin (`stdio` default for the stdio bin) |
| `SKYSLOPE_TM_HTTP_HOST`            | Bind host (default `127.0.0.1`)                                     |
| `SKYSLOPE_TM_HTTP_PORT`            | Port (default `3000`)                                               |
| `SKYSLOPE_TM_HTTP_BEARER_TOKEN`    | **Required** MCP bearer (distinct from SkySlope credentials)        |
| `SKYSLOPE_TM_HTTP_ALLOW_REMOTE`    | Must be `true` for non-loopback bind                                |
| `SKYSLOPE_TM_HTTP_ALLOWED_HOSTS`   | Exact Host allowlist (required when remote)                         |
| `SKYSLOPE_TM_HTTP_ALLOWED_ORIGINS` | Exact Origin allowlist (required when remote)                       |

Loopback binds are the default. Non-loopback requires `ALLOW_REMOTE=true`, a
bearer of at least 32 bytes, non-empty exact host and origin allowlists, and
**TLS terminated in front of this process** (the binary serves plain HTTP only).
The MCP bearer authenticates the MCP client; SkySlope credentials authenticate
the upstream API. Keep them separate.

See [SECURITY.md](SECURITY.md) for exposure guidance.

## Anthropic Messages API (remote connector)

Stdio is **not** supported by the Messages API MCP connector. Expose your
self-hosted HTTPS endpoint (TLS proxy → this HTTP binary), then:

```typescript
const response = await anthropic.beta.messages.create({
  model: "YOUR_CLAUDE_MODEL",
  max_tokens: 1000,
  messages: [{ role: "user", content: "List my open sales." }],
  mcp_servers: [
    {
      type: "url",
      url: "https://mcp.example.com/mcp",
      name: "transaction-management",
      authorization_token: "YOUR_MCP_BEARER_TOKEN",
    },
  ],
  tools: [
    {
      type: "tool_search_tool_regex_20251119",
      name: "tool_search_tool_regex",
    },
    {
      type: "mcp_toolset",
      mcp_server_name: "transaction-management",
      default_config: { defer_loading: true },
    },
  ],
  betas: ["mcp-client-2025-11-20"],
});
```

See [MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)
and [Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).

## Development and OpenAPI generation

Raw OpenAPI / swagger is **never committed or shipped**. Only `openapi.sha256`
and derived artifacts under `src/generated/` (copied into `dist/` at build) are
kept.

```bash
npm run openapi:pin       # fetch public swagger to temp, verify census, write hash
npm run openapi:generate  # fetch, require matching pin, regenerate derived files
npm run build
npm test                  # offline to SkySlope (MSW fakes)
npm run openapi:drift     # compare pin to live public swagger (local/CI drift job)
```

Weekly GitHub Actions drift detection opens/updates an issue when the public
hash changes. It never commits, never pushes, and never uploads the raw spec.

## Known limits

- No live SkySlope sandbox validation in CI yet (offline fakes only)
- GraphQL and Forms APIs are out of scope
- Upstream OpenAPI is marked BETA and can change
- Generated surface is the 207 REST operations from the pinned digest

## Security and release

- Vulnerability reporting and credential handling: [SECURITY.md](SECURITY.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Changes: [CHANGELOG.md](CHANGELOG.md)
- MCP Registry metadata: [`server.json`](server.json) (`mcpName` /
  `server.json.name` =
  `io.github.PhillipChaffee/transaction-management-mcp`)
- npm package name remains vendor-neutral: `transaction-management-mcp`
- Releases are **tag-gated** after merge (see `.github/workflows/release.yml`).
  Do not publish from a PR. Prefer a prerelease tag for the first publish.
