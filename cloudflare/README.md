# open-websearch on Cloudflare Workers

An edge deployment of `open-websearch`: a keyless **web search + page fetch**
MCP server that runs entirely on Cloudflare Workers, following the same
deployment shape as the `Sink` project (stateless MCP handler, KV, `wrangler.jsonc`).

> The Node MCP server at the repository root is the primary, full-featured build.
> This Worker is the edge variant. It drops Node-only engines (Playwright, native
> modules) and keeps everything that works with plain `fetch`.

## What makes it more than "another engine"

1. **It returns evidence, not just links.** `searchAndFetch` searches, fetches
   the top pages, and returns their Markdown under a character budget in one
   call — the "search with content" shape that paid APIs sell.
2. **It routes by intent.** `topic: auto` classifies the query and fans out to
   the right free **vertical** sources (GitHub, Stack Exchange, Hacker News,
   arXiv) alongside the general web, so coding/research queries hit
   Stack Overflow and repos instead of SEO pages.
3. **It ranks, it doesn't just merge.** Reciprocal Rank Fusion is followed by a
   reranker that blends lexical query coverage, source authority, and
   freshness, then diversifies by registrable domain so one site cannot fill
   the page.
4. **It is honest.** Every search reports a `quality` block; when the free
   general-web indexes are degraded it says so and tells the caller what to do.

## Tools

| Tool | Purpose |
| --- | --- |
| `search` | Multi-engine search with topic routing, RRF, reranking, per-domain diversity, and an engine-health + quality report. |
| `searchAndFetch` | Search, then fetch the top results as Markdown under a total character budget. Returns ranked, cited evidence. |
| `fetchWebContent` | Fetch one URL as Markdown. Handles HTML, **PDFs** (native extraction), and a site's **`/llms.txt`** index; chunked via `startIndex`. |

## Free engines

| Engine | Source | Limit |
| --- | --- | --- |
| `duckduckgo` | DuckDuckGo HTML endpoint | rate-limited from datacenter IPs |
| `bing` | Bing RSS (`format=rss`) | personal, non-commercial use only |
| `wikipedia` | MediaWiki search API | generous |
| `github` | GitHub repository search API | ~10 req/min unauthenticated |
| `stackexchange` | Stack Exchange API | ~300 req/day per IP |
| `hackernews` | Hacker News (Algolia) | generous |
| `arxiv` | arXiv Atom API | generous |
| `searxng` | your own SearXNG instance | only when `SEARXNG_URL` is set |

### Topic routing

`topic: auto` (default) detects intent, then selects a cluster:

| Topic | Engines |
| --- | --- |
| `general` | duckduckgo, bing, wikipedia |
| `code` | github, stackexchange, duckduckgo, bing |
| `news` | hackernews, duckduckgo, bing |
| `academic` | arxiv, wikipedia, duckduckgo |

Override with `topic` or an explicit `engines` list.

## Ranking

1. **RRF** fuses the per-engine ranked lists and de-duplicates by normalised URL.
2. **Rerank** blends `0.55·RRF + 0.30·relevance + 0.10·authority + 0.05·freshness`,
   where relevance is query-term coverage of the title/snippet and authority is a
   small curated prior (Q&A/docs/`.gov`/`.edu` up, content farms down).
3. **Diversify** caps results per registrable domain (default 2).
4. **Quality** reports `topCoverage`, `topRelevance`, `distinctDomains`, and a
   `degraded` flag with a `hint` when general web is weak.

## Fetch pipeline

- HTML → Markdown with Mozilla Readability + linkedom + Turndown (tables and
  links preserved; relative links resolved).
- PDFs extracted natively with [`unpdf`](https://github.com/unjs/unpdf) — no Jina
  call needed.
- Root fetches try the site's `/llms.txt` index first ([llmstxt.org](https://llmstxt.org)).
- A browser `User-Agent` is used, retried once with an identifying bot UA on
  403/406.
- Layered SSRF guard: literal private/loopback addresses blocked, every redirect
  hop checked, plus a best-effort DNS-over-HTTPS resolution check.
- Optional [Jina Reader](https://jina.ai/reader/) fallback for JS-heavy/anti-bot pages.

## Reliability

- **Circuit breaker** per engine in KV: after 3 failures it is skipped for 60 s.
- **Retries** with jitter for transient failures.
- **KV cache** for repeated searches (min TTL 60 s).

## Deploy

```bash
cd cloudflare
npm install

npx wrangler kv namespace create CACHE   # paste the id into wrangler.jsonc
npx wrangler secret put MCP_AUTH_TOKEN    # recommended
npm run deploy
```

Endpoint: `https://<worker>.<subdomain>.workers.dev/mcp`; `GET /health` is the
liveness probe.

### Local development

```bash
npm run dev      # http://127.0.0.1:8787/mcp
npm run test     # pure-logic unit tests (RRF, rerank, intent)
npm run typecheck
```

### Connect a client

```jsonc
{
  "mcpServers": {
    "open-websearch": {
      "type": "http",
      "url": "https://open-websearch.<subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SEARXNG_URL` | _(unset)_ | Public SearXNG base URL; enables the `searxng` engine |
| `WIKIPEDIA_LANG` | `en` | Wikipedia language subdomain |
| `SEARCH_CACHE_TTL_SECONDS` | `300` | KV cache TTL; `0` disables |
| `ALLOWED_SEARCH_ENGINES` | all available | Comma-separated allowlist |
| `DEFAULT_SEARCH_ENGINE` | `duckduckgo` | Fallback when a request names an unavailable engine |
| `JINA_READER_ENABLED` | `false` | Enable the Jina Reader fallback |
| `JINA_API_KEY` | _(unset)_ | Optional Jina key (higher rate limit) |
| `JINA_READER_BASE_URL` | `https://r.jina.ai` | Reader base URL override |
| `MCP_AUTH_TOKEN` | _(unset)_ | Bearer token required on `/mcp` when set |

## The one real limitation: free general web

Keyless **general-web** indexes are the weak link from datacenter and edge IPs:
DuckDuckGo often returns nothing, Bing's RSS feed is low quality, Brave returns
429, Mojeek 403. The verticals (Wikipedia, GitHub, Stack Exchange, Hacker News,
arXiv) are reliable because they are real APIs, and the reranker promotes them —
which is why `topic: code`/`academic` work well while broad `general` searches
can be thin. The `quality.degraded` flag surfaces exactly this.

To fix general web, in order of preference:

1. **Host SearXNG and set `SEARXNG_URL`** (free; see below).
2. Add a **free-tier keyed provider** (e.g. Brave Search API's free plan) behind
   an optional binding — not included by default.

SearXNG itself cannot run on Workers (Python, long-lived process —
[confirmed upstream](https://github.com/searxng/searxng/discussions/4119));
Cloudflare Containers can run its image but are **Workers Paid only**.

## SearXNG sidecar

A Worker cannot reach a local Docker container on `127.0.0.1`, so host SearXNG
publicly (VPS / Fly.io / Railway). A starting point is in [`searxng/`](./searxng):

```bash
cd searxng && docker compose up -d
npx wrangler secret put SEARXNG_URL   # e.g. https://searxng.example.com
```

`searxng/settings.yml` enables JSON output (`search.formats: [html, json]`),
which this Worker requires.

## Layout

```
src/
  index.ts        Worker entry: routing, auth, CORS, health
  mcp.ts          MCP server + tools (SDK v2, stateless handler)
  search.ts       topic routing, fan-out, RRF, rerank, circuits, cache
  evidence.ts     searchAndFetch: search → fetch top pages → budgeted evidence
  rerank.ts       relevance + coverage + authority + freshness + diversity
  intent.ts       topic detection and engine clusters
  rank.ts         RRF fusion + URL normalisation
  circuit.ts      KV-backed per-engine circuit breaker
  cache.ts        KV-backed TTL cache
  fetchPage.ts    SSRF guard, Readability/PDF/llms.txt, Markdown, chunking
  markdown.ts     linkedom + Turndown (table-safe)
  http.ts         fetch helpers, entity decoding
  engines/        duckduckgo, bing, wikipedia, searxng, github, stackexchange, hackernews, arxiv, jina
test/
  core.test.ts    pure-logic tests
```

The pure modules mirror the Node core in `../src/core` and `../src/engines`; the
edge copies exist because the Worker bundle cannot resolve the Node build's
`.js`-suffixed ESM imports.