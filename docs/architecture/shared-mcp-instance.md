# Shared MCP Instance

This document defines why one long-lived HTTP MCP server is the recommended way
to serve multiple agentic CLIs, and how the listener behaves.

## Decision

One shared instance, reached over the MCP HTTP transport (`MODE=http`). Stdio
remains supported but is not the default.

## Why

Configured as a stdio MCP server, each client spawns its own process tree
(`npm exec` -> `sh` -> `node`). Those trees are owned by the client, and clients
do not reliably reap them at session end. Measured on a host running four CLIs:
**71 live processes / ~1.85 GB** of resident memory, with 21 owned by a single
editor daemon and aged 12-14 hours at 0% CPU. That is O(sessions) processes for
one search capability.

A shared instance is O(1): one runtime, one browser lifecycle, many clients.
Both adapters already sit on the same shared runtime (`src/index.ts` creates it
once and passes it to every `createServer` call):

```text
                 +--------------------+
                 |  Shared Runtime    |
                 | config/state/cache |
                 | browser lifecycle  |
                 +----+----------+----+
                      |          |
             +--------v--+   +---v----------------+
             | MCP       |   | Local HTTP         |
             | stdio/http|   | REST daemon        |
             +-----------+   +--------------------+
```

## Two HTTP surfaces are not interchangeable

This is the most common setup mistake:

| Surface | Endpoint | Started by | Port env |
|---|---|---|---|
| MCP HTTP | `/mcp` (JSON-RPC) | `MODE=http` or `MODE=both` | `PORT` |
| Local REST daemon | `/health`, `/status`, `/search`, `/fetch-*` | `open-websearch serve` | `OPEN_WEBSEARCH_DAEMON_PORT` |

MCP clients need the **first**. `serve` starts the second, which exists for
scripts and one-shot CLI calls. A service started with `serve` looks healthy on
3210 while every CLI's `/mcp` connection fails.

## Binding model

- Default host is `127.0.0.1` (`HOST`). The HTTP MCP surface has **no
  authentication**, so the loopback default is the control; a non-loopback
  `HOST` is warned about at startup.
- `PORT` defaults to `3000`, distinct from the REST daemon's `3210`.
- The listener address is always logged at startup, so a socket never appears
  without a corresponding log line.

## Default MODE

An unset `MODE` means **stdio only**. A stdio client connecting must never cause
a listening socket to appear as a side effect, which is what the previous
`enableHttpServer: MODE ? ... : true` default did (binding `0.0.0.0:3000` on
every bare invocation). Opt in explicitly with `MODE=http` or `MODE=both`.

## Failure behaviour

- A port conflict is reported as a diagnostic naming the address and the env var
  to change, not an unhandled `EADDRINUSE`.
- It is fatal (exit 1) only in pure `MODE=http`, which has no other transport.
  When a stdio transport is live (`MODE` unset, `stdio`, or `both`) the HTTP
  failure is logged and the stdio client keeps working.

## Session lifecycle

Accepted sessions live in a map keyed by `Mcp-Session-Id`. A client that
disconnects without sending `DELETE` never fires `transport.onclose`, so:

- idle sessions are swept after `OPEN_WEBSEARCH_MCP_SESSION_IDLE_TIMEOUT_MS`
  (default 300000);
- the map is capped at `OPEN_WEBSEARCH_MCP_MAX_SESSIONS` (default 64), evicting
  the least-recently-used entry;
- a request carrying an unknown session id gets **404** and must re-initialize,
  rather than being silently handed a fresh session.

## Not in v1

- Authentication on the local HTTP surface (beyond the existing
  `KEEPALIVE_TOKEN` on `/keepalive`). Loopback binding is the control.
- Unix sockets or named pipes for the MCP transport.
- Cross-host fan-out or load balancing across multiple instances.
