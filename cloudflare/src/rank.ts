import type { SearchResult } from './env';

/**
 * Reciprocal Rank Fusion across engines, de-duplicated by normalised URL.
 * `fuseRanked` keeps the fused score so a later reranking pass can blend it
 * with lexical relevance, source authority, and freshness.
 */
const DEFAULT_RRF_K = 60;

const TRACKING_PARAM_PATTERNS = [
    /^utm_/i,
    /^(fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi|vero_id|wickedid)$/i,
    /^(ref|ref_src|referrer|source|spm|vd_source|scm)$/i
];

export function normalizeResultUrl(url: string): string {
    const trimmed = url.trim();
    if (!trimmed) {
        return trimmed;
    }
    try {
        const parsed = new URL(trimmed);
        parsed.hash = '';
        parsed.hostname = parsed.hostname.toLowerCase();
        const kept = [...parsed.searchParams.entries()].filter(
            ([key]) => !TRACKING_PARAM_PATTERNS.some((pattern) => pattern.test(key))
        );
        kept.sort(([left], [right]) => left.localeCompare(right));
        parsed.search = '';
        for (const [key, value] of kept) {
            parsed.searchParams.append(key, value);
        }
        if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
            parsed.pathname = parsed.pathname.slice(0, -1);
        }
        return parsed.toString();
    } catch {
        return trimmed;
    }
}

export interface EngineResultList {
    engine: string;
    results: SearchResult[];
}

export interface FusedResult extends SearchResult {
    rrfScore: number;
    engines: string[];
}

export interface FuseRankedOptions {
    rrfK?: number;
    weights?: Record<string, number>;
    limit?: number;
}

export function fuseRanked(lists: EngineResultList[], options: FuseRankedOptions = {}): FusedResult[] {
    const nonEmpty = lists.filter((list) => list.results.length > 0);
    if (nonEmpty.length === 0) {
        return [];
    }

    const rrfK = options.rrfK && options.rrfK > 0 ? options.rrfK : DEFAULT_RRF_K;

    interface Entry {
        result: SearchResult;
        rrfScore: number;
        bestRank: number;
        engines: string[];
    }

    const fused = new Map<string, Entry>();

    for (const list of nonEmpty) {
        const weight = options.weights?.[list.engine] ?? 1;
        if (weight <= 0) {
            continue;
        }
        list.results.forEach((result, index) => {
            const rank = index + 1;
            const key = normalizeResultUrl(result.url) || `${list.engine}:${index}:${result.title}`;
            const contribution = weight / (rrfK + rank);
            const existing = fused.get(key);
            if (!existing) {
                fused.set(key, { result, rrfScore: contribution, bestRank: rank, engines: [list.engine] });
                return;
            }
            existing.rrfScore += contribution;
            if (!existing.engines.includes(list.engine)) {
                existing.engines.push(list.engine);
            }
            if (rank < existing.bestRank) {
                existing.bestRank = rank;
                existing.result = result;
            }
        });
    }

    const ranked = [...fused.values()].sort((left, right) => {
        if (right.rrfScore !== left.rrfScore) {
            return right.rrfScore - left.rrfScore;
        }
        return left.bestRank - right.bestRank;
    });

    const merged: FusedResult[] = ranked.map((entry) => ({
        ...entry.result,
        engines: entry.engines,
        rrfScore: entry.rrfScore
    }));

    return typeof options.limit === 'number' ? merged.slice(0, options.limit) : merged;
}

/** Backwards-friendly wrapper that drops only the fusion score. */
export function fuseResults(lists: EngineResultList[], options: FuseRankedOptions = {}): SearchResult[] {
    return fuseRanked(lists, options).map(({ rrfScore: _rrfScore, ...result }) => result);
}
