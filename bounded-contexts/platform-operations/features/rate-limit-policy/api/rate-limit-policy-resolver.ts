import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { RateLimitRule, RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import { applyRateLimitPolicy, rateLimitPolicy, type RateLimitPolicyValue } from "../domain/rate-limit-policy";

/**
 * Cross-context read port for the platform-wide rate-limit policy: checkout,
 * discovery, marketplace, and public-presence consume this (as their
 * `rateLimitPolicyResolver` host port) without ever querying Platform
 * Operations' storage directly -- see `platform-api`'s composition root.
 *
 * Unlike the checkout-processing-fee cross-context port (which resolves once
 * per checkout and can afford a fresh, uncached read every time), rate-limit
 * checks run on every request to every rate-limited surface -- an uncached
 * read here would mean a Postgres round trip per incoming request, including
 * the flood of requests an abusive client sends specifically to defeat the
 * limiter. So this resolver memoizes the whole policy VALUE for a short,
 * fixed window (default 1000ms, matching the "~1s via the wake path"
 * propagation expectation) rather than resolving
 * fresh on every call: at most one Postgres read per refresh window per
 * process, regardless of request volume, with a revision visible to every
 * rate-limited surface within one refresh window of being saved.
 *
 * This is a deliberate, documented simplification relative to same-context
 * push-invalidated consumption (which Platform Operations' own admin routes
 * get for free via the mounted `PolicyRuntime` in
 * `../../../support/runtime-support/services.ts`): a short poll here avoids
 * standing up a full platform-policy projector (and its own copy of the
 * policy-document tables) inside four other bounded contexts for one shared
 * dial, while still keeping enforcement changes to seconds, not deploys.
 */
export function createRateLimitPolicyResolver(
  db: PgQueryable,
  options: Readonly<{ refreshIntervalMs?: number; now?: () => number }> = {},
): RateLimitRuleResolver {
  const refreshIntervalMs = options.refreshIntervalMs ?? 1_000;
  const now = options.now ?? Date.now;
  let cached: { value: RateLimitPolicyValue; fetchedAt: number } | null = null;
  let inflight: Promise<RateLimitPolicyValue> | null = null;

  async function currentPolicyValue(): Promise<RateLimitPolicyValue> {
    const nowMs = now();
    if (cached && nowMs - cached.fetchedAt < refreshIntervalMs) {
      return cached.value;
    }
    if (inflight) {
      return inflight;
    }

    inflight = (async () => {
      const resolver = createPolicyResolver({ db });
      const resolved = await resolver.resolvePolicy(rateLimitPolicy);
      cached = { value: resolved.value, fetchedAt: now() };
      return resolved.value;
    })();

    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  return async (surface: string, defaults: RateLimitRule): Promise<RateLimitRule> => {
    const value = await currentPolicyValue();
    return applyRateLimitPolicy(value, surface, defaults);
  };
}

/** Used by consuming contexts' standalone/test composition when Platform Operations is not mounted. */
export function createNoopRateLimitPolicyResolver(): RateLimitRuleResolver {
  return async (_surface: string, defaults: RateLimitRule): Promise<RateLimitRule> => defaults;
}
