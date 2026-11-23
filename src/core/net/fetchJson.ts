/**
 * Small fetch helpers shared by the fetch-only engines (SearXNG, Wikipedia,
 * Jina Reader). These deliberately use the global `fetch` rather than axios so
 * the same modules run unchanged in Node and in edge runtimes such as
 * Cloudflare Workers.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_ENGINE_TIMEOUT_MS = 15000;

/**
 * Run `fetch` with an AbortController deadline. Works in Node 18+ and in
 * Workers, both of which expose `AbortController`, `setTimeout`, and `fetch`.
 */
export async function fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    timeoutMs: number = DEFAULT_ENGINE_TIMEOUT_MS,
    fetchImpl: FetchLike = fetch
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * GET a URL and parse a JSON body, treating any non-2xx status as an error.
 * `errorLabel` is included in thrown messages so callers can attribute
 * failures to a specific engine in their per-engine health output.
 */
export async function fetchJson<T = unknown>(
    url: string,
    init: RequestInit = {},
    timeoutMs: number = DEFAULT_ENGINE_TIMEOUT_MS,
    fetchImpl: FetchLike = fetch
): Promise<T> {
    const response = await fetchWithTimeout(url, init, timeoutMs, fetchImpl);
    if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
    }
    return (await response.json()) as T;
}

/** Collapse HTML entities/tags out of a snippet returned by a search API. */
export function stripHtml(input: string): string {
    return input
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, '\'')
        .replace(/\s+/g, ' ')
        .trim();
}
