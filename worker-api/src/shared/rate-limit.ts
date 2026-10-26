/**
 * Small fixed-window rate limiter for PUBLIC routes (the storefront). The counter store is an
 * interface, so it is injectable in tests and can later be backed by a Durable Object / KV / the
 * Cloudflare Rate Limiting binding without touching the callers.
 *
 * IMPORTANT: the default in-memory store is per Worker isolate. Cloudflare runs many isolates and
 * recycles them, so this is a best-effort safety net that bounds abuse from one client against one
 * isolate — it is NOT a global limit. Production should additionally use Cloudflare rate-limiting
 * rules at the edge (see README).
 */

export interface RateLimitHit {
  /** Requests counted in the current window, including this one. */
  count: number;
  /** Epoch ms at which the current window ends. */
  resetAtMs: number;
}

export interface RateLimitStore {
  /** Count one request against `key` in a fixed window of `windowMs`. */
  increment(key: string, windowMs: number, nowMs: number): Promise<RateLimitHit> | RateLimitHit;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Whole seconds until the window resets (>= 1). */
  retryAfterSeconds: number;
}

/** Fixed-window counters held in memory with a hard cap on tracked keys. */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, RateLimitHit>();

  constructor(private readonly maxKeys = 10_000) {}

  increment(key: string, windowMs: number, nowMs: number): RateLimitHit {
    const current = this.windows.get(key);
    if (current && current.resetAtMs > nowMs) {
      current.count += 1;
      return current;
    }
    if (this.windows.size >= this.maxKeys) this.evict(nowMs);
    const fresh: RateLimitHit = { count: 1, resetAtMs: nowMs + windowMs };
    this.windows.set(key, fresh);
    return fresh;
  }

  /** Drop expired windows; if still full, drop the oldest entries so memory stays bounded. */
  private evict(nowMs: number): void {
    for (const [key, hit] of this.windows) {
      if (hit.resetAtMs <= nowMs) this.windows.delete(key);
    }
    if (this.windows.size < this.maxKeys) return;
    const drop = Math.ceil(this.maxKeys / 10);
    let removed = 0;
    for (const key of this.windows.keys()) {
      this.windows.delete(key);
      if (++removed >= drop) break;
    }
  }

  get size(): number {
    return this.windows.size;
  }
}

export class RateLimiter {
  constructor(
    private readonly store: RateLimitStore = new InMemoryRateLimitStore(),
    private readonly now: () => number = Date.now,
  ) {}

  async check(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision> {
    const nowMs = this.now();
    const hit = await this.store.increment(key, windowSeconds * 1000, nowMs);
    const retryAfterSeconds = Math.max(1, Math.ceil((hit.resetAtMs - nowMs) / 1000));
    return {
      allowed: hit.count <= limit,
      limit,
      remaining: Math.max(0, limit - hit.count),
      retryAfterSeconds,
    };
  }
}
