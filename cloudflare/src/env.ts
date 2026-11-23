/**
 * Minimal Workers KV surface this server uses. Declared locally so the package
 * does not depend on `@cloudflare/workers-types` for a type-only concern; the
 * binding is supplied by `wrangler.jsonc`.
 */
export interface KvNamespace {
    get(key: string, type: 'json'): Promise<unknown>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** Bindings and variables available to the Worker (see wrangler.jsonc + .env.example). */
export interface Env {
    CACHE?: KvNamespace;
    SEARXNG_URL?: string;
    SEARXNG_API_KEY?: string;
    WIKIPEDIA_LANG?: string;
    SEARCH_CACHE_TTL_SECONDS?: string;
    ALLOWED_SEARCH_ENGINES?: string;
    DEFAULT_SEARCH_ENGINE?: string;
    JINA_READER_ENABLED?: string;
    JINA_API_KEY?: string;
    JINA_READER_BASE_URL?: string;
    MCP_AUTH_TOKEN?: string;
}

/** A single search hit. Mirrors the Node core's SearchResult. */
export interface SearchResult {
    title: string;
    url: string;
    description: string;
    source: string;
    engine: string;
    engines?: string[];
    /** ISO-8601 publication time, when the source provides one (news/papers). */
    publishedAt?: string;
}

export const SUPPORTED_ENGINES = [
    'duckduckgo',
    'bing',
    'wikipedia',
    'searxng',
    'github',
    'stackexchange',
    'hackernews',
    'arxiv'
] as const;
export type SupportedEngine = typeof SUPPORTED_ENGINES[number];

/** Query intent, used to pick which engine cluster to fan out to. */
export type Topic = 'auto' | 'general' | 'code' | 'news' | 'academic';

export interface RuntimeConfig {
    searxngUrl?: string;
    searxngApiKey?: string;
    wikipediaLang: string;
    searchCacheTtlSeconds: number;
    allowedEngines: SupportedEngine[];
    defaultEngine: SupportedEngine;
    jinaEnabled: boolean;
    jinaApiKey?: string;
    jinaBaseUrl?: string;
}

export function readConfig(env: Env): RuntimeConfig {
    const allowed = (env.ALLOWED_SEARCH_ENGINES || '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter((value): value is SupportedEngine => (SUPPORTED_ENGINES as readonly string[]).includes(value));

    const requestedDefault = (env.DEFAULT_SEARCH_ENGINE || 'duckduckgo').trim().toLowerCase() as SupportedEngine;
    const defaultEngine = (SUPPORTED_ENGINES as readonly string[]).includes(requestedDefault)
        ? requestedDefault
        : 'duckduckgo';

    // Default to every engine that can actually answer: SearXNG is only
    // available when a URL is configured, so an unconfigured instance does not
    // show up as a guaranteed per-request failure.
    const available = SUPPORTED_ENGINES.filter((engine) => engine !== 'searxng' || Boolean(env.SEARXNG_URL?.trim()));

    return {
        searxngUrl: env.SEARXNG_URL?.trim() || undefined,
        searxngApiKey: env.SEARXNG_API_KEY?.trim() || undefined,
        wikipediaLang: env.WIKIPEDIA_LANG?.trim() || 'en',
        searchCacheTtlSeconds: Number(env.SEARCH_CACHE_TTL_SECONDS || 0) || 0,
        allowedEngines: allowed.length > 0 ? allowed : [...available],
        defaultEngine,
        jinaEnabled: env.JINA_READER_ENABLED === 'true',
        jinaApiKey: env.JINA_API_KEY?.trim() || undefined,
        jinaBaseUrl: env.JINA_READER_BASE_URL?.trim() || undefined
    };
}
