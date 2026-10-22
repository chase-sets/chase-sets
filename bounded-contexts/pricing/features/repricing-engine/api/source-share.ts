import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPolicyResolver, type PolicyResolver } from "@chase-sets/platform-policy/resolver";
import { bulkRepriceSunsetPolicy, BulkRepriceSunsetPolicyError, evaluateBulkRepriceSunset } from "../domain/sunset";
import { listRepricingSourceShareWeeks, RepricingSourceShareRangeError } from "../read-model/source-share";

export async function resolveBulkRepriceSunsetPolicy(resolver: PolicyResolver) {
  try {
    const resolved = await resolver.resolvePolicy(bulkRepriceSunsetPolicy);
    return resolved.source === "policy" ? resolved.value : null;
  } catch (error) {
    if (error instanceof BulkRepriceSunsetPolicyError) return null;
    throw error;
  }
}

export async function getRepricingSourceShareReport(db: PgQueryable, params: Readonly<{ from: string; to: string }>) {
  try {
    const [weeks, policy] = await Promise.all([
      listRepricingSourceShareWeeks(db, params),
      resolveBulkRepriceSunsetPolicy(createPolicyResolver({ db })),
    ]);
    return { status: "available" as const, weeks, decision: evaluateBulkRepriceSunset(weeks, policy) };
  } catch (error) {
    if (error instanceof RepricingSourceShareRangeError)
      return { status: "unavailable" as const, weeks: [], reason: "invalid-week-range" };
    throw error;
  }
}
