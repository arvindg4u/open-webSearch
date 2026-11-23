import { SearchResult } from '../types.js';
import { fuseResults, normalizeResultUrl } from '../core/search/rank.js';
import { MemoryTtlCache, buildCacheKey } from '../core/search/cache.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
    }
}

function makeResult(engine: string, url: string, title = url): SearchResult {
    return { title, url, description: '', source: engine, engine };
}

function testNormalizeResultUrl(): void {
    assertEqual(
        normalizeResultUrl('HTTPS://Example.com/Path/?utm_source=x&b=2&a=1#frag'),
        'https://example.com/Path?a=1&b=2',
        'lowercases host, drops tracking + fragment, sorts params, trims slash'
    );
    assertEqual(
        normalizeResultUrl('https://example.com/a/'),
        'https://example.com/a',
        'trims a trailing slash'
    );
    assertEqual(normalizeResultUrl('not a url'), 'not a url', 'leaves unparseable input intact');
    console.log('✅ normalizeResultUrl');
}

function testSingleEnginePreservesOrder(): void {
    const list = [
        makeResult('duckduckgo', 'https://a.example/1'),
        makeResult('duckduckgo', 'https://a.example/2')
    ];
    const fused = fuseResults([{ engine: 'duckduckgo', results: list }]);
    assert(fused.length === 2, 'single engine keeps both results');
    assertEqual(fused[0].url, 'https://a.example/1', 'single engine keeps native order');
    assertEqual(fused[1].url, 'https://a.example/2', 'single engine keeps native order (second)');
    console.log('✅ single-engine order preserved');
}

function testRrfMergesAndDeduplicates(): void {
    const engineA = [
        makeResult('duckduckgo', 'https://shared.example/page'),
        makeResult('duckduckgo', 'https://only-a.example/')
    ];
    // Same page as engine A's top hit, but with a tracking param + trailing slash.
    const engineB = [
        makeResult('searxng', 'https://shared.example/page/?utm_source=newsletter'),
        makeResult('searxng', 'https://only-b.example/')
    ];

    const fused = fuseResults([
        { engine: 'duckduckgo', results: engineA },
        { engine: 'searxng', results: engineB }
    ]);

    assertEqual(fused.length, 3, 'overlapping URL collapses to one result');
    assertEqual(fused[0].url, 'https://shared.example/page', 'agreement across engines ranks first');
    assertEqual(fused[0].engines?.join(','), 'duckduckgo,searxng', 'both engines recorded on the fused hit');
    assert(!fused[1].engines, 'single-engine hits carry no engines array');
    console.log('✅ RRF merges and de-duplicates');
}

function testRrfLimit(): void {
    const fused = fuseResults(
        [{ engine: 'a', results: [makeResult('a', 'https://x/1'), makeResult('a', 'https://x/2')] }],
        { limit: 1 }
    );
    assertEqual(fused.length, 1, 'limit caps fused output');
    console.log('✅ RRF limit');
}

async function testTtlCache(): Promise<void> {
    const cache = new MemoryTtlCache<string>(2);
    await cache.set('a', 'one', 1000);
    assertEqual(await cache.get('a'), 'one', 'cache returns a live entry');
    await cache.set('b', 'two', 1000);
    await cache.set('c', 'three', 1000);
    assertEqual(await cache.get('a'), undefined, 'least-recently-used key is evicted at capacity');
    await cache.set('expired', 'gone', 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEqual(await cache.get('expired'), undefined, 'expired entry is a miss');
    console.log('✅ TTL cache');
}

function testCacheKeyStability(): void {
    const left = buildCacheKey({ q: 'x', engines: 'a,b', limit: 5 });
    const right = buildCacheKey({ limit: 5, engines: 'a,b', q: 'x' });
    assertEqual(left, right, 'cache key ignores object insertion order');
    console.log('✅ cache key stability');
}

async function main(): Promise<void> {
    testNormalizeResultUrl();
    testSingleEnginePreservesOrder();
    testRrfMergesAndDeduplicates();
    testRrfLimit();
    await testTtlCache();
    testCacheKeyStability();
    console.log('\nRank fusion tests passed.');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });