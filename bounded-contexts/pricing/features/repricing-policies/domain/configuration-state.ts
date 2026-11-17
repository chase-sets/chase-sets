import { decideRepricingPolicy, initialRepricingPolicyState, type RepricingPolicyState } from "./domain";
import type { RepricingHaltState } from "./halt";

function timestamp(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

export function parseRepricingHaltState(value: unknown): RepricingHaltState {
  if (
    !value ||
    typeof value !== "object" ||
    !("engaged" in value) ||
    typeof value.engaged !== "boolean" ||
    !("engagedAt" in value) ||
    !timestamp(value.engagedAt) ||
    !("releasedAt" in value) ||
    !timestamp(value.releasedAt) ||
    (value.engaged && value.engagedAt === null) ||
    (!value.engaged && value.engagedAt !== null && value.releasedAt === null)
  )
    throw new Error("Invalid installed Repricing Halt.");
  return { engaged: value.engaged, engagedAt: value.engagedAt, releasedAt: value.releasedAt };
}

export function parseRepricingPolicyState(value: unknown): RepricingPolicyState {
  if (!value || typeof value !== "object") throw new Error("Invalid installed Repricing Policy.");
  const state = value as RepricingPolicyState;
  if (
    typeof state.policyId !== "string" ||
    !state.policyId.startsWith("rpp_") ||
    typeof state.accountId !== "string" ||
    !state.accountId.startsWith("acc_") ||
    typeof state.name !== "string" ||
    !state.name.trim() ||
    !state.scope ||
    !Array.isArray(state.rules) ||
    !Array.isArray(state.excludedListingIds) ||
    state.maxChangesPerDay === null ||
    !["active", "paused", "deleted"].includes(state.status) ||
    !timestamp(state.createdAt) ||
    state.createdAt === null ||
    !timestamp(state.updatedAt) ||
    state.updatedAt === null
  )
    throw new Error("Invalid installed Repricing Policy.");
  decideRepricingPolicy(initialRepricingPolicyState, {
    ...state,
    type: "CreateRepricingPolicy",
    policyId: state.policyId,
    accountId: state.accountId,
    name: state.name,
    scope: state.scope,
    maxChangesPerDay: state.maxChangesPerDay,
    createdAt: state.createdAt,
  });
  return state;
}
