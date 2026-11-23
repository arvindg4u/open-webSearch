import type { SearchResult } from '../env';
import { fetchJson } from '../http';

/**
 * Hacker News search via the public Algolia API (no key, no documented rate
 * limit). Useful for engineering news and discussion, which general web
 * indexes often rank poorly.
 * Docs: https://hn.algolia.com/api
 */
const USER_AGENT = 'open-websearch-cloudflare/0.1 (+https://github.com/Aas-ee/open-webSearch)';

interface HnHit {
    objectID?: string;
    title?: string;
    url?: string;
    points?: number;
    num_comments?: number;
    created_at?: string;
    author?: string;
}

interface HnResponse {
    hits?: HnHit[];
}

function hostOf(url: string | undefined): string {
    if (!url) {
        return 'news.ycombinator.com';
    }
    try {
        return new URL(url).hostname;
    } catch {
        return 'news.ycombinator.com';
    }
}

export async function searchHackerNews(
    query: string,
    limit: number,
    options: { timeoutMs?: number } = {}
): Promise<SearchResult[]> {
    const url = new URL('https://hn.algolia.com/api/v1/search');
    url.searchParams.set('query', query);
    url.searchParams.set('tags', 'story');
    url.searchParams.set('hitsPerPage', String(Math.min(20, Math.max(1, limit))));

    const response = await fetchJson<HnResponse>(
        url.toString(),
        { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } },
        options.timeoutMs
    );

    return (response.hits ?? [])
        .filter((hit): hit is HnHit & { title: string } => Boolean(hit.title))
        .map((hit) => {
            const discussion = hit.objectID ? `https://news.ycombinator.com/item?id=${hit.objectID}` : '';
            return {
                title: hit.title,
                url: hit.url || discussion,
                description: [
                    typeof hit.points === 'number' ? `${hit.points} points` : '',
                    typeof hit.num_comments === 'number' ? `${hit.num_comments} comments` : '',
                    `HN: ${discussion}`
                ].filter(Boolean).join(' · '),
                source: hostOf(hit.url),
                engine: 'hackernews',
                ...(hit.created_at ? { publishedAt: hit.created_at } : {})
            };
        })
        .slice(0, limit);
}