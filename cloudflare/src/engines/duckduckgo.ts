import { parseHTML } from 'linkedom';
import type { SearchResult } from '../env';
import { fetchWithTimeout } from '../http';

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * DuckDuckGo HTML endpoint (keyless). Each result link is a
 * `//duckduckgo.com/l/?uddg=<url>` redirect, so the real target is decoded out
 * of the `uddg` parameter.
 */
function unwrapDuckDuckGoHref(href: string): string {
    try {
        const parsed = new URL(href, 'https://duckduckgo.com');
        const target = parsed.searchParams.get('uddg');
        return target ? decodeURIComponent(target) : parsed.toString();
    } catch {
        return href;
    }
}

export async function searchDuckDuckGo(
    query: string,
    limit: number,
    options: { timeoutMs?: number } = {}
): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    let offset = 0;

    for (let page = 0; results.length < limit && page < 10; page++) {
        const endpoint = new URL('https://html.duckduckgo.com/html/');
        endpoint.searchParams.set('q', query);
        if (offset > 0) {
            endpoint.searchParams.set('s', String(offset));
        }

        const response = await fetchWithTimeout(
            endpoint.toString(),
            {
                headers: {
                    'User-Agent': USER_AGENT,
                    Accept: 'text/html,application/xhtml+xml',
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            },
            options.timeoutMs
        );

        if (!response.ok) {
            throw new Error(`DuckDuckGo responded with status ${response.status}`);
        }

        const { document } = parseHTML(await response.text());
        const cards = Array.from(document.querySelectorAll('div.result'));
        if (cards.length === 0) {
            break;
        }

        let added = 0;
        for (const card of cards) {
            if (results.length >= limit) {
                break;
            }
            if ((card.getAttribute('class') || '').includes('result--ad')) {
                continue;
            }
            const link = card.querySelector('a.result__a');
            if (!link) {
                continue;
            }
            const title = (link.textContent || '').trim();
            const url = unwrapDuckDuckGoHref(link.getAttribute('href') || '');
            if (!title || !url || seen.has(url)) {
                continue;
            }
            seen.add(url);
            results.push({
                title,
                url,
                description: (card.querySelector('.result__snippet')?.textContent || '').trim(),
                source: (card.querySelector('.result__url')?.textContent || '').trim(),
                engine: 'duckduckgo'
            });
            added += 1;
        }

        if (added === 0) {
            break;
        }
        offset += cards.length;
    }

    return results.slice(0, limit);
}