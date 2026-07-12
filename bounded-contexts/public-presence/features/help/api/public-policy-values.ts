import { Hono } from "hono";
import type { PublicPresenceApiEnv } from "../../../api";
import { publicPolicyValueWhitelist } from "../domain/public-policy-value-whitelist.mjs";

export const PUBLIC_POLICY_PROPAGATION_SECONDS = 360;
export const PUBLIC_POLICY_CHANGE_CALLOUT_DAYS = 30;

export type PublicPolicyCandidate = Readonly<{
  value: unknown;
  effectiveFrom: string;
  effectiveUntil: string | null;
}>;

export type PublicPolicySource = Readonly<{
  policyKey: string;
  read: (at: string) => Promise<
    Readonly<{
      current: Readonly<{ value: unknown; effectiveFrom: string | null }>;
      upcoming: readonly PublicPolicyCandidate[];
    }>
  >;
}>;

export type PublicPolicyValue = Readonly<{
  type: "bps" | "money" | "days" | "minutes" | "number";
  value: string | number;
  currency?: string;
  effectiveFrom: string | null;
  upcoming: readonly Readonly<{ value: string | number; effectiveFrom: string }>[];
}>;

export type PublicPolicyValuesResponse = Readonly<{
  values: Readonly<Record<string, PublicPolicyValue>>;
  resolvedAt: string;
  propagationSeconds: number;
  changeCalloutDays: number;
}>;

export function createPublicPolicyValuesRuntime(sources: readonly PublicPolicySource[]) {
  const sourcesByKey = new Map(sources.map((source) => [source.policyKey, source]));

  return {
    async read(at = new Date().toISOString()): Promise<PublicPolicyValuesResponse> {
      const policyKeys = [...new Set(publicPolicyValueWhitelist.map(({ policyKey }) => policyKey))];
      const policies = new Map(
        await Promise.all(
          policyKeys.map(async (policyKey) => {
            const source = sourcesByKey.get(policyKey);
            if (!source) throw new Error(`Public policy source '${policyKey}' is unavailable.`);
            return [policyKey, await source.read(at)] as const;
          }),
        ),
      );
      const values: Record<string, PublicPolicyValue> = {};
      for (const permission of publicPolicyValueWhitelist) {
        const policy = policies.get(permission.policyKey);
        if (!policy) throw new Error(`Public policy '${permission.policyKey}' was not loaded.`);
        values[permission.key] = {
          type: permission.type,
          value: selectPublicValue(policy.current.value, permission.selector, permission.key),
          ...(permission.currency ? { currency: permission.currency } : {}),
          effectiveFrom: policy.current.effectiveFrom,
          upcoming: policy.upcoming.map((candidate) => ({
            value: selectPublicValue(candidate.value, permission.selector, permission.key),
            effectiveFrom: candidate.effectiveFrom,
          })),
        };
      }
      return {
        values,
        resolvedAt: at,
        propagationSeconds: PUBLIC_POLICY_PROPAGATION_SECONDS,
        changeCalloutDays: PUBLIC_POLICY_CHANGE_CALLOUT_DAYS,
      };
    },
  };
}

function selectPublicValue(value: unknown, selector: Readonly<Record<string, unknown>>, key: string): string | number {
  if (Array.isArray(selector.path)) {
    let selected = value;
    for (const segment of selector.path) {
      if (typeof segment !== "string" || typeof selected !== "object" || selected === null || !(segment in selected)) {
        throw new Error(`Whitelisted public policy value '${key}' could not be resolved.`);
      }
      selected = (selected as Record<string, unknown>)[segment];
    }
    return requireScalar(selected, key);
  }

  if (typeof selector.checkoutMethod === "string") {
    const record = requireRecord(value, key);
    const base = requireRecord(record.base, key);
    const adjustments = Array.isArray(record.methodAdjustments) ? record.methodAdjustments : [];
    const adjustment = adjustments.find(
      (candidate) => requireRecord(candidate, key).paymentMethodCategory === selector.checkoutMethod,
    );
    if (!adjustment) throw new Error(`Whitelisted public policy value '${key}' could not be resolved.`);
    const adjustmentRecord = requireRecord(adjustment, key);
    if (selector.component === "percentageBps") {
      return (
        Number(requireScalar(base.percentageBps, key)) + Number(requireScalar(adjustmentRecord.percentageBpsDelta, key))
      );
    }
    if (selector.component === "fixedAmount") {
      return addMoney(
        String(requireScalar(base.fixedAmount, key)),
        String(requireScalar(adjustmentRecord.fixedAmountDelta, key)),
      );
    }
  }

  if (typeof selector.rateLimitSurface === "string") {
    const record = requireRecord(value, key);
    const defaults = requireRecord(selector.defaults, key);
    const surfaces = requireRecord(record.surfaces, key);
    const override = surfaces[selector.rateLimitSurface] ? requireRecord(surfaces[selector.rateLimitSurface], key) : {};
    const multiplier = Number(requireScalar(record.incidentMultiplier, key));
    const max = Number(override.max ?? requireScalar(defaults.max, key));
    const windowMs = Number(override.windowMs ?? requireScalar(defaults.windowMs, key));
    if (selector.component === "max") return Math.max(1, Math.round(max / multiplier));
    if (selector.component === "windowMs") return windowMs;
  }

  throw new Error(`Whitelisted public policy value '${key}' has an invalid selector.`);
}

function requireRecord(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Whitelisted public policy value '${key}' could not be resolved.`);
  }
  return value as Record<string, unknown>;
}

function requireScalar(value: unknown, key: string): string | number {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`Whitelisted public policy value '${key}' could not be resolved.`);
  }
  return value;
}

function addMoney(left: string, right: string) {
  const cents = (amount: string) => Math.round(Number(amount) * 100);
  const total = cents(left) + cents(right);
  if (!Number.isSafeInteger(total)) throw new Error("Public checkout processing fee is not a valid money amount.");
  return `${total < 0 ? "-" : ""}${Math.floor(Math.abs(total) / 100)}.${String(Math.abs(total) % 100).padStart(2, "0")}`;
}

export function createPublicPolicyValuesRoutes(runtime: ReturnType<typeof createPublicPolicyValuesRuntime>) {
  const app = new Hono<PublicPresenceApiEnv>();
  app.get("/policy-values", async (c) => {
    const response = c.json(await runtime.read());
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
  return app;
}
