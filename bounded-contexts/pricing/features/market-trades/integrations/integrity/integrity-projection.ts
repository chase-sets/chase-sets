import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Tape-integrity reactions: m107 risk-flag events retroactively exclude a
 * flagged account's/order's historical trades from market stats, and an m109
 * authenticity "passed" verdict sets the tape's `verified` marker. Same
 * `pricing-market-trades-projection` projection name and target table as
 * `../source/source-projection.ts` -- split into its own integrations
 * sub-folder because both the *sources* (identity, payments, authenticity)
 * and the *concern* (integrity, not tape construction) are distinct from the
 * ordering/fulfillment reactions that build the tape.
 *
 * Self-dealing exclusion is deliberately NOT wired here: an m107 hard block
 * rejects same-account orders at creation (ordering's and marketplace's own
 * domain deciders), so a self-dealing trade never reaches the tape. The
 * `'self-dealing'` exclusion_reason stays declared on the CHECK constraint
 * for forward-compatibility but has no writer.
 *
 * Counterparty-linkage clustering shipped as derived read-model counters on
 * `settlement_account_risk_sources` (shared_instrument_cluster_count /
 * shared_address_cluster_count), not as a domain event -- there is nothing
 * for a projection to subscribe to yet. The one channel it DOES expose as a
 * real, already-emitted event is Identity's `identity.account.badge-assigned`
 * with `badgeKey: "manual-payout-review"`: ops (via the platform-operations
 * risk-alert queue, or a direct admin action) assigns that badge when
 * linkage/velocity signals warrant review, and Settlement already reacts to
 * the very same event to flip its own `manual_payout_review` column. Reacting
 * to it here is the honest, currently real "flag raised" signal for a
 * linked/reviewed account, without inventing a subscription to an event no
 * producer emits.
 */

/** Identity's own AccountBadgeKey union, duck-typed -- see source-projection.ts's header note on this convention. */
type AccountBadgeKey = "founding-account" | "manual-payout-review" | "trusted-seller";

/**
 * Reacts to Identity's account-badge lifecycle: a `manual-payout-review`
 * badge assignment is the platform's real "this account is under fraud/
 * linkage review" flag (also consumed by Settlement's own account-risk-source
 * projection). Every historical trade naming the flagged account as either
 * buyer or seller -- i.e. every trade touching that counterparty pair -- is
 * retroactively excluded.
 */
export function buildPricingMarketTradesIdentityIntegrityProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.account.badge-assigned": async (event) => {
      const data = event.data as { badgeKey: AccountBadgeKey };
      if (data.badgeKey !== "manual-payout-review") {
        return;
      }
      const accountId = extractIdFromStreamId(event.streamId, "identity.account-");

      await db.query(
        `UPDATE pricing_market_trades
         SET excluded = true,
             exclusion_reason = 'fraud-flagged',
             updated_at = $2
         WHERE (seller_account_id = $1 OR buyer_account_id = $1)
           AND excluded = false`,
        [accountId, event.timing.recordedAt],
      );
    },
  };
}

/**
 * Reacts to Payments' Stripe early-fraud-warning receipt -- a real,
 * already-emitted m107 risk-flag event that carries the affected order ids
 * directly, making it the most precise retroactive-exclusion signal
 * available: every trade line on those orders is excluded, regardless of
 * which side (buyer or seller) the processor flagged.
 */
export function buildPricingMarketTradesPaymentsIntegrityProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "payments.payment-fraud-warning-received": async (event) => {
      const data = event.data as { orderIds: readonly string[]; receivedAt: string };
      if (data.orderIds.length === 0) {
        return;
      }

      await db.query(
        `UPDATE pricing_market_trades
         SET excluded = true,
             exclusion_reason = 'fraud-flagged',
             updated_at = $2
         WHERE order_id = ANY($1::text[])
           AND excluded = false`,
        [data.orderIds, data.receivedAt],
      );
    },
  };
}

/**
 * Reacts to Authenticity's case lifecycle. `authenticity.case.opened` carries
 * `orderId` but not a verdict; `authenticity.case.verdict-recorded` carries
 * the verdict but only `caseId` (verdicts are per-order and all-or-nothing --
 * see authenticity/GLOSSARY.md). `pricing_market_trade_authenticity_cases`
 * bridges the two so a "passed" verdict can mark every trade line on the
 * case's order `verified`.
 *
 * A "failed" verdict is NOT reacted to here: failed verdicts are
 * refund-excluded via the existing `fulfillment.shipment.returned` handler in
 * `../source/source-projection.ts` once the failed case's return ships back
 * through Fulfillment -- no separate wiring needed.
 */
export function buildPricingMarketTradesAuthenticityIntegrityProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "authenticity.case.opened": async (event) => {
      const data = event.data as { caseId: string; orderId: string; openedAt: string };

      await db.query(
        `INSERT INTO pricing_market_trade_authenticity_cases (case_id, order_id, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (case_id) DO UPDATE SET
           order_id = EXCLUDED.order_id,
           updated_at = EXCLUDED.updated_at`,
        [data.caseId, data.orderId, data.openedAt],
      );
    },
    "authenticity.case.verdict-recorded": async (event) => {
      const data = event.data as { caseId: string; verdict: "passed" | "failed" | "inconclusive"; decidedAt: string };
      if (data.verdict !== "passed") {
        return;
      }

      await db.query(
        `UPDATE pricing_market_trades
         SET verified = true,
             updated_at = $2
         WHERE order_id = (
           SELECT order_id FROM pricing_market_trade_authenticity_cases WHERE case_id = $1
         )`,
        [data.caseId, event.timing.recordedAt],
      );
    },
  };
}
