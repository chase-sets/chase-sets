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

function normalizedBucketKey(keyPrefix: string, requestOrKey: Request | string) {
  const key = typeof requestOrKey === "string" ? requestOrKey.trim() : publicClientRequestKey(requestOrKey);
  return `${keyPrefix}${keyPrefix ? ":" : ""}${key || "local"}`;
}

function evictIfFull(buckets: Map<string, Bucket>, maxBuckets: number, checkedAt: number) {
  if (buckets.size < maxBuckets) {
    return;
  }
  for (const [bucketKey, bucket] of buckets) {
    if (bucket.resetAt <= checkedAt || buckets.size >= maxBuckets) {
      buckets.delete(bucketKey);
    }
    if (buckets.size < maxBuckets) {
      break;
    }
  }
}

/**
 * The pure bucket-decision core shared by both the static-rule limiter
 * (`createInMemoryRateLimiter`) and the policy-backed limiter
 * (`createPolicyBackedRateLimiter`): given the current bucket store, a rule
 * (static or freshly resolved from policy), and the request key, compute the
 * decision and mutate the bucket store in place. Keeping this logic in one
 * place means a policy-driven rule change is evaluated with exactly the same
 * counting semantics as an env-driven one.
 */
function decideBucket(
  buckets: Map<string, Bucket>,
  rule: RateLimitRule,
  params: Readonly<{ key: string; checkedAt: number; increment: boolean; maxBuckets: number }>,
): RateLimitDecision {
  const { key, checkedAt, increment, maxBuckets } = params;
  if (rule.disabled) {
    return {
      limited: false,
      key,
      count: 0,
      limit: rule.max,
      remaining: rule.max,
      resetAt: checkedAt,
      retryAfterSeconds: 0,
    };
  }

  const current = buckets.get(key);
  if (increment && !current) {
    evictIfFull(buckets, maxBuckets, checkedAt);
  }

  const bucket = !current || current.resetAt <= checkedAt ? { count: 0, resetAt: checkedAt + rule.windowMs } : current;

  if (increment) {
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  const limited = increment ? bucket.count > rule.max : bucket.count >= rule.max;
  return {
    limited,
    key,
    count: bucket.count,
    limit: rule.max,
    remaining: Math.max(rule.max - bucket.count, 0),
    resetAt: bucket.resetAt,
    retryAfterSeconds: Math.max(Math.ceil((bucket.resetAt - checkedAt) / 1000), 1),
  };
}

export function createInMemoryRateLimiter(options: InMemoryRateLimiterOptions) {
  const buckets = new Map<string, Bucket>();
  const now = options.now ?? Date.now;
  const keyPrefix = options.keyPrefix?.trim() ?? "";
  const maxBuckets = Math.max(options.maxBuckets ?? 10_000, 1);
  const rule: RateLimitRule = { max: options.max, windowMs: options.windowMs, disabled: options.disabled };

  function decide(requestOrKey: Request | string, increment: boolean): RateLimitDecision {
    return decideBucket(buckets, rule, {
      key: normalizedBucketKey(keyPrefix, requestOrKey),
      checkedAt: now(),
      increment,
      maxBuckets,
    });
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

/**
 * A rule resolver bound to one surface: given the surface's compiled
 * fallback rule, returns the effective rule for right now (policy override,
 * global incident multiplier applied, or the fallback itself). Implementations
 * MUST fail safe -- a resolver that throws (policy store unavailable) is
 * treated by `createPolicyBackedRateLimiter` as "use the compiled fallback",
 * never as "allow everything" or "reject everything".
 */
export type RateLimitRuleResolver = (surface: string, defaults: RateLimitRule) => Promise<RateLimitRule>;

export type PolicyBackedRateLimiter = Readonly<{
  peek: (requestOrKey: Request | string) => Promise<RateLimitDecision>;
  check: (requestOrKey: Request | string) => Promise<RateLimitDecision>;
  clear: () => void;
}>;

export type CreatePolicyBackedRateLimiterOptions = Readonly<{
  /** Bucket-key namespace; distinct from `surface` so two limiters can share one policy dial with isolated bucket stores. Defaults to `surface`. */
  keyPrefix?: string;
  maxBuckets?: number;
  now?: () => number;
}>;

/**
 * A rate limiter whose effective rule is resolved per-check from
 * `resolveRule` (typically backed by a platform-policy document) instead of
 * being fixed at construction time. The bucket store itself is a long-lived,
 * in-process `Map` exactly like `createInMemoryRateLimiter` -- only the rule
 * (max/windowMs/disabled) is re-resolved on every call, so a policy revision
 * changes enforcement on the very next request without resetting existing
 * counters or restarting the process.
 */
export function createPolicyBackedRateLimiter(
  surface: string,
  defaults: RateLimitRule,
  resolveRule: RateLimitRuleResolver,
  options: CreatePolicyBackedRateLimiterOptions = {},
): PolicyBackedRateLimiter {
  const buckets = new Map<string, Bucket>();
  const now = options.now ?? Date.now;
  const keyPrefix = (options.keyPrefix ?? surface).trim();
  const maxBuckets = Math.max(options.maxBuckets ?? 10_000, 1);

  async function currentRule(): Promise<RateLimitRule> {
    try {
      return await resolveRule(surface, defaults);
    } catch {
      // Fail safe: an unavailable policy store must never disable rate limiting.
      return defaults;
    }
  }

  async function decide(requestOrKey: Request | string, increment: boolean): Promise<RateLimitDecision> {
    const rule = await currentRule();
    return decideBucket(buckets, rule, {
      key: normalizedBucketKey(keyPrefix, requestOrKey),
      checkedAt: now(),
      increment,
      maxBuckets,
    });
  }

  return {
    peek: (requestOrKey) => decide(requestOrKey, false),
    check: (requestOrKey) => decide(requestOrKey, true),
    clear: () => buckets.clear(),
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
