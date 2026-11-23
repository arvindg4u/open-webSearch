# Search & Fetch Upgrade

This document describes the free, keyless upgrades added to the Node MCP server,
why they were chosen, and how to configure them. An edge deployment of the same
capabilities on Cloudflare Workers lives in [`cloudflare/`](../cloudflare/README.md).

## What changed

| Area | Before | After |
| --- | --- | --- |
| Multi-engine search | Results flattened in engine order | **Reciprocal Rank Fusion** across engines, de-duplicated by normalised URL |
| Engines | Per-engine scrapers (fragile) | Added **SearXNG** (self-hosted metasearch) and **Wikipedia** (MediaWiki API) |
| Web fetch output | Plain text | **Markdown** (headings, links, lists, tables, code) |
| Long pages | Truncated mid-content | **Chunked** reads via `startIndex` + `nextStartIndex` |
| Hard pages | None | Optional **Jina Reader** fallback (JS-rendered / PDF / anti-bot) |
| Diagnostics | `partialFailures` only | `engineStats` with per-engine timing + result counts |
| Repeated searches | Always hit the network | Optional TTL cache (`SEARCH_CACHE_TTL_MS`) |

## Search

### Reciprocal Rank Fusion (RRF)

When more than one engine is requested, each engine's ranked list is fused with
RRF (`score = Σ 1 / (60 + rank)`) and de-duplicated by a normalised URL (host
lower-cased, fragment and tracking params dropped, params sorted, trailing slash
removed). A single-engine query keeps that engine's native order, so behaviour
is unchanged for the default DuckDuckGo path.

A URL surfaced by more than one engine carries an `engines` array in the output.

### New engines

- **`searxng`** — queries a self-hosted [SearXNG](https://docs.searxng.org/dev/search_api.html)
  instance's JSON API (`/search?format=json`). SearXNG aggregates many upstream
  engines behind one stable endpoint, which removes the per-engine scraper
  fragility. JSON output must be enabled in the instance's `settings.yml`
  (`search.formats: [html, json]`).
- **`wikipedia`** — the public MediaWiki search API
  ([API:Search](https://www.mediawiki.org/wiki/API:Search)). Keyless and stable.

Brave (HTML) and the existing engines remain available.

### Example

```jsonc
// search across three engines, fused
{ "query": "reciprocal rank fusion", "engines": ["duckduckgo", "wikipedia", "searxng"], "limit": 10 }
```

## Web fetch

`fetchWebContent` now returns Markdown by default and supports chunked reads:

```jsonc
{ "url": "https://en.wikipedia.org/wiki/Cloudflare", "maxChars": 12000 }
// → { content, truncated: true, nextStartIndex: 12000, totalChars: 451850, ... }

{ "url": "https://en.wikipedia.org/wiki/Cloudflare", "maxChars": 12000, "startIndex": 12000 }
// → the next chunk
```

Other options:

- `format: "text" | "markdown"` — default `markdown` in the MCP tool; the
  low-level `fetchWebContent()` function defaults to `text` for backward
  compatibility.
- `readability: true` — use Mozilla Readability for article extraction.
- `jinaFallback: true` — when the page cannot be rendered locally, use
  [Jina Reader](https://jina.ai/reader/) (`https://r.jina.ai/<url>`), which
  handles JS-rendered pages and PDFs. Free at ~20 req/min without a key.

Links and images are resolved to absolute URLs during conversion.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `SEARXNG_URL` | _(unset)_ | Base URL of a SearXNG instance; enables the `searxng` engine |
| `SEARXNG_CATEGORIES` | _(unset)_ | Comma-separated SearXNG categories |
| `SEARXNG_LANGUAGE` | _(unset)_ | SearXNG result language |
| `SEARXNG_TIME_RANGE` | _(unset)_ | `day` / `month` / `year` |
| `WIKIPEDIA_LANG` | `en` | Wikipedia language subdomain |
| `SEARCH_CACHE_TTL_MS` | `0` | In-process search cache TTL; `0` disables |
| `JINA_READER_ENABLED` | `false` | Enable the Jina Reader fallback |
| `JINA_API_KEY` | _(unset)_ | Optional Jina key (raises the rate limit) |
| `JINA_READER_BASE_URL` | `https://r.jina.ai` | Reader base URL override |

`DEFAULT_SEARCH_ENGINE` and `ALLOWED_SEARCH_ENGINES` accept the new engine names
(`duckduckgo`, `searxng`, `wikipedia`, ...).

## Why these choices

- **SearXNG** solves the root problem ("only DuckDuckGo works"): instead of
  maintaining one scraper per engine, one metasearch instance abstracts them.
  See the [SearXNG search API](https://docs.searxng.org/dev/search_api.html).
- **Markdown + chunking** follows the reference
  [`mcp-server-fetch`](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch),
  which converts HTML to Markdown and pages long content with `start_index`
  rather than truncating mid-sentence.
- **RRF** is the standard score-agnostic merge for ranked lists
  ([Pinecone](https://docs.pinecone.io/guides/search/reciprocal-rank-fusion),
  [ParadeDB](https://paradedb.com/learn/search-concepts/reciprocal-rank-fusion)).
- **Jina Reader** is free, handles PDFs and JS-rendered pages, and is strictly a
  fallback ([docs](https://jina.ai/reader/)).

## Edge deployment

The same capabilities, plus intent-routed free verticals (GitHub, Stack Exchange,
Hacker News, arXiv), a reranker with per-domain diversity, one-call
`searchAndFetch` evidence retrieval, native PDF extraction, and `llms.txt`
discovery, run on Cloudflare Workers. See
[`cloudflare/README.md`](../cloudflare/README.md).

## Tests

- `npm run test:rank-fusion` — URL normalisation, RRF merging/dedup, TTL cache.
- `npm run test:web-content` — extraction, truncation, SSRF, size limits.
- `npm run test:web-content-markdown` — Markdown output, chunked reads, Jina fallback.

The full suite is `npm test`.