import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

export type PriceSignalPolicyValue = Readonly<{ productsPerPass: number }>;
export const PRICE_SIGNAL_LAUNCH_POLICY_VALUE: PriceSignalPolicyValue = { productsPerPass: 5 };

export function decodePriceSignalPolicyValue(raw: JsonValue): PriceSignalPolicyValue {
  const record = closedRecord(raw, ["productsPerPass"], "Price-signal policy");
  return { productsPerPass: boundedPassSize(record.productsPerPass, "productsPerPass") };
}

export const priceSignalPolicy: PolicyDefinition<PriceSignalPolicyValue> = definePolicy({
  policyKey: "pricing.price-signal",
  contextName: "pricing",
  schemaSummary: "{ productsPerPass: integer 1-5 }",
  defaultValue: PRICE_SIGNAL_LAUNCH_POLICY_VALUE,
  decodeValue: decodePriceSignalPolicyValue,
});

export type PriceSignalPolicyRevision = Readonly<{
  revisionId: string;
  value: PriceSignalPolicyValue;
}>;

type RevisionRow = Readonly<{ event_id: string; value: JsonValue }>;

/** Missing or malformed history is invalid for a capture pass; no compiled fallback is invented. */
export async function resolvePriceSignalPolicyRevisionAsOf(
  db: PgQueryable,
  instant: string,
): Promise<PriceSignalPolicyRevision | null> {
  const result = await db.query<RevisionRow>(
    `SELECT event_id, value
     FROM platform_policy_document_history
     WHERE policy_key = 'pricing.price-signal'
       AND status = 'active'
       AND effective_from <= $1
       AND (effective_until IS NULL OR effective_until > $1)
       AND recorded_at <= $1
     ORDER BY effective_from DESC, recorded_at DESC, history_id DESC
     LIMIT 1`,
    [requiredInstant(instant)],
  );
  const row = result.rows[0];
  return row ? { revisionId: row.event_id, value: decodePriceSignalPolicyValue(row.value) } : null;
}

export function boundedPassSize(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error(`${name} must be an integer from 1 through 5.`);
  }
  return value;
}

export function closedRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((key) => !keys.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported fields.`);
  }
  return record;
}

export function requiredInstant(value: string): string {
  const parsed = new Date(value);
  if (!value.trim() || !Number.isFinite(parsed.getTime())) {
    throw new Error("A finite policy instant is required.");
  }
  return parsed.toISOString();
}
