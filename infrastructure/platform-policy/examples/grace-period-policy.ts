import type { JsonValue } from "@chase-sets/primitives/json";
import { definePolicy, type PolicyDefinition } from "../define-policy";

/**
 * The machinery's own internal example: a made-up "grace period" policy that
 * exercises `definePolicy` end to end (declare, encode/decode, fallback)
 * without touching any real bounded context. Downstream slices define their
 * own policies against real business values; this one exists only to prove
 * the mechanism and to give the runtime tests something concrete to create,
 * revise, and resolve.
 */
export type GracePeriodPolicyValue = Readonly<{
  graceDays: number;
}>;

export function decodeGracePeriodPolicyValue(raw: JsonValue): GracePeriodPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Grace period policy value must be an object.");
  }

  const graceDays = (raw as Record<string, unknown>).graceDays;
  if (typeof graceDays !== "number" || !Number.isInteger(graceDays) || graceDays < 0 || graceDays > 90) {
    throw new Error("Grace period policy graceDays must be an integer between 0 and 90.");
  }

  return { graceDays };
}

export const gracePeriodPolicy: PolicyDefinition<GracePeriodPolicyValue> = definePolicy({
  policyKey: "platform-policy.example.grace-period",
  contextName: "platform-policy",
  schemaSummary: "{ graceDays: integer 0-90 }",
  defaultValue: { graceDays: 3 },
  decodeValue: decodeGracePeriodPolicyValue,
});
