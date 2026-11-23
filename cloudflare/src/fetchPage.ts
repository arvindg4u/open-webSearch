import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { extractText, getDocumentProxy } from 'unpdf';
import type { Env } from './env';
import { readConfig } from './env';
import { fetchWithTimeout } from './http';
import { htmlToMarkdown } from './markdown';
import { fetchViaJinaReader } from './engines/jina';

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MAX_DEFAULT_CHARS = 30000;
const MIN_MAX_CHARS = 1000;
const MAX_MAX_CHARS = 200000;
const REQUEST_TIMEOUT_MS = 20000;
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
// Some sites reject browser UAs and accept an identifying bot UA (or vice
// versa). Retry once with this when the browser UA is refused.
const BOT_USER_AGENT = 'open-websearch-cloudflare/0.1 (+https://github.com/Aas-ee/open-webSearch)';

export interface FetchPageOptions {
    maxChars?: number;
    startIndex?: number;
    format?: 'text' | 'markdown';
    readability?: boolean;
    jinaFallback?: boolean;
    /** Try the site's /llms.txt index first (default: true for root paths). */
    preferLlmsTxt?: boolean;
}

export interface FetchPageResult {
    url: string;
    finalUrl: string;
    contentType: string;
    title: string;
    retrievalMethod: 'request' | 'jina-reader' | 'llms-txt';
    truncated: boolean;
    content: string;
    nextStartIndex?: number;
    totalChars?: number;
    readabilityApplied?: boolean;
    byline?: string;
    excerpt?: string;
    siteName?: string;
    llmsTxt?: boolean;
    pdf?: boolean;
    lang?: string;
    canonicalUrl?: string;
}

function isBlockedHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) {
        return true;
    }
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
        return true;
    }

    const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const parts = v4.slice(1).map(Number);
        if (parts.some((part) => part > 255)) {
            return true;
        }
        const [a, b] = parts;
        if (a === 0 || a === 10 || a === 127) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 100 && b >= 64 && b <= 127) return true;
        return false;
    }

    if (host.includes(':')) {
        if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
            return true;
        }
    }

    return false;
}

function assertHttpUrl(url: string): URL {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('URL must use HTTP or HTTPS');
    }
    if (isBlockedHost(parsed.hostname)) {
        throw new Error('URL points to a private or local network target, which is not allowed');
    }
    return parsed;
}

/**
 * Defence-in-depth DNS check through Cloudflare's DNS-over-HTTPS resolver. The
 * Workers runtime exposes no DNS API, so a literal-IP check alone would miss a
 * hostname resolving to a private address. Best-effort: if DoH is unreachable
 * we continue (and the request still goes through the runtime's own resolver).
 */
async function assertResolvesPublic(hostname: string): Promise<void> {
    if (!hostname || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
        return;
    }
    try {
        const response = await fetchWithTimeout(
            `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
            { headers: { accept: 'application/dns-json' } },
            4000
        );
        if (!response.ok) {
            return;
        }
        const data = (await response.json()) as { Answer?: Array<{ data?: string }> };
        for (const answer of data.Answer ?? []) {
            if (answer.data && isBlockedHost(answer.data)) {
                throw new Error('URL resolves to a private or local network target, which is not allowed');
            }
        }
    } catch (error) {
        if (error instanceof Error && error.message.includes('private or local')) {
            throw error;
        }
        // DNS check unavailable: proceed with the runtime resolver.
    }
}

async function fetchWithSafeRedirects(
    url: string,
    init: RequestInit,
    timeoutMs: number
): Promise<{ response: Response; finalUrl: string }> {
    let current = url;
    for (let hop = 0; hop <= 5; hop++) {
        const parsed = assertHttpUrl(current);
        await assertResolvesPublic(parsed.hostname);
        const response = await fetchWithTimeout(current, { ...init, redirect: 'manual' }, timeoutMs);

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) {
                return { response, finalUrl: current };
            }
            current = new URL(location, current).toString();
            continue;
        }
        return { response, finalUrl: current };
    }
    throw new Error('Too many redirects (max 5)');
}

function pickMainHtml(document: ReturnType<typeof parseHTML>['document']): string {
    const selectors = [
        'article',
        'main',
        '[role="main"]',
        '.markdown-body',
        '.article-content',
        '.post-content',
        '.entry-content',
        '.content'
    ];
    for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && (element.textContent || '').trim().length >= 120) {
            return element.innerHTML;
        }
    }
    return document.body?.innerHTML || '';
}

function clampMaxChars(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return MAX_DEFAULT_CHARS;
    }
    return Math.max(MIN_MAX_CHARS, Math.min(MAX_MAX_CHARS, Math.trunc(value)));
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join('\n\n') : text;
}

/**
 * Fetch a site's /llms.txt index. It is an emerging, agent-oriented Markdown
 * map of a site (https://llmstxt.org), and is much cheaper than crawling.
 */
async function tryLlmsTxt(origin: string): Promise<{ content: string; title?: string } | undefined> {
    try {
        const response = await fetchWithTimeout(
            `${origin}/llms.txt`,
            { headers: { 'User-Agent': USER_AGENT, Accept: 'text/markdown,text/plain' } },
            8000
        );
        if (!response.ok) {
            return undefined;
        }
        const body = await response.text();
        if (!body.trim()) {
            return undefined;
        }
        const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
        return { content: body.trim(), ...(title ? { title } : {}) };
    } catch {
        return undefined;
    }
}

/**
 * Fetch a public URL and return LLM-friendly content. HTML is reduced with
 * Mozilla Readability (when it yields an article) and converted to Markdown;
 * PDFs are extracted with unpdf; `startIndex` + `maxChars` page through long
 * content.
 */
export async function fetchPage(
    url: string,
    env: Env,
    options: FetchPageOptions = {}
): Promise<FetchPageResult> {
    const config = readConfig(env);
    const parsed = assertHttpUrl(url);
    const format = options.format ?? 'markdown';

    const requestInit = (userAgent: string): RequestInit => ({
        method: 'GET',
        headers: {
            'User-Agent': userAgent,
            Accept: 'text/markdown,text/plain,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    });

    let { response, finalUrl } = await fetchWithSafeRedirects(
        parsed.toString(),
        requestInit(USER_AGENT),
        REQUEST_TIMEOUT_MS
    );

    // A browser UA is the better default, but some origins (W3C's test server,
    // for one) reject it with 403/406 and accept an identifying bot UA.
    if (response.status === 403 || response.status === 406) {
        const retry = await fetchWithSafeRedirects(parsed.toString(), requestInit(BOT_USER_AGENT), REQUEST_TIMEOUT_MS);
        if (retry.response.ok) {
            response = retry.response;
            finalUrl = retry.finalUrl;
        }
    }

    if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
        throw new Error(`Response body too large (${contentLength} bytes); max is ${MAX_DOWNLOAD_BYTES}`);
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const isPdf = contentType.includes('application/pdf') || /\.pdf$/i.test(parsed.pathname);

    let title = '';
    let byline: string | undefined;
    let excerpt: string | undefined;
    let siteName: string | undefined;
    let lang: string | undefined;
    let canonicalUrl: string | undefined;
    let readabilityApplied = false;
    let extracted = '';
    let llmsTxt = false;
    let pdf = false;

    if (isPdf) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
            throw new Error(`Response body too large (${bytes.byteLength} bytes); max is ${MAX_DOWNLOAD_BYTES}`);
        }
        extracted = (await extractPdfText(bytes)).trim();
        pdf = true;
    } else {
        const raw = await response.text();
        if (raw.length > MAX_DOWNLOAD_BYTES) {
            throw new Error(`Response body too large (${raw.length} chars); max is ${MAX_DOWNLOAD_BYTES}`);
        }

        const isHtml = contentType.includes('text/html') || /<!doctype html|<html[\s>]|<body[\s>]/i.test(raw.slice(0, 512));

        // Prefer a site's /llms.txt index for root fetches: it is purpose-built
        // for agents and far cheaper than crawling the page. https://llmstxt.org
        const preferLlms = options.preferLlmsTxt ?? (parsed.pathname === '/' || parsed.pathname === '');
        if (isHtml && preferLlms) {
            const llms = await tryLlmsTxt(parsed.origin);
            if (llms) {
                extracted = llms.content;
                title = llms.title || '';
                llmsTxt = true;
            }
        }

        if (!extracted) {
            if (isHtml) {
                const { document } = parseHTML(raw);
                title = (document.querySelector('title')?.textContent || '').trim();
                lang = document.querySelector('html')?.getAttribute('lang') || undefined;
                canonicalUrl = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || undefined;

                // Capture the container/body fallback BEFORE Readability runs: it
                // mutates the parsed document, so reading it afterwards can come back
                // empty when Readability declines to build an article.
                const fallbackHtml = pickMainHtml(document);

                let sourceHtml = '';
                if (options.readability !== false) {
                    try {
                        const article = new Readability(document as unknown as Document).parse();
                        if (article?.content) {
                            readabilityApplied = true;
                            sourceHtml = article.content;
                            title = (article.title || title).trim();
                            byline = article.byline?.trim() || undefined;
                            excerpt = article.excerpt?.trim() || undefined;
                            siteName = article.siteName?.trim() || undefined;
                        }
                    } catch {
                        // Fall through to the container/body extractor.
                    }
                }

                if (!sourceHtml) {
                    sourceHtml = fallbackHtml;
                }

                extracted = format === 'markdown'
                    ? htmlToMarkdown(sourceHtml, finalUrl)
                    : htmlToMarkdown(sourceHtml, finalUrl).replace(/[#*_>`]/g, '');
            } else {
                extracted = raw.trim();
            }
        }
    }

    const useJina = options.jinaFallback ?? config.jinaEnabled;
    if (useJina && !extracted.trim()) {
        const jina = await fetchViaJinaReader(parsed.toString(), {
            apiKey: config.jinaApiKey,
            baseUrl: config.jinaBaseUrl,
            timeoutMs: REQUEST_TIMEOUT_MS
        });
        extracted = jina.content;
        title = title || jina.title;
        return finalize({ url: parsed.toString(), finalUrl, contentType, title, retrievalMethod: 'jina-reader', extracted, options });
    }

    if (!extracted.trim()) {
        throw new Error('No readable content was extracted from this URL');
    }

    return finalize({
        url: parsed.toString(),
        finalUrl,
        contentType: contentType || 'unknown',
        title,
        retrievalMethod: llmsTxt ? 'llms-txt' : 'request',
        extracted,
        options,
        readabilityApplied,
        byline,
        excerpt,
        siteName,
        llmsTxt,
        pdf,
        lang,
        canonicalUrl
    });
}

function finalize(input: {
    url: string;
    finalUrl: string;
    contentType: string;
    title: string;
    retrievalMethod: 'request' | 'jina-reader' | 'llms-txt';
    extracted: string;
    options: FetchPageOptions;
    readabilityApplied?: boolean;
    byline?: string;
    excerpt?: string;
    siteName?: string;
    llmsTxt?: boolean;
    pdf?: boolean;
    lang?: string;
    canonicalUrl?: string;
}): FetchPageResult {
    const maxChars = clampMaxChars(input.options.maxChars);
    const totalChars = input.extracted.length;
    const startIndex = typeof input.options.startIndex === 'number' && input.options.startIndex > 0
        ? Math.min(input.options.startIndex, totalChars)
        : 0;
    const endIndex = Math.min(startIndex + maxChars, totalChars);
    const truncated = endIndex < totalChars;
    const chunk = input.extracted.slice(startIndex, endIndex);
    const content = truncated
        ? `${chunk}\n\n[...truncated ${totalChars - endIndex} characters; continue with startIndex=${endIndex}]`
        : chunk;

    return {
        url: input.url,
        finalUrl: input.finalUrl,
        contentType: input.contentType,
        title: input.title,
        retrievalMethod: input.retrievalMethod,
        truncated,
        content,
        ...(truncated ? { nextStartIndex: endIndex, totalChars } : {}),
        ...(input.readabilityApplied !== undefined ? { readabilityApplied: input.readabilityApplied } : {}),
        ...(input.byline ? { byline: input.byline } : {}),
        ...(input.excerpt ? { excerpt: input.excerpt } : {}),
        ...(input.siteName ? { siteName: input.siteName } : {}),
        ...(input.llmsTxt ? { llmsTxt: true } : {}),
        ...(input.pdf ? { pdf: true } : {}),
        ...(input.lang ? { lang: input.lang } : {}),
        ...(input.canonicalUrl ? { canonicalUrl: input.canonicalUrl } : {})
    };
}