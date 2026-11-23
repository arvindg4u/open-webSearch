export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_ENGINE_TIMEOUT_MS = 15000;

/** `fetch` with an AbortController deadline (Workers runtime). */
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

/** Collapse HTML tags/entities out of a search API snippet. */
export function stripHtml(input: string): string {
    return decodeHtmlEntities(input.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Decode numeric and the common named HTML/XML entities. */
export function decodeHtmlEntities(input: string): string {
    return input
        .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#0?39;/g, "'")
        .replace(/&amp;/g, '&');
}
