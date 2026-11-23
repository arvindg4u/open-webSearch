import type { Env } from './env';
import type { SearchInput, SearchQuality } from './search';
import { runSearch } from './search';
import { fetchPage } from './fetchPage';

/**
 * One-call evidence retrieval: search, fetch the top pages, and return their
 * Markdown under a total character budget. This is the "Tavily/Exa search with
 * content" shape, built only from free sources.
 */
export interface SearchAndFetchInput extends SearchInput {
    /** How many top results to fetch in full (default 3, max 8). */
    fetchTop?: number;
    /** Per-page character cap (default 6000, 1000–20000). */
    maxCharsPerPage?: number;
    /** Total character budget across all fetched pages (default 24000, max 80000). */
    totalMaxChars?: number;
    format?: 'text' | 'markdown';
}

export interface EvidenceItem {
    title: string;
    url: string;
    description: string;
    source: string;
    engine: string;
    engines: string[];
    score: number;
    relevance: number;
    authority: number;
    publishedAt?: string;
    content?: string;
    truncated?: boolean;
    finalUrl?: string;
    chars?: number;
    error?: string;
}

export interface SearchAndFetchOutput {
    query: string;
    topic: string;
    engines: string[];
    results: EvidenceItem[];
    engineStats: unknown[];
    quality: SearchQuality;
    estimatedTokens: number;
    budget: number;
    cached?: boolean;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.trunc(value)));
}

export async function searchAndFetch(env: Env, input: SearchAndFetchInput): Promise<SearchAndFetchOutput> {
    const fetchTop = clamp(input.fetchTop ?? 3, 1, 8);
    const perPage = clamp(input.maxCharsPerPage ?? 6000, 1000, 20000);
    const budget = clamp(input.totalMaxChars ?? 24000, perPage, 80000);
    const searchLimit = Math.max(input.limit ?? 8, fetchTop);

    const search = await runSearch(env, { ...input, limit: searchLimit });

    // Prefer candidates that actually match the query (lexical relevance) or
    // that several engines agreed on; fall back to the raw list if that leaves
    // nothing, so a degraded general-web search still returns something.
    const preferred = search.results.filter((result) => result.relevance >= 0.12 || result.engines.length > 1);
    // If the search is degraded and nothing actually matches the query, do not
    // waste time fetching unrelated pages. Return snippets plus the quality hint.
    const top = search.quality.degraded && preferred.length === 0
        ? []
        : (preferred.length > 0 ? preferred : search.results).slice(0, fetchTop);
    const fetchedUrls = new Set(top.map((result) => result.url));

    // Fetch in parallel under a per-page cap, then trim to the shared budget so
    // one huge page cannot starve the rest.
    const fetched = await Promise.all(
        top.map(async (result) => {
            try {
                const page = await fetchPage(result.url, env, {
                    maxChars: perPage,
                    format: input.format ?? 'markdown'
                });
                return { result, page };
            } catch (error) {
                return {
                    result,
                    error: error instanceof Error ? error.message : String(error)
                };
            }
        })
    );

    let used = 0;
    const results: EvidenceItem[] = [];

    for (const entry of fetched) {
        const base: EvidenceItem = {
            title: entry.result.title,
            url: entry.result.url,
            description: entry.result.description,
            source: entry.result.source,
            engine: entry.result.engine,
            engines: entry.result.engines,
            score: entry.result.score,
            relevance: entry.result.relevance,
            authority: entry.result.authority,
            ...(entry.result.publishedAt ? { publishedAt: entry.result.publishedAt } : {})
        };

        if (!('page' in entry) || !entry.page) {
            results.push({ ...base, error: 'error' in entry ? entry.error : 'fetch failed' });
            continue;
        }

        const remaining = budget - used;
        if (remaining < 200) {
            results.push({ ...base, error: 'total character budget reached before this page' });
            continue;
        }

        let content = entry.page.content;
        let truncated = entry.page.truncated;
        if (content.length > remaining) {
            content = `${content.slice(0, remaining)}\n\n[...truncated to fit the total budget]`;
            truncated = true;
        }
        used += content.length;

        results.push({
            ...base,
            title: entry.page.title || base.title,
            finalUrl: entry.page.finalUrl,
            content,
            truncated,
            chars: content.length
        });
    }

    // Keep the remaining search hits as snippet-only context.
    for (const result of search.results) {
        if (fetchedUrls.has(result.url)) {
            continue;
        }
        results.push({
            title: result.title,
            url: result.url,
            description: result.description,
            source: result.source,
            engine: result.engine,
            engines: result.engines,
            score: result.score,
            relevance: result.relevance,
            authority: result.authority,
            ...(result.publishedAt ? { publishedAt: result.publishedAt } : {})
        });
    }

    return {
        query: search.query,
        topic: search.topic,
        engines: search.engines,
        results,
        engineStats: search.engineStats,
        quality: search.quality,
        estimatedTokens: Math.ceil(used / 4),
        budget,
        ...(search.cached ? { cached: true } : {})
    };
}