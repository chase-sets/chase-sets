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
  disabled?: boolean;
  keyPrefix?: string;
  maxBuckets?: number;
  now?: () => number;
}>;

export type RateLimitRule = Readonly<{
  windowMs: number;
  max: number;
  disabled?: boolean;
}>;

type RateLimitEnv = Readonly<Record<string, string | undefined>>;

type Bucket = {
  count: number;
  resetAt: number;
};

const rateLimitExceededCounters = new Map<string, number>();

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

  function unlimitedDecision(requestOrKey: Request | string, checkedAt: number): RateLimitDecision {
    return {
      limited: false,
      key: normalizedKey(requestOrKey),
      count: 0,
      limit: options.max,
      remaining: options.max,
      resetAt: checkedAt,
      retryAfterSeconds: 0,
    };
  }

  function decide(requestOrKey: Request | string, increment: boolean): RateLimitDecision {
    const checkedAt = now();
    if (options.disabled) {
      return unlimitedDecision(requestOrKey, checkedAt);
    }

    const key = normalizedKey(requestOrKey);
    const current = buckets.get(key);
    if (increment && !current && buckets.size >= maxBuckets) {
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

    if (increment) {
      bucket.count += 1;
      buckets.set(key, bucket);
    }

    const limited = increment ? bucket.count > options.max : bucket.count >= options.max;
    return {
      limited,
      key,
      count: bucket.count,
      limit: options.max,
      remaining: Math.max(options.max - bucket.count, 0),
      resetAt: bucket.resetAt,
      retryAfterSeconds: Math.max(Math.ceil((bucket.resetAt - checkedAt) / 1000), 1),
    };
  }

  return {
    peek(requestOrKey: Request | string): RateLimitDecision {
      return decide(requestOrKey, false);
    },
    check(requestOrKey: Request | string): RateLimitDecision {
      return decide(requestOrKey, true);
    },
    clear() {
      buckets.clear();
    },
  };
}

export function createConfiguredInMemoryRateLimiter(
  surface: string,
  defaults: RateLimitRule,
  options: Readonly<{ env?: RateLimitEnv; keyPrefix?: string; maxBuckets?: number; now?: () => number }> = {},
) {
  const rule = resolveRateLimitRule(surface, defaults, options.env);
  return createInMemoryRateLimiter({
    ...rule,
    keyPrefix: options.keyPrefix ?? surface,
    maxBuckets: options.maxBuckets,
    now: options.now,
  });
}

export function resolveRateLimitRule(surface: string, defaults: RateLimitRule, env = defaultRateLimitEnv()) {
  const envKey = rateLimitEnvKey(surface);
  const max = positiveNumberEnv(env, `CHASE_SETS_RATE_LIMIT_${envKey}_MAX`, defaults.max);
  const windowMs = positiveNumberEnv(env, `CHASE_SETS_RATE_LIMIT_${envKey}_WINDOW_MS`, defaults.windowMs);
  const disabled =
    booleanEnv(env, "CHASE_SETS_RATE_LIMITS_DISABLED", false) ||
    booleanEnv(env, `CHASE_SETS_RATE_LIMIT_${envKey}_DISABLED`, defaults.disabled === true);

  return { max, windowMs, disabled };
}

export function rateLimitEnvKey(surface: string) {
  return surface
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
}

export function recordRateLimitExceeded(surface: string) {
  const normalized = surface.trim() || "unknown";
  rateLimitExceededCounters.set(normalized, (rateLimitExceededCounters.get(normalized) ?? 0) + 1);
}

export function getRateLimitExceededCounters() {
  return Object.fromEntries(
    [...rateLimitExceededCounters.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function clearRateLimitExceededCounters() {
  rateLimitExceededCounters.clear();
}

export function rateLimitExceededJsonResponse(surface: string, decision: RateLimitDecision) {
  recordRateLimitExceeded(surface);
  return new Response(
    JSON.stringify({
      error: {
        code: "rate_limited",
        message: "Too many requests. Please retry after the rate-limit window.",
        surface,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(decision.retryAfterSeconds),
      },
    },
  );
}

function defaultRateLimitEnv(): RateLimitEnv {
  const candidate = globalThis as typeof globalThis & {
    process?: { env?: RateLimitEnv };
  };
  return candidate.process?.env ?? {};
}

function positiveNumberEnv(env: RateLimitEnv, key: string, fallback: number) {
  const raw = env[key]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function booleanEnv(env: RateLimitEnv, key: string, fallback: boolean) {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
