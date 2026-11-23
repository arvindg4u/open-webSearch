import { fetchWithTimeout } from '../http';

/**
 * Jina Reader: free URL → LLM-friendly Markdown (20 RPM without a key), with
 * browser rendering and PDF support. Used only as an opt-in fallback.
 * Reference: https://jina.ai/reader/
 */
export interface JinaReaderOptions {
    apiKey?: string;
    baseUrl?: string;
    timeoutMs?: number;
}

export interface JinaReaderResult {
    url: string;
    title: string;
    content: string;
    description?: string;
}

interface JinaEnvelope {
    data?: { title?: string; url?: string; content?: string; description?: string };
    message?: string;
}

export async function fetchViaJinaReader(
    targetUrl: string,
    options: JinaReaderOptions = {}
): Promise<JinaReaderResult> {
    const base = (options.baseUrl || 'https://r.jina.ai').replace(/\/+$/, '');
    const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-Return-Format': 'markdown',
        'X-Timeout': String(Math.max(1, Math.round((options.timeoutMs ?? 20000) / 1000)))
    };
    if (options.apiKey) {
        headers.Authorization = `Bearer ${options.apiKey}`;
    }

    const response = await fetchWithTimeout(
        `${base}/${targetUrl}`,
        { headers },
        options.timeoutMs ?? 20000
    );
    if (!response.ok) {
        throw new Error(`Jina Reader request failed with status ${response.status}`);
    }

    if ((response.headers.get('content-type') || '').includes('application/json')) {
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