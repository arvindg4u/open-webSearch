import { SearchResult } from '../../types.js';
import { FetchLike, fetchJson, stripHtml } from '../../core/net/fetchJson.js';

/**
 * Wikipedia via the public MediaWiki API. Keyless, fast, and far more stable
 * than scraping a search engine results page, which makes it a good
 * high-precision source to fuse alongside DuckDuckGo/SearXNG.
 *
 * API reference: https://www.mediawiki.org/wiki/API:Search
 */
export interface WikipediaOptions {
    /** Wikipedia language subdomain, e.g. `en`, `de`, `zh`. */
    lang?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    /** Contact string sent as User-Agent; the Wikimedia API asks callers to identify themselves. */
    userAgent?: string;
}

interface WikipediaSearchItem {
    title?: string;
    snippet?: string;
    timestamp?: string;
}

interface WikipediaResponse {
    query?: {
        search?: WikipediaSearchItem[];
    };
    continue?: {
        sroffset?: number;
    };
}

const DEFAULT_USER_AGENT =
    'open-websearch/2.x (+https://github.com/Aas-ee/open-webSearch)';

function buildApiUrl(options: WikipediaOptions, query: string, offset: number, limit: number): string {
    const lang = (options.lang || 'en').trim() || 'en';
    const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', query);
    url.searchParams.set('srnamespace', '0');
    url.searchParams.set('srlimit', String(Math.min(50, limit)));
    url.searchParams.set('sroffset', String(offset));
    url.searchParams.set('format', 'json');
    url.searchParams.set('origin', '*');
    return url.toString();
}

function toArticleUrl(lang: string, title: string): string {
    return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

/**
 * Search Wikipedia and return up to `limit` article results. Pagination uses
 * the API's `continue.sroffset`, so a limit above the API's 50-per-page cap
 * still works.
 */
export async function searchWikipedia(
    query: string,
    limit: number,
    options: WikipediaOptions = {}
): Promise<SearchResult[]> {
    const lang = (options.lang || 'en').trim() || 'en';
    const headers = {
        Accept: 'application/json',
        'User-Agent': options.userAgent || DEFAULT_USER_AGENT
    };

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    let offset = 0;

    while (results.length < limit && offset < 500) {
        const response = await fetchJson<WikipediaResponse>(
            buildApiUrl(options, query, offset, limit - results.length),
            { headers },
            options.timeoutMs,
            options.fetchImpl
        );

        const items = response.query?.search ?? [];
        if (items.length === 0) {
            break;
        }

        for (const item of items) {
            const title = item.title?.trim();
            if (!title) {
                continue;
            }
            const url = toArticleUrl(lang, title);
            if (seen.has(url)) {
                continue;
            }
            seen.add(url);
            results.push({
                title,
                url,
                description: stripHtml(item.snippet || ''),
                source: `${lang}.wikipedia.org`,
                engine: 'wikipedia'
            });
            if (results.length >= limit) {
                break;
            }
        }

        const nextOffset = response.continue?.sroffset;
        if (typeof nextOffset !== 'number' || nextOffset <= offset) {
            break;
        }
        offset = nextOffset;
    }

    return results.slice(0, limit);
}
