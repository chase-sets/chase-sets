import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import {
  normalizeAccountLinkageClearedPayload,
  normalizeAccountLinkageFlaggedPayload,
} from "@chase-sets/event-core/account-linkage-facts";
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
 * Settlement's account-linkage lifecycle is the pair-scoped self-dealing
 * authority: a trade is excluded only when BOTH counterparties belong to the
 * same active cluster. Identity's manual-review badge remains the broader,
 * account-scoped fraud path. Every retroactive stats change also records the
 * affected sold-day tuple for bounded asynchronous rollup repair.
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
        `WITH affected AS (
           UPDATE pricing_market_trades
           SET excluded = true,
               exclusion_reason = 'fraud-flagged',
               updated_at = $2
           WHERE (seller_account_id = $1 OR buyer_account_id = $1)
             AND (excluded = false OR exclusion_reason = 'self-dealing')
           RETURNING catalog_catalog_item_id, product_id, sold_at
         )
         INSERT INTO pricing_market_trade_rollup_rederive_queue (
           catalog_catalog_item_id, product_id, day, queued_at, generation
         )
         SELECT DISTINCT catalog_catalog_item_id, product_id,
                (sold_at AT TIME ZONE 'UTC')::date, $2, 1
         FROM affected
         WHERE sold_at IS NOT NULL
         ON CONFLICT (catalog_catalog_item_id, product_id, day) DO UPDATE
         SET queued_at = GREATEST(
               pricing_market_trade_rollup_rederive_queue.queued_at,
               EXCLUDED.queued_at
             ),
             generation = pricing_market_trade_rollup_rederive_queue.generation + 1`,
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
        `WITH affected AS (
           UPDATE pricing_market_trades
           SET excluded = true,
               exclusion_reason = 'fraud-flagged',
               updated_at = $2
           WHERE order_id = ANY($1::text[])
             AND (excluded = false OR exclusion_reason = 'self-dealing')
           RETURNING catalog_catalog_item_id, product_id, sold_at
         )
         INSERT INTO pricing_market_trade_rollup_rederive_queue (
           catalog_catalog_item_id, product_id, day, queued_at, generation
         )
         SELECT DISTINCT catalog_catalog_item_id, product_id,
                (sold_at AT TIME ZONE 'UTC')::date, $2, 1
         FROM affected
         WHERE sold_at IS NOT NULL
         ON CONFLICT (catalog_catalog_item_id, product_id, day) DO UPDATE
         SET queued_at = GREATEST(
               pricing_market_trade_rollup_rederive_queue.queued_at,
               EXCLUDED.queued_at
             ),
             generation = pricing_market_trade_rollup_rederive_queue.generation + 1`,
        [data.orderIds, data.receivedAt],
      );
    },
  };
}

/**
 * Projects Settlement's privacy-minimal account-linkage facts into Pricing's
 * local state and applies the pair-scoped tape exclusion. Re-flagging the
 * same cluster replaces its account set: newly covered pairs are excluded
 * and pairs no longer covered by any active cluster are restored.
 */
export function buildPricingMarketTradesSettlementIntegrityProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "settlement.account-linkage.flagged": async (event) => {
      const data = normalizeAccountLinkageFlaggedPayload(event.data);

      await db.query(
        `WITH linkage_state AS (
           INSERT INTO pricing_market_trade_linkage_clusters (
             cluster_hash, signal_kind, account_ids, flagged, updated_at
           ) VALUES ($1, $2, $3::text[], true, $4)
           ON CONFLICT (cluster_hash) DO UPDATE SET
             signal_kind = EXCLUDED.signal_kind,
             account_ids = EXCLUDED.account_ids,
             flagged = true,
             updated_at = EXCLUDED.updated_at
           RETURNING cluster_hash
         ), newly_excluded AS (
           UPDATE pricing_market_trades
           SET excluded = true,
               exclusion_reason = 'self-dealing',
               updated_at = $4
           WHERE excluded = false
             AND buyer_account_id = ANY($3::text[])
             AND seller_account_id = ANY($3::text[])
           RETURNING catalog_catalog_item_id, product_id, sold_at
         ), stale_reincluded AS (
           UPDATE pricing_market_trades AS trade
           SET excluded = false,
               exclusion_reason = NULL,
               updated_at = $4
           WHERE trade.exclusion_reason = 'self-dealing'
             AND NOT (
               (trade.buyer_account_id = ANY($3::text[])
                AND trade.seller_account_id = ANY($3::text[]))
               OR EXISTS (
                 SELECT 1
                 FROM pricing_market_trade_linkage_clusters AS cluster
                 WHERE cluster.flagged = true
                   AND cluster.cluster_hash <> $1
                   AND cluster.account_ids @> ARRAY[
                     trade.buyer_account_id,
                     trade.seller_account_id
                   ]::text[]
               )
             )
           RETURNING catalog_catalog_item_id, product_id, sold_at
         ), affected AS (
           SELECT * FROM newly_excluded
           UNION ALL
           SELECT * FROM stale_reincluded
         )
         INSERT INTO pricing_market_trade_rollup_rederive_queue (
           catalog_catalog_item_id, product_id, day, queued_at, generation
         )
         SELECT DISTINCT catalog_catalog_item_id, product_id,
                (sold_at AT TIME ZONE 'UTC')::date, $4, 1
         FROM affected
         WHERE sold_at IS NOT NULL
         ON CONFLICT (catalog_catalog_item_id, product_id, day) DO UPDATE
         SET queued_at = GREATEST(
               pricing_market_trade_rollup_rederive_queue.queued_at,
               EXCLUDED.queued_at
             ),
             generation = pricing_market_trade_rollup_rederive_queue.generation + 1`,
        [data.clusterHash, data.signalKind, data.accountIds, event.timing.recordedAt],
      );
    },
    "settlement.account-linkage.cleared": async (event) => {
      const data = normalizeAccountLinkageClearedPayload(event.data);

      await db.query(
        `WITH linkage_state AS (
           INSERT INTO pricing_market_trade_linkage_clusters (
             cluster_hash, signal_kind, account_ids, flagged, updated_at
           ) VALUES ($1, $2, $3::text[], false, $4)
           ON CONFLICT (cluster_hash) DO UPDATE SET
             signal_kind = EXCLUDED.signal_kind,
             account_ids = EXCLUDED.account_ids,
             flagged = false,
             updated_at = EXCLUDED.updated_at
           RETURNING cluster_hash
         ), affected AS (
           UPDATE pricing_market_trades AS trade
           SET excluded = false,
               exclusion_reason = NULL,
               updated_at = $4
           WHERE trade.exclusion_reason = 'self-dealing'
             AND NOT EXISTS (
               SELECT 1
               FROM pricing_market_trade_linkage_clusters AS cluster
               WHERE cluster.flagged = true
                 AND cluster.cluster_hash <> $1
                 AND cluster.account_ids @> ARRAY[
                   trade.buyer_account_id,
                   trade.seller_account_id
                 ]::text[]
             )
           RETURNING catalog_catalog_item_id, product_id, sold_at
         )
         INSERT INTO pricing_market_trade_rollup_rederive_queue (
           catalog_catalog_item_id, product_id, day, queued_at, generation
         )
         SELECT DISTINCT catalog_catalog_item_id, product_id,
                (sold_at AT TIME ZONE 'UTC')::date, $4, 1
         FROM affected
         WHERE sold_at IS NOT NULL
         ON CONFLICT (catalog_catalog_item_id, product_id, day) DO UPDATE
         SET queued_at = GREATEST(
               pricing_market_trade_rollup_rederive_queue.queued_at,
               EXCLUDED.queued_at
             ),
             generation = pricing_market_trade_rollup_rederive_queue.generation + 1`,
        [data.clusterHash, data.signalKind, data.accountIds, event.timing.recordedAt],
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
