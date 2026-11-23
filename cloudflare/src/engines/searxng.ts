import type { SearchResult } from '../env';
import { fetchJson, stripHtml } from '../http';

const USER_AGENT = 'open-websearch-cloudflare/0.1 (+https://github.com/Aas-ee/open-webSearch)';

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

export interface SearxngSearchOptions {
    baseUrl: string;
    categories?: string;
    language?: string;
    timeRange?: 'day' | 'month' | 'year';
    timeoutMs?: number;
    /** Bearer token sent to the instance (e.g. when it is behind an auth proxy). */
    apiKey?: string;
}

function buildSearchUrl(baseUrl: string, query: string, page: number, options: SearxngSearchOptions): string {
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/search`);
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
    return url.toString();
}

/** Query a SearXNG instance's JSON API. See https://docs.searxng.org/dev/search_api.html */
async function searchSearxngOnce(
    query: string,
    limit: number,
    options: SearxngSearchOptions
): Promise<SearchResult[]> {
    if (!options.baseUrl) {
        throw new Error('SearXNG is not configured (set SEARXNG_URL)');
    }

    const results: SearchResult[] = [];
    const seen = new Set<string>();

    for (let page = 1; results.length < limit && page <= 10; page++) {
        const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT };
        if (options.apiKey) {
            headers.Authorization = `Bearer ${options.apiKey}`;
        }

        const response = await fetchJson<SearxngResponse>(
            buildSearchUrl(options.baseUrl, query, page, options),
            { headers },
            options.timeoutMs
        );

        const pageResults = response.results ?? [];
        if (pageResults.length === 0) {
            break;
        }

        for (const item of pageResults) {
            if (results.length >= limit) {
                break;
            }
            const url = item.url?.trim();
            const title = item.title?.trim();
            if (!url || !title || seen.has(url)) {
                continue;
            }
            seen.add(url);
            const contributing = item.engines?.length ? item.engines : item.engine ? [item.engine] : [];
            results.push({
                title,
                url,
                description: stripHtml(item.content || ''),
                source: contributing.join(', '),
                engine: 'searxng',
                ...(contributing.length > 1 ? { engines: [...contributing] } : {})
            });
        }
    }

    return results.slice(0, limit);
}

/**
 * Query SearXNG, retrying with a shortened query when a very long query returns
 * nothing (Google yields no results for over-specific strings). A zero-result
 * page is not an engine failure, so it does not trip the circuit breaker.
 */
export async function searchSearxng(
    query: string,
    limit: number,
    options: SearxngSearchOptions
): Promise<SearchResult[]> {
    const words = query.trim().split(/\s+/);
    const attempts = [query];
    if (words.length > 8) attempts.push(words.slice(0, 8).join(' '));
    if (words.length > 5) attempts.push(words.slice(0, 5).join(' '));

    let results: SearchResult[] = [];
    for (const attempt of attempts) {
        results = await searchSearxngOnce(attempt, limit, options);
        if (results.length > 0) {
            return results;
        }
    }
    return results;
}