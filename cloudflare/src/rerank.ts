import type { SearchResult } from './env';
import type { FusedResult } from './rank';

/**
 * Second-stage ranking. RRF only knows positions, so it cannot tell an official
 * docs page from a content farm that happened to rank well. This layer blends
 * the fused rank with lexical query coverage, source authority, and freshness,
 * then diversifies by registrable domain so one site cannot occupy the page.
 */
export interface RankedResult extends FusedResult {
    score: number;
    relevance: number;
    coverage: number;
    authority: number;
    freshness: number;
}

const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it',
    'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which',
    'who', 'why', 'will', 'with', 'vs', 'versus'
]);

const TWO_LEVEL_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'co.jp', 'com.br', 'co.in',
    'com.cn', 'edu.au', 'org.au'
]);

function tokenize(input: string): string[] {
    // Unicode-aware: \p{L}/\p{N} match any script (e.g. Devanagari), not just
    // ASCII, so non-Latin queries get real lexical relevance instead of 0.
    return input.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]*/gu) ?? [];
}

function hostOf(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

export function registrableDomain(host: string): string {
    const parts = host.split('.').filter(Boolean);
    if (parts.length <= 2) {
        return parts.join('.');
    }
    const lastTwo = parts.slice(-2).join('.');
    if (TWO_LEVEL_SUFFIXES.has(lastTwo)) {
        return parts.slice(-3).join('.');
    }
    return lastTwo;
}

/** Curated authority prior in [0, 1]. Deliberately small and explainable. */
export function authorityFor(url: string): number {
    const host = hostOf(url);
    if (!host) {
        return 0.5;
    }
    if (host.endsWith('.gov') || host.endsWith('.edu')) return 0.92;
    if (host.endsWith('stackoverflow.com') || host.endsWith('stackexchange.com')) return 0.95;
    if (host === 'github.com' || host.endsWith('.github.com')) return 0.9;
    if (
        host === 'developer.mozilla.org'
        || host === 'docs.python.org'
        || host === 'docs.cloudflare.com'
        || host === 'developers.cloudflare.com'
        || host.startsWith('docs.')
        || host.startsWith('developer.')
    ) {
        return 0.92;
    }
    if (host.endsWith('wikipedia.org') || host.endsWith('wikimedia.org')) return 0.82;
    if (host.endsWith('arxiv.org') || host.endsWith('acm.org') || host.endsWith('ieee.org')) return 0.86;
    if (host.endsWith('blog.cloudflare.com')) return 0.9;
    // Video / login-walled social hosts: often unfetchable server-side, so rank
    // them below readable articles even when their snippets match well.
    if (host.endsWith('youtube.com') || host.endsWith('youtu.be')) return 0.35;
    if (/(?:^|\.)(facebook|instagram|tiktok|x|twitter|pinterest)\.com$/.test(host)) return 0.3;
    if (host.endsWith('reddit.com') || host.endsWith('quora.com')) return 0.4;
    if (host.endsWith('medium.com') || host.endsWith('substack.com') || host.endsWith('dev.to')) return 0.4;
    return 0.55;
}

function queryTerms(query: string): string[] {
    return [...new Set(tokenize(query).filter((token) => token.length > 1 && !STOPWORDS.has(token)))];
}

/** Fraction of distinct query terms that appear anywhere in the result. */
export function lexicalCoverage(query: string, result: SearchResult): number {
    const terms = queryTerms(query);
    if (terms.length === 0) {
        return 0;
    }
    const haystack = new Set(tokenize(`${result.title} ${result.description} ${result.source}`));
    const matched = terms.filter((term) => haystack.has(term)).length;
    return matched / terms.length;
}

/** Fraction of query terms covered by the title (weight 3) or snippet (weight 1). */
export function lexicalRelevance(query: string, result: SearchResult): number {
    const terms = queryTerms(query);
    if (terms.length === 0) {
        return 0;
    }

    const title = new Set(tokenize(result.title));
    const body = new Set(tokenize(`${result.description} ${result.source}`));

    let matched = 0;
    for (const term of terms) {
        if (title.has(term)) {
            matched += 3;
        } else if (body.has(term)) {
            matched += 1;
        }
    }

    const normalized = matched / (terms.length * 3);
    const phrase = result.title.toLowerCase().includes(query.trim().toLowerCase()) ? 0.5 : 0;
    return Math.min(1, normalized + phrase);
}

export function freshnessScore(publishedAt: string | undefined): number {
    if (!publishedAt) {
        return 0;
    }
    const timestamp = Date.parse(publishedAt);
    if (!Number.isFinite(timestamp)) {
        return 0;
    }
    const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
    return Math.exp(-ageDays / 180);
}

export function rerank(query: string, fused: FusedResult[]): RankedResult[] {
    if (fused.length === 0) {
        return [];
    }
    const maxRrf = Math.max(...fused.map((entry) => entry.rrfScore)) || 1;

    return fused.map((entry) => {
        const relevance = lexicalRelevance(query, entry);
        const coverage = lexicalCoverage(query, entry);
        const authority = authorityFor(entry.url);
        const freshness = freshnessScore(entry.publishedAt);
        const rrf = entry.rrfScore / maxRrf;
        const score = 0.55 * rrf + 0.30 * relevance + 0.10 * authority + 0.05 * freshness;
        return { ...entry, score, relevance, coverage, authority, freshness };
    });
}

/**
 * Greedy selection that caps how many results one registrable domain may take.
 * Deferred duplicates are appended only if the cap would otherwise leave the
 * result list short.
 */
export function diversify(ranked: RankedResult[], limit: number, maxPerDomain = 2): RankedResult[] {
    const sorted = [...ranked].sort((left, right) => right.score - left.score);
    const perDomain = new Map<string, number>();
    const selected: RankedResult[] = [];
    const deferred: RankedResult[] = [];

    for (const result of sorted) {
        const domain = registrableDomain(hostOf(result.url));
        const count = perDomain.get(domain) ?? 0;
        if (count >= maxPerDomain) {
            deferred.push(result);
            continue;
        }
        perDomain.set(domain, count + 1);
        selected.push(result);
        if (selected.length >= limit) {
            return selected;
        }
    }

    for (const result of deferred) {
        if (selected.length >= limit) {
            break;
        }
        selected.push(result);
    }

    return selected;
}

export function rankAndDiversify(
    query: string,
    fused: FusedResult[],
    limit: number,
    maxPerDomain = 2
): RankedResult[] {
    const ranked = rerank(query, fused);
    // Drop results matching none of the query terms when better ones exist; this
    // removes keyword-less junk (e.g. a portal homepage) from the output.
    const relevant = ranked.filter((result) => result.coverage > 0);
    const pool = relevant.length > 0 ? relevant : ranked;
    return diversify(pool, limit, maxPerDomain);
}