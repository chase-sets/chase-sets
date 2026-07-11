import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { RateLimitRule } from "@chase-sets/http/rate-limit";
import type { JsonValue } from "@chase-sets/primitives/json";

/**
 * Platform Operations' rate-limit policy: one policy family covering every
 * rate-limited surface on the platform. Each named surface
 * (e.g. `checkout.anonymous-rail-capture`) registers its own compiled
 * `RateLimitRule` fallback at the call site -- this policy only carries
 * OVERRIDES, so a surface nobody has ever tuned resolves to its compiled
 * default byte-for-byte. Two knobs exist for incident response:
 *
 * - `incidentMultiplier`: a single dial that tightens (or loosens) every
 *   resolved rule at once by dividing its effective max by the multiplier,
 *   clamped to never fall below 1 request. 1 = no change.
 * - `surfaces[key].disabled`: a per-surface kill switch that stops counting
 *   entirely for that surface (never used to silently disable ALL rate
 *   limiting -- each surface's kill switch is independent and explicit).
 *
 * Security lifetimes (session/OTP/magic-link TTLs) are deliberately NOT
 * covered here -- those stay env-only by design (platform-policy epic, Tier 4).
 * This policy only ever loosens or tightens REQUEST VOLUME ceilings.
 */

export type RateLimitPolicySurfaceOverride = Readonly<{
  max?: number;
  windowMs?: number;
  disabled?: boolean;
}>;

export type RateLimitPolicyValue = Readonly<{
  incidentMultiplier: number;
  surfaces: Readonly<Record<string, RateLimitPolicySurfaceOverride>>;
}>;

export const RATE_LIMIT_POLICY_DEFAULT_VALUE: RateLimitPolicyValue = {
  incidentMultiplier: 1,
  surfaces: {},
};

/** The incident multiplier's valid range: never fully open (0) nor absurdly extreme. */
export const RATE_LIMIT_POLICY_MIN_MULTIPLIER = 0.1;
export const RATE_LIMIT_POLICY_MAX_MULTIPLIER = 10;

/** Per-surface override bounds -- generous enough for any real surface, tight enough to reject fat-fingered zeros. */
const MIN_MAX = 1;
const MAX_MAX = 1_000_000;
const MIN_WINDOW_MS = 1_000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

export class RateLimitPolicyDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitPolicyDomainError";
  }
}

function decodeMultiplier(value: unknown): number {
  const numeric = Number(value);
  if (
    !Number.isFinite(numeric) ||
    numeric < RATE_LIMIT_POLICY_MIN_MULTIPLIER ||
    numeric > RATE_LIMIT_POLICY_MAX_MULTIPLIER
  ) {
    throw new RateLimitPolicyDomainError(
      `Rate-limit incident multiplier must be between ${RATE_LIMIT_POLICY_MIN_MULTIPLIER} and ${RATE_LIMIT_POLICY_MAX_MULTIPLIER}.`,
    );
  }
  return numeric;
}

function decodeSurfaceOverride(surfaceKey: string, raw: unknown): RateLimitPolicySurfaceOverride {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RateLimitPolicyDomainError(`Rate-limit policy override for surface '${surfaceKey}' must be an object.`);
  }
  const record = raw as Record<string, unknown>;
  const override: {
    max?: number;
    windowMs?: number;
    disabled?: boolean;
  } = {};

  if (record.max !== undefined && record.max !== null) {
    const max = Number(record.max);
    if (!Number.isInteger(max) || max < MIN_MAX || max > MAX_MAX) {
      throw new RateLimitPolicyDomainError(
        `Rate-limit policy 'max' for surface '${surfaceKey}' must be a whole number between ${MIN_MAX} and ${MAX_MAX}.`,
      );
    }
    override.max = max;
  }

  if (record.windowMs !== undefined && record.windowMs !== null) {
    const windowMs = Number(record.windowMs);
    if (!Number.isInteger(windowMs) || windowMs < MIN_WINDOW_MS || windowMs > MAX_WINDOW_MS) {
      throw new RateLimitPolicyDomainError(
        `Rate-limit policy 'windowMs' for surface '${surfaceKey}' must be a whole number of milliseconds between ${MIN_WINDOW_MS} and ${MAX_WINDOW_MS}.`,
      );
    }
    override.windowMs = windowMs;
  }

  if (record.disabled !== undefined && record.disabled !== null) {
    if (typeof record.disabled !== "boolean") {
      throw new RateLimitPolicyDomainError(
        `Rate-limit policy 'disabled' for surface '${surfaceKey}' must be a boolean.`,
      );
    }
    override.disabled = record.disabled;
  }

  return override;
}

export function decodeRateLimitPolicyValue(raw: JsonValue): RateLimitPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RateLimitPolicyDomainError("Rate-limit policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const incidentMultiplier = decodeMultiplier(record.incidentMultiplier ?? 1);

  const rawSurfaces = record.surfaces;
  if (
    rawSurfaces !== undefined &&
    rawSurfaces !== null &&
    (typeof rawSurfaces !== "object" || Array.isArray(rawSurfaces))
  ) {
    throw new RateLimitPolicyDomainError("Rate-limit policy 'surfaces' must be an object keyed by surface name.");
  }

  const surfaces: Record<string, RateLimitPolicySurfaceOverride> = {};
  for (const [surfaceKey, override] of Object.entries((rawSurfaces as Record<string, unknown>) ?? {})) {
    const trimmedKey = surfaceKey.trim();
    if (!trimmedKey) {
      throw new RateLimitPolicyDomainError("Rate-limit policy surface keys must be non-empty.");
    }
    surfaces[trimmedKey] = decodeSurfaceOverride(trimmedKey, override);
  }

  return { incidentMultiplier, surfaces };
}

export const rateLimitPolicy: PolicyDefinition<RateLimitPolicyValue> = definePolicy({
  policyKey: "platform-operations.rate-limits",
  contextName: "platform-operations",
  schemaSummary:
    "{ incidentMultiplier: number 0.1-10, surfaces: { [surfaceKey]: { max?: integer 1-1000000, windowMs?: integer 1000-86400000, disabled?: boolean } } }",
  defaultValue: RATE_LIMIT_POLICY_DEFAULT_VALUE,
  decodeValue: decodeRateLimitPolicyValue,
});

/**
 * Applies a resolved rate-limit policy value to one surface's compiled
 * fallback rule, producing the effective rule for right now. Pure and
 * synchronous -- callers resolve the policy value once (via the cached
 * platform-policy resolver or the cross-context port) and apply it to as
 * many surfaces as they like without additional I/O.
 */
export function applyRateLimitPolicy(
  value: RateLimitPolicyValue,
  surface: string,
  defaults: RateLimitRule,
): RateLimitRule {
  const override = value.surfaces[surface];
  const disabled = override?.disabled ?? defaults.disabled ?? false;
  const baseMax = override?.max ?? defaults.max;
  const windowMs = override?.windowMs ?? defaults.windowMs;
  const multiplier = value.incidentMultiplier > 0 ? value.incidentMultiplier : 1;
  const max = Math.max(1, Math.round(baseMax / multiplier));

  return { max, windowMs, disabled };
}
