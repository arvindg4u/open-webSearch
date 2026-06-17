# MCP Server Setup Guide

This guide explains how to connect the **open-webSearch MCP server** (deployed at `https://open-web-search-2oih.onrender.com/mcp`) to your AI coding tools.

---

## Table of Contents

- [For Codex CLI](#for-codex-cli)
- [For Claude Code](#for-claude-code)
- [Available Tools](#available-tools)
- [Configuration Reference](#configuration-reference)

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
| `MODE` | `both` | Server mode: `http`, `stdio`, or `both` |
| `ENABLE_CORS` | `false` | Enable CORS support |
| `CORS_ORIGIN` | `*` | CORS allowed origin |
| `DEFAULT_SEARCH_ENGINE` | `duckduckgo` | Default search engine |
| `USE_PROXY` | `false` | Enable HTTP proxy |
| `PROXY_URL` | `http://127.0.0.1:7890` | Proxy server URL |
| `KEEPALIVE_TOKEN` | - | Bearer token for keepalive endpoint |

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
