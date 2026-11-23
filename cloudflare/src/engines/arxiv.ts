import type { SearchResult } from '../env';
import { decodeHtmlEntities, fetchWithTimeout } from '../http';

/**
 * arXiv search via the public Atom API (no key). Good for papers and technical
 * preprints. The Atom `<link>` element is void in HTML parsers, so entries are
 * read at the text level like the Bing RSS engine.
 * Docs: https://info.arxiv.org/help/api/user-manual.html
 */
const USER_AGENT = 'open-websearch-cloudflare/0.1 (+https://github.com/Aas-ee/open-webSearch)';

function extractTag(block: string, tag: string): string {
    const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
    return match ? decodeHtmlEntities(match[1].replace(/\s+/g, ' ').trim()) : '';
}

export async function searchArxiv(
    query: string,
    limit: number,
    options: { timeoutMs?: number } = {}
): Promise<SearchResult[]> {
    const url = new URL('https://export.arxiv.org/api/query');
    url.searchParams.set('search_query', `all:${query}`);
    url.searchParams.set('start', '0');
    url.searchParams.set('max_results', String(Math.min(20, Math.max(1, limit))));
    url.searchParams.set('sortBy', 'relevance');

    const response = await fetchWithTimeout(
        url.toString(),
        { headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml,application/xml,text/xml' } },
        options.timeoutMs
    );
    if (!response.ok) {
        throw new Error(`arXiv responded with status ${response.status}`);
    }

    const xml = await response.text();
    const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];

    return entries
        .map((entry) => {
            const title = extractTag(entry, 'title');
            const absUrl = extractTag(entry, 'id');
            const summary = extractTag(entry, 'summary');
            const published = extractTag(entry, 'published');
            if (!title || !absUrl) {
                return undefined;
            }
            return {
                title,
                url: absUrl.replace(/^http:\/\//, 'https://'),
                description: summary.slice(0, 400),
                source: 'arxiv.org',
                engine: 'arxiv',
                ...(published ? { publishedAt: published } : {})
            } satisfies SearchResult;
        })
        .filter((result): result is SearchResult => Boolean(result))
        .slice(0, limit);
}