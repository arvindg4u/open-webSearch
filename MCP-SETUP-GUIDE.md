# MCP Server Setup Guide

This guide explains how to connect the **open-webSearch MCP server** (deployed at `https://open-web-search-2oih.onrender.com/mcp`) to your AI coding tools.

---

## Table of Contents

- [Run one shared instance (recommended)](#run-one-shared-instance-recommended)
- [For Codex CLI](#for-codex-cli)
- [For Claude Code](#for-claude-code)
- [For Cline](#for-cline)
- [For Kilo and OpenCode](#for-kilo-and-opencode)
- [Available Tools](#available-tools)
- [Configuration Reference](#configuration-reference)

---

## Run one shared instance (recommended)

Configured as a **stdio** MCP server, every CLI session spawns its own process
tree (`npm exec` -> `sh` -> `node`) and none of them are reaped when the session
ends. On a host running four CLIs we measured **71 live processes / ~1.85 GB**,
the oldest idle for 14 hours at 0% CPU.

Running **one** long-lived HTTP instance instead makes that O(1). All four CLIs
below can connect to the same URL.

### 1. Start the server

The MCP HTTP transport is `MODE=http`. This is **not** the same as
`open-websearch serve` - `serve` starts the local REST daemon used by scripts
and the CLI (default port 3210), which MCP clients cannot use.

```bash
cd ~/open-websearch
npm run build

# Foreground, for a quick test:
MODE=http HOST=127.0.0.1 PORT=3000 node build/index.js
```

Or run it as a service (a unit is provided in this repo):

```bash
mkdir -p ~/.config/systemd/user
cp systemd/open-websearch.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now open-websearch.service
loginctl enable-linger "$USER"     # keep it up without a login session
```

### 2. Confirm it is up

```bash
curl --noproxy '*' http://127.0.0.1:3000/mcp     # -> ok
```

The server logs its exact address at startup, e.g.
`🌐 HTTP MCP server: http://127.0.0.1:3000/mcp`.

### 3. Point every CLI at that URL

Replace `http://127.0.0.1:3000/mcp` if you moved `PORT`.

**Security note:** the HTTP MCP surface has **no authentication**, so it binds
loopback by default. Do not set `HOST=0.0.0.0` unless it sits behind a trusted
boundary - that would publish an open search endpoint.

---

## For Codex CLI

Codex CLI supports MCP servers via `~/.codex/config.toml`. The server uses **Streamable HTTP** transport.

### Option 1: Using the CLI

```bash
# Codex CLI does not support `codex mcp add` for HTTP servers directly.
# Edit the config file instead (Option 2).
```

### Option 2: Editing config.toml

Add the following to `~/.codex/config.toml`:

```toml
[mcp_servers.web-search]
url = "https://open-web-search-2oih.onrender.com/mcp"
```

For authenticated access (optional):

```toml
[mcp_servers.web-search]
url = "https://open-web-search-2oih.onrender.com/mcp"
bearer_token_env_var = "KEEPALIVE_TOKEN"
```

Then set the environment variable:

```bash
export KEEPALIVE_TOKEN="your-token-here"
```

### Verify it's working

```bash
codex mcp list
```

You should see:

```
Name        Url                                            Status
web-search  https://open-web-search-2oih.onrender.com/mcp  enabled
```

In the Codex TUI, type `/mcp` to see your active MCP servers.

### Advanced Configuration

```toml
[mcp_servers.web-search]
url = "https://open-web-search-2oih.onrender.com/mcp"
bearer_token_env_var = "KEEPALIVE_TOKEN"
enabled = true
tool_timeout_sec = 60
default_tools_approval_mode = "auto"

# Limit to specific tools
enabled_tools = ["search", "fetchWebContent"]

# Per-tool approval overrides
[tools."web-search".search]
approval_mode = "auto"
```

**Reference:** [Codex MCP Documentation](https://developers.openai.com/codex/mcp)

---

## For Claude Code

Claude Code supports MCP servers via `claude mcp add` or by editing configuration files. The server uses **Streamable HTTP** transport (aliased as `http` in Claude Code).

### Option 1: Using the CLI (Recommended)

**User scope** (available across all projects):

```bash
claude mcp add --transport http web-search https://open-web-search-2oih.onrender.com/mcp
```

**Project scope** (shared with team via `.mcp.json`):

```bash
claude mcp add --transport http web-search --scope project https://open-web-search-2oih.onrender.com/mcp
```

**With authentication header:**

```bash
claude mcp add --transport http web-search https://open-web-search-2oih.onrender.com/mcp \
  --header "Authorization: Bearer your-token"
```

### Option 2: Using JSON config

Add to your project's `.mcp.json` (shared with team):

```json
{
  "mcpServers": {
    "web-search": {
      "type": "http",
      "url": "https://open-web-search-2oih.onrender.com/mcp"
    }
  }
}
```

Or to `~/.claude.json` (user-global, stored per project path):

```json
{
  "projects": {
    "/path/to/your/project": {
      "mcpServers": {
        "web-search": {
          "type": "http",
          "url": "https://open-web-search-2oih.onrender.com/mcp"
        }
      }
    }
  }
}
```

> **Note:** The `type` field accepts `streamable-http` as an alias for `http`.

### Option 3: Using inline JSON

```bash
claude mcp add-json '{
  "type": "http",
  "url": "https://open-web-search-2oih.onrender.com/mcp"
}'
```

### Verify it's working

```bash
claude mcp list
```

Within Claude Code, use `/mcp` to see active servers.

### Scopes Explained

| Scope | Command | Stored In | Shared | Loads In |
|-------|---------|-----------|--------|----------|
| Local (default) | `claude mcp add` | `~/.claude.json` | No | Current project only |
| Project | `--scope project` | `.mcp.json` | Yes (via git) | Current project only |
| User | `--scope user` | `~/.claude.json` | No | All projects |

**Reference:** [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp)

---

## For Cline

Cline supports remote MCP servers over Streamable HTTP:

```bash
cline mcp install web-search --transport http http://127.0.0.1:3000/mcp
```

Or configure it directly in `~/.cline/data/settings/cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "web-search": {
      "transport": {
        "type": "streamableHttp",
        "url": "http://127.0.0.1:3000/mcp"
      }
    }
  }
}
```

**If you previously used the stdio form, remove it.** A stdio entry of the shape
`{"type": "stdio", "command": "npx", "args": ["-y", "open-websearch@latest"]}`
spawns a fresh process tree per Cline session and is the main source of the
process/ memory growth described above.

Verify with `cline mcp` (or the `/mcp` view in the Cline UI); the server should
show as connected.

---

## For Kilo and OpenCode

Both accept a remote MCP URL.

**Kilo** (`kilo mcp add` takes `--url` for a remote server):

```bash
kilo mcp add web-search --url http://127.0.0.1:3000/mcp
kilo mcp list
```

**OpenCode** uses the `mcp` key in its config (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "web-search": {
      "type": "remote",
      "url": "http://127.0.0.1:3000/mcp",
      "enabled": true
    }
  }
}
```

---

## Available Tools

Once connected, the server provides these tools:

| Tool | Description |
|------|-------------|
| `search` | Search the web using multiple engines (Bing, Baidu, DuckDuckGo, Exa, Brave, CSDN, Juejin, Startpage, Sogou) |
| `fetchWebContent` | Fetch content from a public HTTP(S) URL (supports Markdown and web pages) |
| `fetchGithubReadme` | Fetch README content from a GitHub repository URL |
| `fetchCsdnArticle` | Fetch full article content from a CSDN post URL |
| `fetchJuejinArticle` | Fetch full article content from a Juejin post URL |
| `fetchLinuxDoArticle` | Fetch full article content from a linux.do post URL |

### Search Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search query |
| `limit` | number | 10 | Number of results (1-50) |
| `engines` | string[] | ["duckduckgo"] | Search engines to use |
| `searchMode` | string | "auto" | Mode: "request", "auto", or "playwright" |

---

## Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MODE` | `stdio` | Server mode: `stdio`, `http`, or `both`. Unset means stdio-only - a stdio client never opens a listening socket. Set `MODE=http` to serve MCP clients over HTTP. |
| `HOST` | `127.0.0.1` | HTTP MCP bind address. Loopback by default; the surface has no auth. |
| `PORT` | `3000` | HTTP MCP port (`/mcp`). Distinct from the REST daemon's `OPEN_WEBSEARCH_DAEMON_PORT`. |
| `OPEN_WEBSEARCH_MCP_SESSION_IDLE_TIMEOUT_MS` | `300000` | Evict an idle HTTP MCP session after this long. |
| `OPEN_WEBSEARCH_MCP_MAX_SESSIONS` | `64` | Cap concurrent HTTP MCP sessions (evicts least-recently-used). |
| `ENABLE_CORS` | `false` | Enable CORS support |
| `CORS_ORIGIN` | `*` | CORS allowed origin |
| `DEFAULT_SEARCH_ENGINE` | `duckduckgo` | Default search engine |
| `USE_PROXY` | `false` | Enable HTTP proxy |
| `PROXY_URL` | `http://127.0.0.1:7890` | Proxy server URL |
| `KEEPALIVE_TOKEN` | - | Bearer token for keepalive endpoint |

See [docs/architecture/shared-mcp-instance.md](docs/architecture/shared-mcp-instance.md)
for why one shared HTTP instance is recommended over per-client stdio servers.

### MCP Client Config Comparison

| Setting | Codex CLI (`config.toml`) | Claude Code (`.mcp.json`) |
|---------|--------------------------|--------------------------|
| URL | `url = "..."` | `"url": "..."` |
| Transport | Implicit (Streamable HTTP) | `"type": "http"` |
| Auth token | `bearer_token_env_var = "VAR"` | `"Authorization": "Bearer ..."` header |
| Timeout | `tool_timeout_sec = 60` | Not configurable per-server |
| Tool filter | `enabled_tools = [...]` | Not supported natively |

---

*Server URL: `https://open-web-search-2oih.onrender.com/mcp`*
*Keepalive endpoint: `https://open-web-search-2oih.onrender.com/keepalive`*
