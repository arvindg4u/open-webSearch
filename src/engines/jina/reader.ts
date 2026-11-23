import { FetchLike, fetchWithTimeout } from '../../core/net/fetchJson.js';

/**
 * Jina Reader converts any URL (including JS-rendered pages and PDFs) into
 * LLM-friendly Markdown. It is free at 20 requests/minute per IP without a
 * key, and 500 RPM with a free key. Used here only as an opt-in fallback for
 * pages this server cannot render itself.
 *
 * Reference: https://jina.ai/reader/
 *   GET https://r.jina.ai/{url}   Reader
 *   Accept: application/json      JSON envelope { data: { title, content, ... } }
 */
export interface JinaReaderOptions {
    /** Optional API key (raises the rate limit). Sent as `Authorization: Bearer`. */
    apiKey?: string;
    /** Reader base URL. Defaults to https://r.jina.ai. */
    baseUrl?: string;
    timeoutMs?: number;
    /** `direct` skips browser rendering; omit to let Reader choose (browser by default). */
    engine?: 'direct' | 'browser' | 'cf-browser-rendering';
    targetSelector?: string;
    removeSelector?: string;
    fetchImpl?: FetchLike;
}

export interface JinaReaderResult {
    url: string;
    title: string;
    content: string;
    description?: string;
}

interface JinaEnvelope {
    code?: number;
    status?: number;
    data?: {
        title?: string;
        url?: string;
        content?: string;
        description?: string;
    };
    message?: string;
}

/**
 * Read a URL through Jina Reader and return its Markdown content. Throws on a
 * non-2xx response or a reader-level error code so the caller can fall back.
 */
export async function fetchViaJinaReader(
    targetUrl: string,
    options: JinaReaderOptions = {}
): Promise<JinaReaderResult> {
    const base = (options.baseUrl || 'https://r.jina.ai').replace(/\/+$/, '');
    const endpoint = `${base}/${targetUrl}`;

    const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-Return-Format': 'markdown',
        'X-Timeout': String(Math.max(1, Math.round((options.timeoutMs ?? 20000) / 1000)))
    };
    if (options.engine) {
        headers['X-Engine'] = options.engine;
    }
    if (options.targetSelector) {
        headers['X-Target-Selector'] = options.targetSelector;
    }
    if (options.removeSelector) {
        headers['X-Remove-Selector'] = options.removeSelector;
    }
    if (options.apiKey) {
        headers.Authorization = `Bearer ${options.apiKey}`;
    }

    const response = await fetchWithTimeout(
        endpoint,
        { method: 'GET', headers },
        options.timeoutMs ?? 20000,
        options.fetchImpl
    );

    if (!response.ok) {
        throw new Error(`Jina Reader request failed with status ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        const envelope = (await response.json()) as JinaEnvelope;
        if (!envelope.data?.content) {
            throw new Error(`Jina Reader returned no content${envelope.message ? `: ${envelope.message}` : ''}`);
        }
        return {
            url: envelope.data.url || targetUrl,
            title: envelope.data.title || '',
            content: envelope.data.content,
            description: envelope.data.description
        };
    }

    const content = await response.text();
    if (!content.trim()) {
        throw new Error('Jina Reader returned an empty body');
    }
    return { url: targetUrl, title: '', content };
}
