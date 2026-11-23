import { SearchResult } from '../../types.js';
import { FetchLike, fetchJson, stripHtml } from '../../core/net/fetchJson.js';

/**
 * SearXNG is a self-hosted metasearch engine that aggregates results from many
 * upstream engines (DuckDuckGo, Brave, Wikipedia, Qwant, ...) and exposes a
 * clean JSON API. One stable upstream replaces a pile of per-engine scrapers,
 * which is exactly the reliability problem this module exists to solve.
 *
 * API reference: https://docs.searxng.org/dev/search_api.html
 * (GET/POST /search with `format=json`; `format` must be enabled in the
 * instance's settings.yml `search.formats`).
 */
export interface SearxngOptions {
    /** Base URL of the instance, e.g. http://127.0.0.1:8888 (no trailing slash required). */
    baseUrl: string;
    categories?: string;
    language?: string;
    timeRange?: 'day' | 'month' | 'year';
    safeSearch?: 0 | 1 | 2;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
}

interface SearxngResult {
    url?: string;
    title?: string;
    content?: string;
    engine?: string;
    engines?: string[];
}

interface SearxngResponse {
    results?: SearxngResult[];
    unresponsive_engines?: Array<[string, string]>;
}

function buildSearchUrl(options: SearxngOptions, query: string, page: number): string {
    const base = options.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('pageno', String(page));
    if (options.categories) {
        url.searchParams.set('categories', options.categories);
    }
    if (options.language) {
        url.searchParams.set('language', options.language);
    }
    if (options.timeRange) {
        url.searchParams.set('time_range', options.timeRange);
    }
    if (typeof options.safeSearch === 'number') {
        url.searchParams.set('safesearch', String(options.safeSearch));
    }
    return url.toString();
}

function toSearchResult(item: SearxngResult): SearchResult | undefined {
    const url = item.url?.trim();
    const title = item.title?.trim();
    if (!url || !title) {
        return undefined;
    }

    const contributingEngines = item.engines?.length
        ? item.engines
        : item.engine
            ? [item.engine]
            : [];

    return {
        title,
        url,
        description: stripHtml(item.content || ''),
        source: contributingEngines.join(', '),
        engine: 'searxng',
        ...(contributingEngines.length > 1 ? { engines: [...contributingEngines] } : {})
    };
}

/**
 * Query a SearXNG instance and return up to `limit` results, following
 * pagination (`pageno`) until the limit is met or a page comes back empty.
 */
export async function searchSearxng(
    query: string,
    limit: number,
    options: SearxngOptions
): Promise<SearchResult[]> {
    if (!options.baseUrl) {
        throw new Error('SearXNG base URL is not configured (set SEARXNG_URL)');
    }

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    let lastUnresponsive: string[] = [];

    for (let page = 1; results.length < limit && page <= 10; page++) {
        const response = await fetchJson<SearxngResponse>(
            buildSearchUrl(options, query, page),
            { headers: { Accept: 'application/json' } },
            options.timeoutMs,
            options.fetchImpl
        );

        const pageResults = response.results ?? [];
        if (pageResults.length === 0) {
            lastUnresponsive = (response.unresponsive_engines ?? []).map(
                ([engine, reason]) => `${engine} (${reason})`
            );
            break;
        }

        for (const item of pageResults) {
            if (results.length >= limit) {
                break;
            }
            const mapped = toSearchResult(item);
            if (!mapped || seen.has(mapped.url)) {
                continue;
            }
            seen.add(mapped.url);
            results.push(mapped);
        }
    }

    if (results.length === 0 && lastUnresponsive.length > 0) {
        throw new Error(`SearXNG returned no results; unresponsive engines: ${lastUnresponsive.join('; ')}`);
    }

    return results.slice(0, limit);
}
