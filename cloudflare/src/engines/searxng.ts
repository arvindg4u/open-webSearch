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
export async function searchSearxng(
    query: string,
    limit: number,
    options: SearxngSearchOptions
): Promise<SearchResult[]> {
    if (!options.baseUrl) {
        throw new Error('SearXNG is not configured (set SEARXNG_URL)');
    }

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    let lastUnresponsive: string[] = [];

    for (let page = 1; results.length < limit && page <= 10; page++) {
        const response = await fetchJson<SearxngResponse>(
            buildSearchUrl(options.baseUrl, query, page, options),
            { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } },
            options.timeoutMs
        );

        const pageResults = response.results ?? [];
        if (pageResults.length === 0) {
            lastUnresponsive = (response.unresponsive_engines ?? []).map(([engine, reason]) => `${engine} (${reason})`);
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

    if (results.length === 0 && lastUnresponsive.length > 0) {
        throw new Error(`SearXNG returned no results; unresponsive engines: ${lastUnresponsive.join('; ')}`);
    }

    return results.slice(0, limit);
}