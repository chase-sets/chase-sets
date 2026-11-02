import { createPostgresEventStore, withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { applyMoneyRatio } from "@chase-sets/primitives/money";
import { DEMAND_CURVE_LAUNCH_POLICY_VALUE } from "../../features/market-estimates/domain/demand-curve-policy";
import { FORECAST_LEDGER_LAUNCH_POLICY_VALUE } from "../../features/forecast-ledger/domain/policy";
import { gradingRulesVersion } from "../../features/forecast-ledger/domain/grade-ledger";
import {
  buildRepricingPolicyProjectionHandlers,
  repricingPolicyStreamId,
} from "../../features/repricing-policies/read-model/projection";

/** Establish only synthetic policy discovery inputs from their actual retained events, never a health summary. */
export async function projectSyntheticPricingHealthPolicy(
  pool: PgTransactionalPool,
  input: Readonly<{ accountId: string; policyId: string }>,
) {
  const events = await createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "pricing" }),
  }).readStream({
    streamId: repricingPolicyStreamId(input.policyId),
    limit: 10,
  });
  const created = events[0];
  if (
    events.length === 0 ||
    events.length >= 10 ||
    created?.eventType !== "pricing.repricing-policy.created" ||
    created.payload.accountId !== input.accountId ||
    created.payload.policyId !== input.policyId ||
    typeof created.payload.name !== "string" ||
    !/^Synthetic (Pricing Health browser|health policy)/.test(created.payload.name) ||
    events.some(
      (event) => !["pricing.repricing-policy.created", "pricing.repricing-policy.deleted"].includes(event.eventType),
    )
  ) {
    throw new Error("Synthetic Pricing Health refuses a foreign, non-fixture, truncated or unexpected policy stream.");
  }
  const handlers = buildRepricingPolicyProjectionHandlers(pool);
  for (const event of events) await handlers[event.eventType]!(toTransportEvent(event));
}

/** Owned browser/DB fixture inputs only. The real dry-run worker must produce the summary. */
export async function seedSyntheticPricingHealthInputs(
  pool: PgTransactionalPool,
  input: Readonly<{ accountId: string; listingId: string; now?: string; whatIfPortfolios?: boolean }>,
) {
  if (input.whatIfPortfolios) return seedSyntheticWhatIfPortfolios(pool, input);
  return withPgTransaction(pool, async (db) => {
    const now = input.now ?? new Date().toISOString();
    const model = "synthetic-pricing-health-e2e";
    const documentId = "pol_synthetic_pricing_health_e2e";
    const listing = (
      await db.query<{
        catalog_item_id: string;
        product_id: string;
        price_amount: string;
        quantity_cap: number;
      }>(
        `SELECT catalog_catalog_item_id AS catalog_item_id, product_id, price_amount::text, quantity_cap
      FROM pricing_market_listing_inputs WHERE seller_account_id=$1 AND listing_id=$2 AND price_currency_code='USD'`,
        [input.accountId, input.listingId],
      )
    ).rows[0];
    if (!listing || listing.quantity_cap < 1)
      throw new Error("Synthetic Pricing Health needs one owned in-stock USD listing.");
    const existing = await db.query(
      `SELECT 1 FROM pricing_demand_curve_versions WHERE catalog_item_id=$1 AND product_id=$2`,
      [listing.catalog_item_id, listing.product_id],
    );
    if (existing.rows.length) throw new Error("Synthetic Pricing Health refuses to replace an existing curve.");
    await db.query(
      `INSERT INTO platform_policy_documents
    (document_id, policy_key, context_name, schema_summary, status, value, effective_from, created_at, updated_at)
    VALUES ($1, 'pricing.demand-curve', 'pricing', 'synthetic browser fixture', 'active', $2::jsonb, $3, $3, $3)`,
      [documentId, JSON.stringify(DEMAND_CURVE_LAUNCH_POLICY_VALUE), now],
    );
    await db.query(
      `INSERT INTO pricing_demand_curve_versions
    (catalog_item_id, product_id, version, provider_condition, provider_variant, provider_language, fingerprint,
     model_version, policy_revision_id, ladder_method, anchor_condition, exposure_start_reason, sales_coverage,
     supply_status, own_seller_exclusion_applied, built_at, currency_code, fresh_until)
    VALUES ($1, $2, 1, 'Near Mint', 'Normal', 'English', $3, $3, $4, 'synthetic', NULL, 'history-window',
      'synthetic', 'observed', true, $5, 'USD', $6)`,
      [
        listing.catalog_item_id,
        listing.product_id,
        model,
        `${documentId}:${now}`,
        now,
        new Date(Date.parse(now) + DEMAND_CURVE_LAUNCH_POLICY_VALUE.freshForHours * 3_600_000).toISOString(),
      ],
    );
    await db.query(
      `INSERT INTO pricing_demand_curve_points
    (catalog_item_id, product_id, version, percentile, price_amount, buyer_arrival_interval_days,
     competing_seller_count, store_win_share, median_sell_days, qualifying_sale_count, history_capped, hopeless, supply_status)
    VALUES ($1, $2, 1, 50, $3, 7, 0, 1, 7, 30, false, false, 'observed')`,
      [listing.catalog_item_id, listing.product_id, listing.price_amount],
    );
    await db.query(
      `INSERT INTO pricing_forecast_grades
    (goal_id, goal_version, role, forecast_kind, model, horizon_days, closed_on, rules_version, input_version, grade, graded_at)
    VALUES ('fixed-percentile', 1, 'incumbent', 'curve', $1, 21, $2, $3, 'synthetic-browser', $4::jsonb, $5)`,
      [
        model,
        now.slice(0, 10),
        gradingRulesVersion(FORECAST_LEDGER_LAUNCH_POLICY_VALUE),
        JSON.stringify({ count: 30, soldShare: 0.6, expectedShare: 0.7, brier: 0.2, baseRateBrier: 0.24, deciles: [] }),
        now,
      ],
    );
    return {
      expected: {
        modeledValueAmount: applyMoneyRatio(listing.price_amount, listing.quantity_cap, 1, "nearest"),
        // median = ln(2) * 7 / 1; P = 1 - 0.5^(7 / median) = 1 - exp(-1).
        expectedSalesListingCount: 1 - Math.exp(-1),
        expectedSalesValueAmount: ((Math.round(Number(listing.price_amount) * 100) * (1 - Math.exp(-1))) / 100).toFixed(
          2,
        ),
      },
      cleanup: async () => {
        await pool.query("DELETE FROM pricing_forecast_grades WHERE model=$1", [model]);
        await pool.query(
          "DELETE FROM pricing_demand_curve_points WHERE catalog_item_id=$1 AND product_id=$2 AND version=1",
          [listing.catalog_item_id, listing.product_id],
        );
        await pool.query(
          "DELETE FROM pricing_demand_curve_versions WHERE catalog_item_id=$1 AND product_id=$2 AND model_version=$3",
          [listing.catalog_item_id, listing.product_id, model],
        );
        await pool.query("DELETE FROM platform_policy_documents WHERE document_id=$1", [documentId]);
      },
    };
  });
}

/** Isolated projection inputs: no shared verdict curves, grades or catalog identities. */
async function seedSyntheticWhatIfPortfolios(
  pool: PgTransactionalPool,
  input: Readonly<{ accountId: string; now?: string }>,
) {
  const now = input.now ?? new Date().toISOString();
  const identities = [
    { suffix: "a", referenceId: "ref_synthetic_what_if_a", name: "Synthetic Product Line A" },
    { suffix: "b", referenceId: "ref_synthetic_what_if_b", name: "Synthetic Product Line B" },
    { suffix: "none", referenceId: null, name: null },
  ];
  await withPgTransaction(pool, async (db) => {
    for (const { suffix, referenceId, name } of identities) {
      const id = `synthetic_what_if_${suffix}`;
      await db.query(
        `INSERT INTO pricing_catalog_item_inputs
        (catalog_item_id, title, status, product_line_reference_id, product_line_name, product_line_version, updated_at)
        VALUES ($1, 'Synthetic what-if browser item', 'active', $2, $3, $4, $5)`,
        [id, referenceId, name, referenceId ? 1 : null, now],
      );
      await db.query(
        `INSERT INTO pricing_market_listing_inputs
        (listing_id, seller_account_id, catalog_catalog_item_id, product_id, price_amount, price_currency_code,
         quantity_cap, status, updated_at, last_stream_version)
        VALUES ($1, $2, $3, $3, '10.00', 'USD', 1, 'active', $4, 1)`,
        [`lst_${id}`, input.accountId, id, now],
      );
      await db.query(
        `INSERT INTO pricing_demand_curve_versions
        (catalog_item_id, product_id, version, provider_condition, provider_variant, provider_language, fingerprint,
         model_version, policy_revision_id, ladder_method, exposure_start_reason, sales_coverage, supply_status,
         built_at, currency_code, fresh_until)
        VALUES ($1, $1, 1, 'Near Mint', 'Normal', 'English', 'synthetic-what-if-browser', 'synthetic-what-if-browser',
         'synthetic-what-if-browser', 'synthetic', 'history-window', 'synthetic', 'observed', $2, 'USD', $3)`,
        [id, now, new Date(Date.parse(now) + 86400000).toISOString()],
      );
      await db.query(
        `INSERT INTO pricing_demand_curve_points
        (catalog_item_id, product_id, version, percentile, price_amount, buyer_arrival_interval_days,
         competing_seller_count, store_win_share, median_sell_days, qualifying_sale_count, history_capped, hopeless, supply_status)
        VALUES ($1, $1, 1, 25, '8.00', 2, 0, 1, 2, 30, false, false, 'observed'),
               ($1, $1, 1, 75, '12.00', 7, 0, 1, 7, 30, false, false, 'observed')`,
        [id],
      );
    }
  });
  return {
    expected: {
      modeledValueAmount: "30.00",
      expectedSalesListingCount: 3 * (1 - Math.exp(-7 / 4.5)),
      expectedSalesValueAmount: "23.67",
    },
    cleanup: async () => {
      await withPgTransaction(pool, async (db) => {
        for (const { suffix } of identities) {
          const id = `synthetic_what_if_${suffix}`;
          await db.query("DELETE FROM pricing_demand_curve_points WHERE catalog_item_id=$1 AND product_id=$1", [id]);
          await db.query("DELETE FROM pricing_demand_curve_versions WHERE catalog_item_id=$1 AND product_id=$1", [id]);
          await db.query("DELETE FROM pricing_market_listing_inputs WHERE listing_id=$1 AND seller_account_id=$2", [
            `lst_${id}`,
            input.accountId,
          ]);
          await db.query("DELETE FROM pricing_catalog_item_inputs WHERE catalog_item_id=$1", [id]);
        }
      });
    },
  };
}
