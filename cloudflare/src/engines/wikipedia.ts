import type { SearchResult } from '../env';
import { fetchJson, stripHtml } from '../http';

interface WikipediaSearchItem {
    title?: string;
    snippet?: string;
}

interface WikipediaResponse {
    query?: { search?: WikipediaSearchItem[] };
    continue?: { sroffset?: number };
}

const USER_AGENT = 'open-websearch-cloudflare/0.1 (+https://github.com/Aas-ee/open-webSearch)';

/** Wikipedia via the public MediaWiki search API (keyless). */
export async function searchWikipedia(
    query: string,
    limit: number,
    options: { lang?: string; timeoutMs?: number } = {}
): Promise<SearchResult[]> {
    const lang = (options.lang || 'en').trim() || 'en';
    const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    let offset = 0;

    while (results.length < limit && offset < 500) {
        const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
        url.searchParams.set('action', 'query');
        url.searchParams.set('list', 'search');
        url.searchParams.set('srsearch', query);
        url.searchParams.set('srnamespace', '0');
        url.searchParams.set('srlimit', String(Math.min(50, limit - results.length)));
        url.searchParams.set('sroffset', String(offset));
        url.searchParams.set('format', 'json');
        url.searchParams.set('origin', '*');

        const response = await fetchJson<WikipediaResponse>(url.toString(), { headers }, options.timeoutMs);
        const items = response.query?.search ?? [];
        if (items.length === 0) {
            break;
        }

        for (const item of items) {
            const title = item.title?.trim();
            if (!title) {
                continue;
            }
            const articleUrl = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
            if (seen.has(articleUrl)) {
                continue;
            }
            seen.add(articleUrl);
            results.push({
                title,
                url: articleUrl,
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