import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { RepricingEnginePolicyValue } from "../domain/policy";
import type { RepricingRoundDirection } from "../domain/fact";

type Product = Readonly<{ catalogItemId: string; productId: string }>;
type ProductRoundState = Readonly<{
  next_eligible_at: string;
  same_direction_rounds: number;
  last_direction: RepricingRoundDirection | null;
  frozen_until: string | null;
  updated_at: string;
}>;

export async function readProductRoundState(db: PgQueryable, product: Product): Promise<ProductRoundState | null> {
  const result = await db.query<ProductRoundState>(
    `SELECT next_eligible_at::text, same_direction_rounds, last_direction, frozen_until::text, updated_at::text
     FROM pricing_repricing_product_round_cooldowns
     WHERE catalog_catalog_item_id = $1 AND product_id = $2`,
    [product.catalogItemId, product.productId],
  );
  return result.rows[0] ?? null;
}

export function activeProductFreeze(state: ProductRoundState | null, now: string): string | null {
  return state?.frozen_until && Date.parse(state.frozen_until) > Date.parse(now)
    ? new Date(state.frozen_until).toISOString()
    : null;
}

async function ensureProductRoundState(db: PgQueryable, product: Product, now: string): Promise<void> {
  await db.query(
    `INSERT INTO pricing_repricing_product_round_cooldowns (
       catalog_catalog_item_id, product_id, next_eligible_at, last_trigger_event_id, updated_at
     ) VALUES ($1, $2, $3, '', $3)
     ON CONFLICT (catalog_catalog_item_id, product_id) DO NOTHING`,
    [product.catalogItemId, product.productId, now],
  );
}

export async function reserveProductRoundCooldown(
  db: PgQueryable,
  input: Product & Readonly<{ triggerEventId: string; cooldownMinutes: number }>,
  now: string,
): Promise<boolean> {
  await ensureProductRoundState(db, input, now);
  while (true) {
    const state = (await readProductRoundState(db, input))!;
    if (activeProductFreeze(state, now) || Date.parse(state.next_eligible_at) > Date.parse(now)) {
      return false;
    }
    const result = await db.query(
      `UPDATE pricing_repricing_product_round_cooldowns
       SET next_eligible_at = $3::timestamptz + ($4 * interval '1 minute'),
           last_trigger_event_id = $5,
           updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
       WHERE catalog_catalog_item_id = $1 AND product_id = $2 AND updated_at = $6::timestamptz`,
      [input.catalogItemId, input.productId, now, input.cooldownMinutes, input.triggerEventId, state.updated_at],
    );
    if (result.rowCount === 1) {
      return true;
    }
  }
}

export async function recordProductRoundDirection(
  db: PgQueryable,
  product: Product,
  direction: RepricingRoundDirection | null,
  policy: RepricingEnginePolicyValue,
  now: string,
): Promise<Readonly<{ direction: RepricingRoundDirection; roundCount: number; frozenUntil: string }> | null> {
  await ensureProductRoundState(db, product, now);
  while (true) {
    const state = (await readProductRoundState(db, product))!;
    // A round already in flight must never release or extend a newer freeze.
    if (activeProductFreeze(state, now)) {
      return null;
    }
    const roundCount =
      direction === null ? 0 : direction === state.last_direction ? state.same_direction_rounds + 1 : 1;
    const tripped = direction !== null && roundCount >= policy.spiralBreakerRounds;
    const frozenUntil = tripped
      ? new Date(Date.parse(now) + policy.spiralBreakerFreezeMinutes * 60_000).toISOString()
      : null;
    const result = await db.query(
      `UPDATE pricing_repricing_product_round_cooldowns
       SET same_direction_rounds = $3,
           last_direction = $4,
           frozen_until = $5,
           tripped_at = CASE WHEN $5::timestamptz IS NOT NULL THEN $6::timestamptz ELSE tripped_at END,
           next_eligible_at = COALESCE($5::timestamptz, next_eligible_at),
           updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
       WHERE catalog_catalog_item_id = $1 AND product_id = $2 AND updated_at = $7::timestamptz`,
      [
        product.catalogItemId,
        product.productId,
        tripped ? 0 : roundCount,
        tripped ? null : direction,
        frozenUntil,
        now,
        state.updated_at,
      ],
    );
    if (result.rowCount === 1) {
      return tripped ? { direction: direction!, roundCount, frozenUntil: frozenUntil! } : null;
    }
  }
}
