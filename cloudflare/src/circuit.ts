import type { KvNamespace } from './env';

interface CircuitState {
    failures: number;
    openUntil: number;
}

/**
 * Per-engine circuit breaker backed by KV. After `threshold` consecutive
 * failures an engine is skipped for `cooldownSeconds`, which stops a single
 * rate-limited upstream (GitHub 10/min, Stack Exchange 300/day, ...) from
 * slowing every request. State is best-effort: KV is eventually consistent.
 */
export class CircuitBreaker {
    constructor(
        private readonly kv: KvNamespace | undefined,
        private readonly threshold = 3,
        private readonly cooldownSeconds = 60
    ) {}

    private key(engine: string): string {
        return `circuit:${engine}`;
    }

    async isOpen(engine: string): Promise<boolean> {
        if (!this.kv) {
            return false;
        }
        try {
            const state = (await this.kv.get(this.key(engine), 'json')) as CircuitState | null;
            return Boolean(state && state.openUntil > Date.now());
        } catch {
            return false;
        }
    }

    async recordSuccess(engine: string): Promise<void> {
        if (!this.kv) {
            return;
        }
        try {
            await this.kv.put(
                this.key(engine),
                JSON.stringify({ failures: 0, openUntil: 0 } satisfies CircuitState),
                { expirationTtl: 3600 }
            );
        } catch {
            // Best-effort only.
        }
    }

    async recordFailure(engine: string): Promise<void> {
        if (!this.kv) {
            return;
        }
        try {
            const previous = (await this.kv.get(this.key(engine), 'json')) as CircuitState | null;
            const failures = (previous?.failures ?? 0) + 1;
            const openUntil = failures >= this.threshold
                ? Date.now() + this.cooldownSeconds * 1000
                : 0;
            await this.kv.put(
                this.key(engine),
                JSON.stringify({ failures, openUntil } satisfies CircuitState),
                { expirationTtl: Math.max(60, this.cooldownSeconds) }
            );
        } catch {
            // Best-effort only.
        }
    }
}