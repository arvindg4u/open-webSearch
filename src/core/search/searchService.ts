import { SearchResult } from '../../types.js';
import { AppConfig } from '../../config.js';
import { distributeLimit } from './searchEngines.js';
import { fuseResults } from './rank.js';
import { buildCacheKey, TtlCache } from './cache.js';

export type SearchExecutionContext = {
    searchMode?: AppConfig['searchMode'];
};

export type SearchEngineExecutor = (query: string, limit: number, context?: SearchExecutionContext) => Promise<SearchResult[]>;
export type SearchEngineExecutorMap = Partial<Record<string, SearchEngineExecutor>>;

export type SearchExecutionFailure = {
    engine: string;
    code: 'engine_error' | 'unsupported_engine';
    message: string;
};

export type EngineStat = {
    engine: string;
    ok: boolean;
    resultCount: number;
    durationMs: number;
    error?: string;
};

export type SearchExecutionResult = {
    query: string;
    engines: string[];
    totalResults: number;
    results: SearchResult[];
    partialFailures: SearchExecutionFailure[];
    engineStats: EngineStat[];
    cached?: boolean;
};

export type SearchExecutionInput = {
    query: string;
    engines: string[];
    limit: number;
    searchMode?: AppConfig['searchMode'];
};

export type SearchServiceOptions = {
    /** Optional result cache keyed by query + engines + limit + mode. */
    cache?: TtlCache<SearchExecutionResult>;
    cacheTtlMs?: number;
};

function resolveSearchModeOverride(searchMode: AppConfig['searchMode'] | undefined): AppConfig['searchMode'] | undefined {
    // Agent 显式传 searchMode=auto 时,应与不传参数一致,优先使用环境变量值。不能优先使用HTTP请求,因为它会导致Bing返回垃圾结果。
    return searchMode === 'auto' ? undefined : searchMode;
}

export function createSearchService(engineMap: SearchEngineExecutorMap, options: SearchServiceOptions = {}) {
    return {
        async execute({ query, engines, limit, searchMode }: SearchExecutionInput): Promise<SearchExecutionResult> {
            const cleanQuery = query.trim();
            if (!cleanQuery) {
                throw new Error('Query string cannot be empty');
            }

            const effectiveSearchMode = resolveSearchModeOverride(searchMode);
            const cache = options.cache;
            const cacheTtlMs = options.cacheTtlMs ?? 0;
            const cacheKey = cache && cacheTtlMs > 0
                ? buildCacheKey({
                    q: cleanQuery,
                    engines: engines.join(','),
                    limit,
                    mode: effectiveSearchMode ?? ''
                })
                : undefined;

            if (cache && cacheKey) {
                const cached = await cache.get(cacheKey);
                if (cached) {
                    return { ...cached, cached: true };
                }
            }

            const limits = distributeLimit(limit, engines.length);
            const partialFailures: SearchExecutionFailure[] = [];

            const tasks = engines.map(async (engine, index): Promise<{ engine: string; ok: boolean; results: SearchResult[]; error?: string; durationMs: number }> => {
                const executor = engineMap[engine];
                const engineLimit = limits[index];
                const startedAt = Date.now();

                if (!executor) {
                    const message = `Unsupported search engine: ${engine}`;
                    partialFailures.push({ engine, code: 'unsupported_engine', message });
                    return { engine, ok: false, results: [], error: message, durationMs: 0 };
                }

                try {
                    const results = await executor(cleanQuery, engineLimit, { searchMode: effectiveSearchMode });
                    return { engine, ok: true, results, durationMs: Date.now() - startedAt };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    partialFailures.push({ engine, code: 'engine_error', message });
                    return { engine, ok: false, results: [], error: message, durationMs: Date.now() - startedAt };
                }
            });

            const outcomes = await Promise.all(tasks);

            // RRF-fuse the per-engine ranked lists into one ranking. A single
            // successful engine keeps its native order (see fuseResults).
            const successfulLists = outcomes
                .filter((outcome) => outcome.ok)
                .map((outcome) => ({ engine: outcome.engine, results: outcome.results }));
            const results = fuseResults(successfulLists, { limit });

            const engineStats: EngineStat[] = outcomes.map((outcome) => ({
                engine: outcome.engine,
                ok: outcome.ok,
                resultCount: outcome.results.length,
                durationMs: outcome.durationMs,
                ...(outcome.error ? { error: outcome.error } : {})
            }));

            const executionResult: SearchExecutionResult = {
                query: cleanQuery,
                engines,
                totalResults: results.length,
                results,
                partialFailures,
                engineStats
            };

            if (cache && cacheKey) {
                await cache.set(cacheKey, executionResult, cacheTtlMs);
            }

            return executionResult;
        }
    };
}
