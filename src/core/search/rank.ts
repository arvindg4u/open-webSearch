import { SearchResult } from '../../types.js';

// Reciprocal Rank Fusion (RRF) is the standard, score-agnostic way to merge
// ranked lists from several search engines: each document's contribution is
// 1 / (k + rank), summed across the lists it appears in. k=60 is the value
// used across the information-retrieval literature (Cormack et al.) and by
// Pinecone/ParadeDB/OpenSearch/Redis in their RRF guides.
const DEFAULT_RRF_K = 60;

// Query parameters that never change which page a URL points at. Dropping them
// makes dedup agree on URLs that differ only by campaign/analytics noise.
const TRACKING_PARAM_PATTERNS = [
    /^utm_/i,
    /^(fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi|vero_id|wickedid)$/i,
    /^(ref|ref_src|referrer|source|spm|vd_source|scm)$/i
];

/**
 * Normalise a result URL for de-duplication: lowercase the host, drop the
 * fragment and tracking parameters, sort the remaining parameters, and remove
 * a trailing slash. Two URLs that resolve to the same page should collapse to
 * one key; anything we cannot parse is used verbatim (trimmed).
 */
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

export interface FuseResultsOptions {
    /** RRF smoothing constant. Lower values weight top ranks more heavily. */
    rrfK?: number;
    /** Optional per-engine weights; defaults to 1 for every engine. */
    weights?: Record<string, number>;
    /** Hard cap on the number of fused results returned. */
    limit?: number;
}

/**
 * Fuse several engines' ranked result lists into one ranked list using RRF,
 * de-duplicating by {@link normalizeResultUrl}. A single non-empty list is
 * returned untouched so single-engine queries keep their native ranking.
 *
 * For a document present in several lists, the representative result is the
 * occurrence with the best (lowest) rank, and every contributing engine is
 * recorded on `engines` (in first-seen order).
 */
export function fuseResults(lists: EngineResultList[], options: FuseResultsOptions = {}): SearchResult[] {
    const nonEmptyLists = lists.filter((list) => list.results.length > 0);
    if (nonEmptyLists.length === 0) {
        return [];
    }
    if (nonEmptyLists.length === 1) {
        const only = nonEmptyLists[0].results;
        return typeof options.limit === 'number' ? only.slice(0, options.limit) : only.slice();
    }

    const rrfK = options.rrfK && options.rrfK > 0 ? options.rrfK : DEFAULT_RRF_K;

    interface FusedEntry {
        result: SearchResult;
        score: number;
        bestRank: number;
        engines: string[];
    }

    const fused = new Map<string, FusedEntry>();

    for (const list of nonEmptyLists) {
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
                fused.set(key, {
                    result,
                    score: contribution,
                    bestRank: rank,
                    engines: [list.engine]
                });
                return;
            }

            existing.score += contribution;
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
        if (right.score !== left.score) {
            return right.score - left.score;
        }
        return left.bestRank - right.bestRank;
    });

    const merged = ranked.map((entry) => ({
        ...entry.result,
        engines: entry.engines.length > 1 ? [...entry.engines] : undefined
    }));

    return typeof options.limit === 'number' ? merged.slice(0, options.limit) : merged;
}
