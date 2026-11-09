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

## Method contract on `/mcp`

The MCP Streamable HTTP transport uses more than `POST`. All three methods share
the single `/mcp` path, and a client that cannot complete one of them is not
fully connected even though `initialize` succeeded:

| Method | Session id | Purpose |
|---|---|---|
| `POST` | none | `initialize`; the response carries the `Mcp-Session-Id` |
| `POST` | required | JSON-RPC requests on a live session (`tools/list`, `tools/call`, ...) |
| `GET` | none | plain liveness probe (`ok`), used by health checks |
| `GET` | required | opens the server-to-client SSE stream (`text/event-stream`) |
| `DELETE` | required | terminates the session and removes it from the map |

Because `GET /mcp` is overloaded, the session id is what distinguishes the probe
from the event stream. Routing the streamed `GET` to the plain-text probe makes
strict clients reject the response (`Unexpected content type: text/html`) and
drop the connection, and omitting `DELETE` leaves the client's teardown at 404.
Both were real Codex CLI failures; `test-mcp-session-lifecycle` covers them.

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

Accepted sessions live in a map keyed by `Mcp-Session-Id`. A clean client
(Codex CLI, Claude Code, the MCP SDK) sends `DELETE /mcp` on exit, which the
transport turns into `onclose` and an immediate removal from the map. A client
that dies without sending `DELETE` never fires `transport.onclose`, so the
sweep and the cap below exist as the backstop:

- idle sessions are swept after `OPEN_WEBSEARCH_MCP_SESSION_IDLE_TIMEOUT_MS`
  (default 300000);
- the map is capped at `OPEN_WEBSEARCH_MCP_MAX_SESSIONS` (default 64), evicting
  the least-recently-used entry;
- a request carrying an unknown session id gets **404** and must re-initialize,
  rather than being silently handed a fresh session.

## Reaching it from outside the host

Loopback binding is the control for the local surface, so a remote client
cannot connect to it directly. To serve clients on other machines, terminate
TLS at a reverse proxy and enforce a bearer token there - the daemon stays on
loopback and needs no change. See
[public-mcp-endpoint.md](public-mcp-endpoint.md) for that deployment, and
`nginx/open-websearch-mcp.conf.example` for a starting config.

## Not in v1

- Authentication on the local HTTP surface (beyond the existing
  `KEEPALIVE_TOKEN` on `/keepalive`). Loopback binding is the control, and a
  public deployment authenticates at the proxy instead of in the server.
- Unix sockets or named pipes for the MCP transport.
- Cross-host fan-out or load balancing across multiple instances.
