import type { SearchResult } from '../env';
import { decodeHtmlEntities, fetchJson } from '../http';

/**
 * Stack Exchange search via the public API. Keyless use is limited to ~300
 * requests/day per IP (10,000 with a registered app key), so this is a
 * vertical that the circuit breaker will shed under pressure.
 * Docs: https://api.stackexchange.com/docs
 */
const USER_AGENT = 'open-websearch-cloudflare/0.1 (+https://github.com/Aas-ee/open-webSearch)';

interface StackExchangeItem {
    title?: string;
    link?: string;
    score?: number;
    answer_count?: number;
    is_answered?: boolean;
    creation_date?: number;
    tags?: string[];
}

interface StackExchangeResponse {
    items?: StackExchangeItem[];
}

export async function searchStackExchange(
    query: string,
    limit: number,
    options: { timeoutMs?: number; site?: string } = {}
): Promise<SearchResult[]> {
    const url = new URL('https://api.stackexchange.com/2.3/search/advanced');
    url.searchParams.set('order', 'desc');
    url.searchParams.set('sort', 'relevance');
    url.searchParams.set('q', query);
    url.searchParams.set('site', options.site || 'stackoverflow');
    url.searchParams.set('pagesize', String(Math.min(10, Math.max(1, limit))));
    url.searchParams.set('filter', 'default');

    const response = await fetchJson<StackExchangeResponse>(
        url.toString(),
        { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip' } },
        options.timeoutMs
    );

    return (response.items ?? [])
        .filter((item): item is StackExchangeItem & { title: string; link: string } =>
            Boolean(item.title && item.link))
        .map((item) => ({
            title: decodeHtmlEntities(item.title),
            url: item.link,
            description: [
                typeof item.score === 'number' ? `score ${item.score}` : '',
                typeof item.answer_count === 'number' ? `${item.answer_count} answers` : '',
                item.is_answered ? 'accepted' : '',
                item.tags?.length ? item.tags.slice(0, 4).join(', ') : ''
            ].filter(Boolean).join(' · '),
            source: options.site || 'stackoverflow.com',
            engine: 'stackexchange',
            ...(item.creation_date ? { publishedAt: new Date(item.creation_date * 1000).toISOString() } : {})
        }))
        .slice(0, limit);
}