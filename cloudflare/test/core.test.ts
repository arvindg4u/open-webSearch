import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResultUrl, fuseRanked } from '../src/rank.ts';
import { authorityFor, lexicalCoverage, rankAndDiversify, registrableDomain } from '../src/rerank.ts';
import { detectTopic, enginesForTopic } from '../src/intent.ts';
import { decodeHtmlEntities, stripHtml } from '../src/http.ts';
import type { SearchResult } from '../src/env.ts';

function hit(engine: string, url: string, title = url, description = ''): SearchResult {
    return { title, url, description, source: engine, engine };
}

test('normalizeResultUrl strips tracking, fragment and trailing slash', () => {
    assert.equal(
        normalizeResultUrl('HTTPS://Example.com/Path/?utm_source=x&b=2&a=1#frag'),
        'https://example.com/Path?a=1&b=2'
    );
});

test('fuseRanked merges the same URL across engines and records both', () => {
    const fused = fuseRanked([
        { engine: 'bing', results: [hit('bing', 'https://shared.example/p', 'Shared')] },
        { engine: 'stackexchange', results: [hit('stackexchange', 'https://shared.example/p/?utm_source=x', 'Shared')] }
    ]);
    assert.equal(fused.length, 1);
    assert.deepEqual(fused[0].engines.sort(), ['bing', 'stackexchange']);
    assert.ok(fused[0].rrfScore > 0);
});

test('authority prefers Q&A/docs over content farms', () => {
    assert.ok(authorityFor('https://stackoverflow.com/questions/1') > authorityFor('https://medium.com/post'));
    assert.ok(authorityFor('https://docs.python.org/3/') > authorityFor('https://example.com/'));
});

test('lexicalCoverage distinguishes a real hit from an incidental term', () => {
    const query = 'set cors cloudflare workers';
    const good = hit('stackexchange', 'https://stackoverflow.com/q/1', 'How to set CORS headers in Cloudflare Workers');
    const junk = hit('bing', 'https://set-test.org/', 'SET exam results 2026');
    assert.ok(lexicalCoverage(query, good) >= 0.75);
    assert.ok(lexicalCoverage(query, junk) <= 0.3);
});

test('detectTopic routes code, academic and news queries', () => {
    assert.equal(detectTopic('how to set CORS headers in cloudflare workers'), 'code');
    assert.equal(detectTopic('arxiv preprint on transformer scaling'), 'academic');
    assert.equal(detectTopic('cloudflare outage announcement today'), 'news');
    assert.equal(detectTopic('history of the roman empire'), 'general');
});

test('enginesForTopic keeps only enabled engines', () => {
    assert.deepEqual(
        enginesForTopic('code', ['github', 'stackexchange', 'bing', 'wikipedia']),
        ['github', 'stackexchange', 'bing']
    );
});

test('rankAndDiversify promotes relevant results and caps per domain', () => {
    const query = 'set cors cloudflare workers';
    const fused = fuseRanked([
        {
            engine: 'bing',
            results: [
                hit('bing', 'https://junk.example/a', 'SET exam results'),
                hit('bing', 'https://junk.example/b', 'SET exam results 2'),
                hit('bing', 'https://junk.example/c', 'SET exam results 3')
            ]
        },
        {
            engine: 'stackexchange',
            results: [
                hit('stackexchange', 'https://stackoverflow.com/q/1', 'How to set CORS headers in Cloudflare Workers')
            ]
        }
    ]);
    const ranked = rankAndDiversify(query, fused, 3, 2);
    assert.equal(ranked[0].url, 'https://stackoverflow.com/q/1');
    const junkCount = ranked.filter((result) => result.url.startsWith('https://junk.example')).length;
    assert.ok(junkCount <= 2, 'at most two results from one domain');
});

test('registrableDomain folds subdomains to the registrable domain', () => {
    assert.equal(registrableDomain('docs.python.org'), 'python.org');
    assert.equal(registrableDomain('en.wikipedia.org'), 'wikipedia.org');
    assert.equal(registrableDomain('example.co.uk'), 'example.co.uk');
});

test('stripHtml and decodeHtmlEntities clean search snippets', () => {
    assert.equal(stripHtml('<b>Hello</b>&nbsp;&amp; <i>bye</i>'), 'Hello & bye');
    assert.equal(decodeHtmlEntities('a &#39;b&#39; &quot;c&quot;'), 'a \'b\' "c"');
});

test('tokenizer is Unicode-aware (Devanagari relevance)', () => {
    const query = 'राजस्थान प्रजामंडल स्थापना';
    const relevant = hit('searxng', 'https://example.org/a', 'राजस्थान प्रजामंडल की स्थापना', '');
    const unrelated = hit('bing', 'https://www.microsoft.com/', 'Microsoft Official Home Page', '');
    assert.ok(lexicalCoverage(query, relevant) >= 0.9, 'Devanagari terms should match Hindi titles');
    assert.equal(lexicalCoverage(query, unrelated), 0, 'unrelated hit should score zero');
});

test('rankAndDiversify drops zero-coverage junk when a relevant hit exists', () => {
    const query = 'राजस्थान वन नीति';
    const fused = fuseRanked([
        { engine: 'bing', results: [hit('bing', 'https://www.microsoft.com/', 'Microsoft Official Home Page', '')] },
        { engine: 'searxng', results: [hit('searxng', 'https://example.org/forest', 'राजस्थान वन नीति 2023', '')] }
    ]);
    const ranked = rankAndDiversify(query, fused, 5);
    assert.ok(ranked.every((result) => result.url !== 'https://www.microsoft.com/'), 'keyword-less junk is dropped');
    assert.equal(ranked[0].url, 'https://example.org/forest');
});