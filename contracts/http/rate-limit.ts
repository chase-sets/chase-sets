export type RateLimitDecision = Readonly<{
  limited: boolean;
  key: string;
  count: number;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}>;

export type InMemoryRateLimiter = ReturnType<typeof createInMemoryRateLimiter>;

export type InMemoryRateLimiterOptions = Readonly<{
  windowMs: number;
  max: number;
  keyPrefix?: string;
  maxBuckets?: number;
  now?: () => number;
}>;

type Bucket = {
  count: number;
  resetAt: number;
};

export function publicClientRequestKey(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "local"
  );
}

export function createInMemoryRateLimiter(options: InMemoryRateLimiterOptions) {
  const buckets = new Map<string, Bucket>();
  const now = options.now ?? Date.now;
  const keyPrefix = options.keyPrefix?.trim() ?? "";
  const maxBuckets = Math.max(options.maxBuckets ?? 10_000, 1);

  function normalizedKey(requestOrKey: Request | string) {
    const key = typeof requestOrKey === "string" ? requestOrKey.trim() : publicClientRequestKey(requestOrKey);
    return `${keyPrefix}${keyPrefix ? ":" : ""}${key || "local"}`;
  }

  return {
    check(requestOrKey: Request | string): RateLimitDecision {
      const checkedAt = now();
      const key = normalizedKey(requestOrKey);
      const current = buckets.get(key);
      if (!current && buckets.size >= maxBuckets) {
        for (const [bucketKey, bucket] of buckets) {
          if (bucket.resetAt <= checkedAt || buckets.size >= maxBuckets) {
            buckets.delete(bucketKey);
          }
          if (buckets.size < maxBuckets) {
            break;
          }
        }
      }
      const bucket =
        !current || current.resetAt <= checkedAt ? { count: 0, resetAt: checkedAt + options.windowMs } : current;

      bucket.count += 1;
      buckets.set(key, bucket);

      const limited = bucket.count > options.max;
      return {
        limited,
        key,
        count: bucket.count,
        limit: options.max,
        remaining: Math.max(options.max - bucket.count, 0),
        resetAt: bucket.resetAt,
        retryAfterSeconds: Math.max(Math.ceil((bucket.resetAt - checkedAt) / 1000), 1),
      };
    },
    clear() {
      buckets.clear();
    },
  };
}
