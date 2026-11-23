/**
 * A minimal async TTL cache. The interface is intentionally async so the Node
 * runtime can back it with in-memory storage while an edge runtime (Cloudflare
 * Workers) can back the same surface with KV — callers never branch on the
 * implementation.
 */
export interface TtlCache<T> {
    get(key: string): Promise<T | undefined>;
    set(key: string, value: T, ttlMs: number): Promise<void>;
    delete(key: string): Promise<void>;
}

interface MemoryEntry<T> {
    value: T;
    expiresAt: number;
}

/**
 * Process-local TTL cache. Expired entries are treated as misses and swept
 * lazily, so a long-lived process does not grow without bound as keys churn.
 */
export class MemoryTtlCache<T> implements TtlCache<T> {
    private readonly entries = new Map<string, MemoryEntry<T>>();
    private readonly maxEntries: number;

    constructor(maxEntries = 500) {
        this.maxEntries = Math.max(1, maxEntries);
    }

    async get(key: string): Promise<T | undefined> {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }
        if (entry.expiresAt <= Date.now()) {
            this.entries.delete(key);
            return undefined;
        }
        // Refresh recency so the eviction below drops the coldest key.
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    async set(key: string, value: T, ttlMs: number): Promise<void> {
        if (ttlMs <= 0) {
            return;
        }
        this.entries.delete(key);
        this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.entries.delete(oldest);
        }
    }

    async delete(key: string): Promise<void> {
        this.entries.delete(key);
    }
}

/**
 * Stable cache key from labelled parts. Object values are serialised with
 * sorted keys so logically-equal inputs always hash to the same key.
 */
export function buildCacheKey(parts: Record<string, unknown>): string {
    const normalized = Object.keys(parts)
        .sort()
        .map((key) => `${key}=${stableStringify(parts[key])}`)
        .join('&');
    return normalized;
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? String(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const inner = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
        .join(',');
    return `{${inner}}`;
}
