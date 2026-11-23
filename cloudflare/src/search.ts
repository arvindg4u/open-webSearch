import type { Env, SearchResult, SupportedEngine, Topic } from './env';
import { readConfig, SUPPORTED_ENGINES } from './env';
import { KvTtlCache, buildCacheKey } from './cache';
import { fuseRanked } from './rank';
import type { RankedResult } from './rerank';
import { rankAndDiversify, registrableDomain } from './rerank';
import type { ResolvedTopic } from './intent';
import { detectTopic, enginesForTopic } from './intent';
import { CircuitBreaker } from './circuit';
import { searchDuckDuckGo } from './engines/duckduckgo';
import { searchBing } from './engines/bing';
import { searchSearxng } from './engines/searxng';
import { searchWikipedia } from './engines/wikipedia';
import { searchGitHub } from './engines/github';
import { searchStackExchange } from './engines/stackexchange';
import { searchHackerNews } from './engines/hackernews';
import { searchArxiv } from './engines/arxiv';

export interface SearchInput {
    query: string;
    engines?: string[];
    topic?: Topic;
    limit?: number;
    /** Cap results per registrable domain (default 2). */
    maxPerDomain?: number;
}

export interface RankedSearchResult {
    title: string;
    url: string;
    description: string;
    source: string;
    engine: string;
    engines: string[];
    score: number;
    relevance: number;
    coverage: number;
    authority: number;
    publishedAt?: string;
}

export interface EngineStat {
    engine: string;
    ok: boolean;
    resultCount: number;
    durationMs: number;
    error?: string;
    skipped?: boolean;
}

export interface SearchQuality {
    topRelevance: number;
    topCoverage: number;
    distinctDomains: number;
    enginesWithResults: number;
    degraded: boolean;
    hint?: string;
}

export interface SearchOutput {
    query: string;
    topic: ResolvedTopic;
    engines: string[];
    totalResults: number;
    results: RankedSearchResult[];
    engineStats: EngineStat[];
    quality: SearchQuality;
    cached?: boolean;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function distributeLimit(total: number, count: number): number[] {
    const base = Math.floor(total / count);
    const remainder = total % count;
    return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function isSupportedEngine(value: string): value is SupportedEngine {
    return (SUPPORTED_ENGINES as readonly string[]).includes(value);
}

function resolveTargets(env: Env, input: SearchInput): { engines: SupportedEngine[]; topic: ResolvedTopic } {
    const config = readConfig(env);

    if (input.engines && input.engines.length > 0) {
        const requested = input.engines
            .map((engine) => engine.trim().toLowerCase())
            .filter(isSupportedEngine)
            .filter((engine) => config.allowedEngines.includes(engine));
        if (requested.length > 0) {
            return { engines: requested, topic: 'general' };
        }
        return { engines: [config.defaultEngine], topic: 'general' };
    }

    const topic: ResolvedTopic = input.topic && input.topic !== 'auto'
        ? input.topic
        : detectTopic(input.query);
    return { engines: enginesForTopic(topic, config.allowedEngines), topic };
}

async function withRetry<T>(operation: () => Promise<T>, attempts = 2): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt < attempts - 1) {
                await sleep(150 + Math.random() * 250);
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function runEngine(engine: SupportedEngine, query: string, limit: number, env: Env): Promise<SearchResult[]> {
    switch (engine) {
        case 'duckduckgo':
            return searchDuckDuckGo(query, limit);
        case 'bing':
            return searchBing(query, limit);
        case 'wikipedia':
            return searchWikipedia(query, limit, { lang: readConfig(env).wikipediaLang });
        case 'searxng':
            return searchSearxng(query, limit, { baseUrl: readConfig(env).searxngUrl || '' });
        case 'github':
            return searchGitHub(query, limit);
        case 'stackexchange':
            return searchStackExchange(query, limit);
        case 'hackernews':
            return searchHackerNews(query, limit);
        case 'arxiv':
            return searchArxiv(query, limit);
        default:
            return [];
    }
}

function toRankedOutput(results: RankedResult[]): RankedSearchResult[] {
    return results.map((result) => ({
        title: result.title,
        url: result.url,
        description: result.description,
        source: result.source,
        engine: result.engine,
        engines: result.engines,
        score: Number(result.score.toFixed(4)),
        relevance: Number(result.relevance.toFixed(3)),
        coverage: Number(result.coverage.toFixed(2)),
        authority: Number(result.authority.toFixed(2)),
        ...(result.publishedAt ? { publishedAt: result.publishedAt } : {})
    }));
}

/**
 * Fan out to the topic-appropriate engines in parallel, fuse with RRF, then
 * rerank by lexical relevance + authority + freshness and diversify by domain.
 * Engines with an open circuit are skipped, and results are KV-cached.
 */
export async function runSearch(env: Env, input: SearchInput): Promise<SearchOutput> {
    const config = readConfig(env);
    const query = input.query.trim();
    if (!query) {
        throw new Error('Query string cannot be empty');
    }

    const limit = Math.max(1, Math.min(50, input.limit ?? 10));
    const maxPerDomain = Math.max(1, Math.min(10, input.maxPerDomain ?? 2));
    const { engines, topic } = resolveTargets(env, input);

    const cache = new KvTtlCache<SearchOutput>(env.CACHE);
    const cacheKey = buildCacheKey({ q: query, engines: engines.join(','), limit, maxPerDomain });
    if (config.searchCacheTtlSeconds > 0) {
        const cached = await cache.get(cacheKey);
        if (cached) {
            return { ...cached, cached: true };
        }
    }

    // Over-fetch so reranking and diversity have room to choose.
    const candidateLimit = Math.min(50, Math.max(limit * 2, limit + 5));
    const limits = distributeLimit(candidateLimit, engines.length);
    const breaker = new CircuitBreaker(env.CACHE, 3, 60);

    const outcomes = await Promise.all(
        engines.map(async (engine, index): Promise<EngineStat & { results: SearchResult[] }> => {
            const startedAt = Date.now();

            if (await breaker.isOpen(engine)) {
                return {
                    engine,
                    ok: false,
                    skipped: true,
                    resultCount: 0,
                    durationMs: Date.now() - startedAt,
                    error: 'circuit open: engine temporarily skipped after repeated failures',
                    results: []
                };
            }

            try {
                const results = await withRetry(() => runEngine(engine, query, limits[index], env));
                await breaker.recordSuccess(engine);
                return { engine, ok: true, resultCount: results.length, durationMs: Date.now() - startedAt, results };
            } catch (error) {
                await breaker.recordFailure(engine);
                return {
                    engine,
                    ok: false,
                    resultCount: 0,
                    durationMs: Date.now() - startedAt,
                    error: error instanceof Error ? error.message : String(error),
                    results: []
                };
            }
        })
    );

    const lists = outcomes
        .filter((outcome) => outcome.ok)
        .map((outcome) => ({ engine: outcome.engine, results: outcome.results }));
    const fused = fuseRanked(lists, { limit: candidateLimit });
    const ranked = rankAndDiversify(query, fused, limit, maxPerDomain);

    const enginesWithResults = outcomes.filter((outcome) => outcome.ok && outcome.resultCount > 0).length;
    const distinctDomains = new Set(
        ranked.map((result) => {
            try {
                return registrableDomain(new URL(result.url).hostname);
            } catch {
                return result.url;
            }
        })
    ).size;
    const topRelevance = ranked[0]?.relevance ?? 0;
    const topCoverage = ranked[0]?.coverage ?? 0;
    // Require at least half the query terms to appear near the top; one
    // incidental term match (e.g. "set" in "set CORS") is not a real hit.
    const degraded = ranked.length === 0 || topCoverage < 0.5 || topRelevance < 0.2;

    const output: SearchOutput = {
        query,
        topic,
        engines,
        totalResults: ranked.length,
        results: toRankedOutput(ranked),
        engineStats: outcomes.map(({ results: _results, ...stat }) => stat),
        quality: {
            topRelevance: Number(topRelevance.toFixed(3)),
            topCoverage: Number(topCoverage.toFixed(2)),
            distinctDomains,
            enginesWithResults,
            degraded,
            ...(degraded
                ? {
                    hint: topic === 'general'
                        ? 'General-web coverage looks weak for this query (free keyless indexes are rate-limited from datacenter IPs). Try topic "code" or "academic" for specialist sources, or set SEARXNG_URL to a public SearXNG instance.'
                        : 'The specialist sources for this topic returned little or were rate-limited. Retry shortly, or set SEARXNG_URL / a free-tier keyed provider for broader coverage.'
                }
                : {})
        }
    };

    if (config.searchCacheTtlSeconds > 0) {
        await cache.set(cacheKey, output, config.searchCacheTtlSeconds);
    }

    return output;
}