import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { RateLimitRule, RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import { createPolicyCache } from "@chase-sets/platform-policy/cache";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import { applyRateLimitPolicy, rateLimitPolicy } from "../domain/rate-limit-policy";

/**
 * Cross-context read port for the platform-wide rate-limit policy: checkout,
 * discovery, marketplace, and public-presence consume this (as their
 * `rateLimitPolicyResolver` host port) without ever querying Platform
 * Operations' storage directly -- see `platform-api`'s composition root.
 *
 * Rate-limit checks run on every request to every rate-limited surface,
 * including the flood an abusive client sends to defeat the limiter, so this
 * port holds one long-lived policy resolver and inherits its rules: while
 * reads succeed within a second, at most one Postgres read per second, one
 * shared read for concurrent requests, and a revision enforced on every
 * surface within one second of the read model having it. A failed refresh is
 * retried on the next request. Once a value has been loaded, a failed refresh
 * keeps enforcing that value. Only a failed first read rejects, and the
 * limiter then applies the surface's compiled rule.
 *
 * `options.now` is the resolver cache's age clock in epoch milliseconds.
 */
export function createRateLimitPolicyResolver(
  db: PgQueryable,
  options: Readonly<{ now?: () => number }> = {},
): RateLimitRuleResolver {
  const resolver = createPolicyResolver({ db, cache: createPolicyCache(options) });

  return async (surface: string, defaults: RateLimitRule): Promise<RateLimitRule> => {
    const resolved = await resolver.resolvePolicy(rateLimitPolicy);
    return applyRateLimitPolicy(resolved.value, surface, defaults);
  };
}

/** Used by consuming contexts' standalone/test composition when Platform Operations is not mounted. */
export function createNoopRateLimitPolicyResolver(): RateLimitRuleResolver {
  return async (_surface: string, defaults: RateLimitRule): Promise<RateLimitRule> => defaults;
}
