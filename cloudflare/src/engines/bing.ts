import type { SearchResult } from '../env';
import { fetchWithTimeout } from '../http';

/**
 * Bing's RSS endpoint (`format=rss`) returns machine-readable results without
 * an API key. It is a pragmatic free fallback for edge deployments where
 * DuckDuckGo is often rate-limited from datacenter IPs.
 *
 * Note: Bing's RSS copyright restricts the feed to personal, non-commercial
 * RSS rendering. Keep `bing` out of `ALLOWED_SEARCH_ENGINES` if that does not
 * fit your use.
 */
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

function decodeXml(input: string): string {
    return input
        .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .trim();
}

function extractTag(block: string, tag: string): string {
    const cdata = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i').exec(block);
    if (cdata) {
        return decodeXml(cdata[1]);
    }
    const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
    return plain ? decodeXml(plain[1]) : '';
}

interface BingRssItem {
    title: string;
    link: string;
    description: string;
}

export function parseBingRss(xml: string): BingRssItem[] {
    const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
    const items: BingRssItem[] = [];

    for (const block of blocks) {
        const title = extractTag(block, 'title');
        const link = extractTag(block, 'link');
        if (!title || !link) {
            continue;
        }
        items.push({ title, link, description: extractTag(block, 'description') });
    }

    return items;
}

function hostnameOf(link: string): string {
    try {
        return new URL(link).hostname;
    } catch {
        return '';
    }
}

export async function searchBing(
    query: string,
    limit: number,
    options: { timeoutMs?: number } = {}
): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const seen = new Set<string>();

    for (let first = 1; results.length < limit && first <= 101; first += 10) {
        const endpoint = new URL('https://www.bing.com/search');
        endpoint.searchParams.set('q', query);
        endpoint.searchParams.set('format', 'rss');
        endpoint.searchParams.set('first', String(first));

        const response = await fetchWithTimeout(
            endpoint.toString(),
            { headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml,application/xml,text/xml' } },
            options.timeoutMs
        );

        if (!response.ok) {
            throw new Error(`Bing RSS responded with status ${response.status}`);
        }

        const items = parseBingRss(await response.text());
        if (items.length === 0) {
            break;
        }

        let added = 0;
        for (const item of items) {
            if (results.length >= limit) {
                break;
            }
            if (seen.has(item.link)) {
                continue;
            }
            seen.add(item.link);
            results.push({
                title: item.title,
                url: item.link,
                description: item.description,
                source: hostnameOf(item.link),
                engine: 'bing'
            });
            added += 1;
        }

        if (added === 0) {
            break;
        }
    }

    return results.slice(0, limit);
}