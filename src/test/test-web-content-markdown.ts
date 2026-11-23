import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { fetchWebContent, __setJinaReaderForTests } from '../engines/web/fetchWebContent.js';
import { __setBrowserHtmlFetcherForTests } from '../engines/web/index.js';
import { __setAxiosRequestForTests } from '../utils/httpRequest.js';
import { __setDnsLookupForTests } from '../utils/urlSafety.js';

type TestCase = { name: string; run: () => Promise<void> };

function makeResponse(
    config: AxiosRequestConfig,
    response: { status?: number; headers?: Record<string, string>; data?: unknown; finalUrl?: string }
): AxiosResponse {
    return {
        status: response.status ?? 200,
        statusText: '',
        headers: response.headers ?? {},
        data: response.data ?? '',
        config,
        request: { res: { responseUrl: response.finalUrl ?? config.url } }
    } as AxiosResponse;
}

function installAxiosMock(): void {
    __setAxiosRequestForTests(async (config) => {
        const url = String(config.url || '');
        const method = String(config.method || 'GET').toUpperCase();

        if (method === 'HEAD') {
            return makeResponse(config, { headers: {}, finalUrl: url });
        }

        if (url.endsWith('/doc')) {
            return makeResponse(config, {
                headers: { 'content-type': 'text/html; charset=utf-8' },
                data: `
                    <html><head><title>Doc</title></head><body><article>
                      <h1>Heading</h1>
                      <p>Intro paragraph with a <a href="/guide">link</a>.</p>
                      <ul><li>First</li><li>Second</li></ul>
                    </article></body></html>`,
                finalUrl: url
            });
        }

        if (url.endsWith('/long.html')) {
            return makeResponse(config, {
                headers: { 'content-type': 'text/html; charset=utf-8' },
                data: `<html><head><title>Long</title></head><body><main><p>${'chunk '.repeat(1200)}</p></main></body></html>`,
                finalUrl: url
            });
        }

        if (url.endsWith('/blank')) {
            return makeResponse(config, {
                headers: { 'content-type': 'text/html; charset=utf-8' },
                data: '<html><head><title></title></head><body></body></html>',
                finalUrl: url
            });
        }

        throw new Error(`Unexpected mocked URL: ${url}`);
    });
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

async function main(): Promise<void> {
    installAxiosMock();
    __setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
    // Keep the browser fallback out of the way for every case here.
    __setBrowserHtmlFetcherForTests(async () => {
        throw new Error('browser fallback disabled in this test');
    });

    const cases: TestCase[] = [
        {
            name: 'converts HTML to Markdown with format=markdown',
            run: async () => {
                const result = await fetchWebContent('https://example.com/doc', 5000, { format: 'markdown' });
                assert(result.content.includes('# Heading'), 'heading should survive as an ATX heading');
                assert(result.content.includes('[link](https://example.com/guide)'), 'links should be inlined and resolved');
                assert(/^[ \t]*-[ \t]+First/m.test(result.content), 'list items should survive as markdown bullets');
                assert(!result.content.includes('<h1>'), 'raw tags should be gone');
            }
        },
        {
            name: 'returns chunk metadata for long pages (chunked reads)',
            run: async () => {
                const first = await fetchWebContent('https://example.com/long.html', 1000, { format: 'markdown' });
                assert(first.truncated === true, 'first chunk should report truncation');
                assert(typeof first.nextStartIndex === 'number' && first.nextStartIndex > 0, 'first chunk should offer a next index');
                assert(typeof first.totalChars === 'number', 'total length should be reported');

                const second = await fetchWebContent('https://example.com/long.html', 1000, {
                    format: 'markdown',
                    startIndex: first.nextStartIndex
                });
                assert(second.content.length > 0, 'second chunk should have content');
                assert(second.content !== first.content, 'second chunk should differ from the first');
            }
        },
        {
            name: 'falls back to Jina Reader when enabled and nothing extractable',
            run: async () => {
                __setJinaReaderForTests(async (url) => ({
                    url,
                    title: 'Jina Title',
                    content: '# Jina Heading\n\nRecovered by Jina Reader.'
                }));
                const result = await fetchWebContent('https://example.com/blank', 5000, {
                    format: 'markdown',
                    jinaFallback: true
                });
                assert(result.retrievalMethod === 'jina-reader', 'jina retrieval method should be reported');
                assert(result.content.includes('Recovered by Jina Reader.'), 'jina content should be used');
                assert(result.title === 'Jina Title', 'jina title should be used when the page had none');
            }
        }
    ];

    let passed = 0;
    for (const testCase of cases) {
        try {
            await testCase.run();
            passed += 1;
            console.log(`✅ ${testCase.name}`);
        } catch (error) {
            console.error(`❌ ${testCase.name}:`, error);
        }
    }

    __setAxiosRequestForTests();
    __setDnsLookupForTests();
    __setBrowserHtmlFetcherForTests();
    __setJinaReaderForTests();

    console.log(`\nResult: ${passed}/${cases.length} passed`);
    process.exit(passed === cases.length ? 0 : 1);
}

main().catch((error) => {
    console.error('❌ test-web-content-markdown failed:', error);
    process.exit(1);
});