# Public MCP Endpoint

The shared MCP instance (see [shared-mcp-instance.md](shared-mcp-instance.md))
binds `127.0.0.1:3000` because its `/mcp` surface has **no authentication** —
loopback is the entire access control. This document covers the deployment that
puts it on the public internet behind nginx, and the security that makes that
safe to do.

## Endpoint

```text
https://search.rvndha.duckdns.org/mcp
```

| Layer | Value |
|---|---|
| Upstream | `http://127.0.0.1:3000` (`open-websearch.service`, `MODE=http`) |
| TLS | certbot cert `aghwild` = `*.rvndha.duckdns.org` |
| Auth | `Authorization: Bearer <token>`, enforced by nginx |

The daemon itself is unchanged and still binds loopback. Everything public goes
through nginx.

## Why a hostname, not a port

`*.rvndha.duckdns.org` already resolves as a wildcard (with both A and AAAA
records) and certbot already holds a `*.rvndha.duckdns.org` certificate, while
OCI ingress already opens 80 and 443. Routing by hostname on 443 therefore
needs **no** DNS change, **no** certificate issuance, and **no** OCI security
list change — it matches how the other vhosts on this box are exposed.

## Authentication is the whole design

`/mcp` exposes `search` **and** `fetchWebContent`, which fetches arbitrary
HTTP(S) URLs. Unauthenticated, that is an open search proxy and an SSRF surface
for anyone who learns the URL. The token gate is not a nicety; it is what makes
the exposure acceptable.

The check is a `map` on the raw header, evaluated in the rewrite phase before
`limit_req`/`limit_conn`:

```nginx
map $http_authorization $mcp_bearer_ok {
    default 0;
    "Bearer <token>" 1;
}

location = /mcp {
    if ($mcp_bearer_ok = 0) { return 401; }
    ...
}
```

Two consequences worth knowing:

- **It covers every method.** Streamable HTTP uses `POST` to initialize and call
  tools, `GET` to open the server-to-client event stream, and `DELETE` to
  terminate a session. Gating the location rather than one method means no verb
  slips through.
- **It is not per-location auth.** A `401` and a valid-token `200` never reach
  the daemon, so an unauthenticated caller cannot consume rate budget.

## Method contract through the proxy

The proxy must not break the transport. `proxy_http_version 1.1` with
`Connection ""` keeps keepalive, and `proxy_buffering off` is required because
`GET /mcp` holds an SSE stream open — buffering it would stall the client.
`proxy_read_timeout 3600s` keeps an idle session from being reaped by the proxy
while the daemon's own session idle timeout (default 5 min) governs eviction.

## Path allowlist

Only `location = /mcp` proxies. Everything else returns `404`, so the REST
daemon's routes (`/search`, `/fetch-*`) and `/keepalive` are not reachable
through this vhost even if they are listening.

## Connecting clients

**Claude Code**

```bash
claude mcp add --transport http web-search https://search.rvndha.duckdns.org/mcp \
  --header "Authorization: Bearer <token>"
```

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.web-search]
url = "https://search.rvndha.duckdns.org/mcp"
bearer_token_env_var = "OPEN_WEBSEARCH_TOKEN"
```

**Cline / Kilo / OpenCode** take the same URL; each needs the `Authorization`
header set in its remote-server block.

**On this host**, CLIs keep using `http://127.0.0.1:3000/mcp` with no token —
loopback is trusted and the token is only for remote callers.

## Operating the deployment

The files live in `/etc/nginx`, not in this repo (they carry the token).

```bash
sudo nginx -t && sudo systemctl reload nginx   # after any change
sudo certbot certificates                      # wildcard expiry
systemctl --user status open-websearch         # upstream health
curl -s https://search.rvndha.duckdns.org/mcp                                   # -> 401
curl -s -H "Authorization: Bearer $OPEN_WEBSEARCH_TOKEN" https://search.rvndha.duckdns.org/mcp  # -> ok
```

`map_hash_bucket_size 128` is set in `/etc/nginx/conf.d/00-map-hash-bucket.conf`.
The default (64) is too small for a `"Bearer <48 hex>"` map key; without it
nginx fails to start with `could not build map_hash`.

## Rotating the token

1. Edit the `map` in `/etc/nginx/sites-available/open-websearch-mcp`.
2. `sudo nginx -t && sudo systemctl reload nginx` — reload, not restart, so
   in-flight sessions drain.
3. Update the header/env var on every remote client. There is no grace period:
   the old token stops working at reload.
