import type { KvNamespace } from './env';

/**
 * KV-backed TTL cache. KV's minimum `expirationTtl` is 60 seconds, so shorter
 * TTLs are clamped up. When no binding is present every read misses and every
 * write is a no-op, so caching is simply off.
 */
export class KvTtlCache<T> {
    constructor(private readonly kv: KvNamespace | undefined) {}

    async get(key: string): Promise<T | undefined> {
        if (!this.kv) {
            return undefined;
        }
        try {
            const value = await this.kv.get(key, 'json');
            return (value as T | null) ?? undefined;
        } catch {
            return undefined;
        }
    }

    async set(key: string, value: T, ttlSeconds: number): Promise<void> {
        if (!this.kv || ttlSeconds <= 0) {
            return;
        }
        try {
            await this.kv.put(key, JSON.stringify(value), {
                expirationTtl: Math.max(60, Math.ceil(ttlSeconds))
            });
        } catch {
            // Caching is best-effort; a KV failure must not fail the request.
        }
    }
}

export function buildCacheKey(parts: Record<string, unknown>): string {
    return Object.keys(parts)
        .sort()
        .map((key) => `${key}=${JSON.stringify(parts[key])}`)
        .join('&');
}
