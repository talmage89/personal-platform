/**
 * In-memory token bucket, keyed by client address.
 *
 * Defence in depth, not the primary protection. The endpoints this guards do
 * zero database work by design, so a flood costs CPU and nothing else — the
 * limiter exists to keep logs and sockets sane, not to protect the Neon bill.
 * That distinction matters: it means a spoofed X-Forwarded-For is an annoyance
 * rather than a vulnerability.
 *
 * Single instance, so a Map is the correct storage. If this ever runs more than
 * one replica the limit becomes per-replica, which is fine for the same reason.
 */

export interface RateLimiterOptions {
  /** Burst capacity, and the number of tokens refilled per window. */
  limit: number;
  windowSeconds: number;
  /** Buckets are swept once the map grows past this. Bounds memory. */
  maxKeys?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimiter {
  /** Consumes a token. Returns false when the caller should be rejected. */
  take(key: string, now?: number): boolean;
  /** Seconds until at least one token is available. */
  retryAfter(key: string, now?: number): number;
  readonly size: number;
}

export function createRateLimiter({
  limit,
  windowSeconds,
  maxKeys = 10_000,
}: RateLimiterOptions): RateLimiter {
  const buckets = new Map<string, Bucket>();
  const windowMs = windowSeconds * 1000;
  const refillPerMs = limit / windowMs;

  const current = (key: string, now: number): Bucket => {
    const existing = buckets.get(key);
    if (!existing) return { tokens: limit, updatedAt: now };

    const refilled = existing.tokens + (now - existing.updatedAt) * refillPerMs;
    return { tokens: Math.min(limit, refilled), updatedAt: now };
  };

  const sweep = (now: number): void => {
    for (const [key, bucket] of buckets) {
      // Fully refilled buckets are indistinguishable from absent ones.
      if (now - bucket.updatedAt >= windowMs) buckets.delete(key);
    }
    // Pathological case: everything is still active. Drop the oldest half rather
    // than grow without bound — over-limiting beats running out of memory.
    if (buckets.size > maxKeys) {
      const oldest = [...buckets.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
        .slice(0, Math.floor(buckets.size / 2));
      for (const [key] of oldest) buckets.delete(key);
    }
  };

  return {
    take(key, now = Date.now()) {
      if (buckets.size >= maxKeys) sweep(now);

      const bucket = current(key, now);
      if (bucket.tokens < 1) {
        buckets.set(key, bucket);
        return false;
      }

      buckets.set(key, { tokens: bucket.tokens - 1, updatedAt: now });
      return true;
    },

    retryAfter(key, now = Date.now()) {
      const bucket = current(key, now);
      if (bucket.tokens >= 1) return 0;
      return Math.ceil((1 - bucket.tokens) / refillPerMs / 1000);
    },

    get size() {
      return buckets.size;
    },
  };
}
