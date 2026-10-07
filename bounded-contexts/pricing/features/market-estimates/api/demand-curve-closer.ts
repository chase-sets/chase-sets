import type { PgTransactionalPool, PostgresEventStore } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { effectiveSaleAmountExact } from "../../price-signals/domain/effective-sale-price";
import { providerObservationPolicy } from "../../price-signals/domain/provider-observation-policy";
import {
  listProviderListingAskGroups,
  listProviderListingSnapshots,
  listProviderSaleEvidence,
  listProviderWeeklySaleBuckets,
  latestProviderMarketCapture,
} from "../../price-signals/read-model/provider-observation-queries";
import { marketEstimatePolicy } from "../domain/estimate-policy";
import { marketStatHygienePolicy } from "../../market-trades/domain/stat-hygiene-policy";
import { demandCurvePolicy, type DemandCurvePolicyValue } from "../domain/demand-curve-policy";
import { calculateDemandCurve, type CurveSupply } from "../domain/demand-curve/curve";
import {
  createCurveBuilderRegistry,
  type CurveBuilderDefinition,
  type CurveSale,
} from "../domain/demand-curve/curve-builder-registry";
import { listDemandCurveCandidates } from "../read-model/demand-curve-candidates";
import {
  curveFingerprint,
  demandCurveModelVersion,
  getDemandCurveCursor,
  saveDemandCurveCursor,
  supersedeDemandCurve,
  writeDemandCurve,
} from "../read-model/demand-curve-writes";

const DAY = 86_400_000;
const PROVIDER = "tcgplayer";

export function createDemandCurveCloser(
  deps: Readonly<{
    pool: PgTransactionalPool;
    eventStore: PostgresEventStore;
    policies: PolicyRuntime;
  }>,
) {
  const db = deps.pool;
  const additionalBuilders = createCurveBuilderRegistry();
  const registerCurveBuilder = (builder: CurveBuilderDefinition): void => {
    if (builder.id === "provider-sales" || builder.id === "platform-trades")
      throw new Error("Curve builder id/version must be unique and nonempty.");
    additionalBuilders.registerCurveBuilder(builder);
  };
  const createPassRegistry = (policy: DemandCurvePolicyValue) =>
    createCurveBuilderRegistry([
      {
        id: "provider-sales",
        version: "1",
        weightSource: "external-comp",
        load: async (identity, window) => {
          const evidence = await listProviderSaleEvidence(db, {
            providerKey: PROVIDER,
            catalogItemId: identity.catalogItemId,
            soldSince: window.since,
            soldUntil: new Date(Date.parse(window.asOf) + 1).toISOString(),
          });
          const relevant = evidence.filter(
            (sale) =>
              sale.providerVariant === identity.variant &&
              sale.providerLanguage === identity.language &&
              sale.listingType !== null &&
              policy.conditionOrder.includes(sale.providerCondition) &&
              effectiveSaleAmountExact(
                {
                  quantity: sale.quantity,
                  unitPrice: Number(sale.unitPrice),
                  orderShipping: Number(sale.orderShipping),
                },
                window.freeShippingThreshold,
              ) > 0,
          );
          const expandedCount = relevant.reduce((count, sale) => count + sale.maxObservedTupleMultiplicity, 0);
          relevant.sort(
            (left, right) =>
              (expandedCount > window.salesLimit ? Date.parse(right.soldAt) - Date.parse(left.soldAt) : 0) ||
              left.saleFingerprint.localeCompare(right.saleFingerprint),
          );
          return relevant
            .flatMap((sale): CurveSale[] => {
              const amount = effectiveSaleAmountExact(
                {
                  quantity: sale.quantity,
                  unitPrice: Number(sale.unitPrice),
                  orderShipping: Number(sale.orderShipping),
                },
                window.freeShippingThreshold,
              );
              return Array.from({ length: sale.maxObservedTupleMultiplicity }, () => ({
                price: amount,
                soldAt: sale.soldAt,
                condition: sale.providerCondition,
                variant: sale.providerVariant,
                language: sale.providerLanguage,
                source: "external-comp",
                coverage: sale.coverage === "complete-capture" ? "complete" : "truncated",
              }));
            })
            .slice(0, window.salesLimit);
        },
      },
      {
        id: "platform-trades",
        version: "1",
        weightSource: "platform-trade",
        load: async (identity, window) => {
          const result = await db.query<{
            unit_price_amount: string;
            sold_at: Date;
            verified: boolean;
            buyer_account_id: string;
          }>(
            `SELECT chosen.unit_price_amount,chosen.sold_at,chosen.verified,chosen.buyer_account_id
           FROM (
             SELECT DISTINCT ON (trade.buyer_account_id,trade.seller_account_id)
                    trade.unit_price_amount::text,trade.sold_at,trade.verified,trade.buyer_account_id,
                    trade.order_id,trade.line_id
             FROM pricing_market_trades AS trade
             WHERE trade.catalog_catalog_item_id=$1 AND trade.product_id=$2 AND trade.excluded=false
               AND trade.sold_at >= $3 AND trade.sold_at <= $4 AND trade.currency_code = 'USD'
             ORDER BY trade.buyer_account_id,trade.seller_account_id,trade.sold_at DESC,trade.order_id DESC,trade.line_id DESC
           ) AS chosen
           ORDER BY sold_at DESC, order_id DESC, line_id DESC LIMIT $5`,
            [identity.catalogItemId, identity.productId, window.since, window.asOf, window.salesLimit],
          );
          return result.rows.map(
            (row): CurveSale => ({
              price: Number(row.unit_price_amount),
              soldAt: new Date(row.sold_at).toISOString(),
              condition: identity.condition,
              variant: identity.variant,
              language: identity.language,
              source: row.verified ? "platform-verified-trade" : "platform-trade",
              coverage: "complete",
              participantId: row.buyer_account_id,
            }),
          );
        },
      },
      ...additionalBuilders.definitions(),
    ]);

  const runDemandCurveCloser = async (params: Readonly<{ now?: string; limit?: number }> = {}) => {
    const now = params.now ?? new Date().toISOString();
    const limit = params.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Demand-curve pass limit must be 1-500.");
    const [curveResolution, estimate, hygiene, observation] = await Promise.all([
      deps.policies.resolvePolicy(demandCurvePolicy),
      deps.policies.resolvePolicy(marketEstimatePolicy),
      deps.policies.resolvePolicy(marketStatHygienePolicy),
      deps.policies.resolvePolicy(providerObservationPolicy),
    ]);
    const policy = curveResolution.value;
    const registry = createPassRegistry(policy);
    const since = new Date(Date.parse(now) - policy.historyDays * DAY).toISOString();
    const after = await getDemandCurveCursor(db);
    const page = await listDemandCurveCandidates(db, { since, asOf: now, limit, after });
    let built = 0,
      unchanged = 0,
      superseded = 0,
      supplyUnscoped = 0,
      unknownCondition = 0;
    for (const candidate of page.candidates) {
      const identity = {
        catalogItemId: candidate.catalogItemId,
        productId: candidate.productId,
        condition: candidate.condition,
        variant: candidate.variant,
        language: candidate.language,
      };
      if (!policy.conditionOrder.includes(candidate.condition)) {
        if (await supersedeDemandCurve(db, identity, now)) superseded++;
        unknownCondition++;
        continue;
      }
      const [weekly, capture] = await Promise.all([
        listProviderWeeklySaleBuckets(db, {
          providerKey: PROVIDER,
          catalogItemId: candidate.catalogItemId,
          weekStartSince: since,
          asOf: now,
        }),
        latestProviderMarketCapture(db, { providerKey: PROVIDER, catalogItemId: candidate.catalogItemId, asOf: now }),
      ]);
      const bound = new Set(
        weekly
          .filter(
            (row) =>
              row.providerCondition === candidate.condition &&
              row.providerVariant === candidate.variant &&
              row.providerLanguage === candidate.language,
          )
          .map((row) => row.catalogProductKey),
      );
      if (bound.size !== 1 || !bound.has(candidate.productId)) {
        if (await supersedeDemandCurve(db, identity, now)) superseded++;
        continue;
      }
      const siblingPrices = new Map(
        weekly
          .filter(
            (row) =>
              row.providerVariant === candidate.variant &&
              row.providerLanguage === candidate.language &&
              row.providerMarketAmount !== null,
          )
          .map((row): [string, number] => [row.providerCondition, Number(row.providerMarketAmount)]),
      );
      const sales = await registry.load(identity, {
        since,
        asOf: now,
        freeShippingThreshold: Number(observation.value.freeShippingThreshold),
        salesLimit: policy.salesLimit,
      });
      const snapshots = await listProviderListingSnapshots(db, {
        providerKey: PROVIDER,
        catalogItemId: candidate.catalogItemId,
        observedSince: since,
      });
      const captureSnapshots = snapshots.filter((row) => row.captureId === capture?.captureId);
      let supply: CurveSupply = {
        status: capture?.endpoints.listings.status === "disabled" ? "disabled" : "unavailable",
        asks: [],
        ownSellerExclusionApplied: capture ? await ownSellerExclusion(db, capture.captureId) : null,
      };
      if (capture?.endpoints.listings.status === "observed") {
        const asks = await listProviderListingAskGroups(db, {
          providerKey: PROVIDER,
          catalogItemId: candidate.catalogItemId,
          captureId: capture.captureId,
        });
        const matching =
          captureSnapshots.every(
            (row) => row.providerVariant === candidate.variant && row.providerLanguage === candidate.language,
          ) &&
          (captureSnapshots.length > 0 || asks.length === 0);
        if (matching && capture.endpoints.listings.coverage === "complete") {
          supply = {
            status: asks.every((ask) => ask.coverage === "complete") ? "observed" : "truncated",
            asks: asks.map((ask) => ({
              condition: ask.providerCondition,
              deliveredAmount: Number(ask.deliveredAmount),
              sellerOrdinal: ask.anonymousCaptureSellerOrdinal,
            })),
            ownSellerExclusionApplied: supply.ownSellerExclusionApplied,
          };
        } else {
          supplyUnscoped++;
          supply = { ...supply, status: matching ? "truncated" : "unavailable" };
        }
      }
      const result = calculateDemandCurve({
        sales,
        siblingMarketPrices: siblingPrices,
        targetCondition: candidate.condition,
        asOf: now,
        supply,
        policy,
        sourceWeights: estimate.value.sourceWeights,
        minimumEffectiveSampleSize: estimate.value.minimumEffectiveSampleSize,
        maximumParticipantWeightShare: estimate.value.maximumParticipantWeightShare,
        minimumSample: hygiene.value.minimumTradeSample,
        trimPercentile: hygiene.value.outlierTrimPercentile,
      });
      if (!result) {
        if (await supersedeDemandCurve(db, identity, now)) superseded++;
        continue;
      }
      const fingerprint = curveFingerprint({
        sales,
        weekly,
        snapshots: captureSnapshots,
        capture,
        supply,
        policy,
        policyRevision: [curveResolution.documentId, curveResolution.effectiveFrom],
        estimateRevision: [estimate.documentId, estimate.effectiveFrom],
        hygieneRevision: [hygiene.documentId, hygiene.effectiveFrom],
        observationRevision: [observation.documentId, observation.effectiveFrom],
        builders: registry.definitions().map(({ id, version }) => [id, version]),
        modelVersion: demandCurveModelVersion,
      });
      const written = await writeDemandCurve(deps.pool, deps.eventStore, {
        catalogItemId: candidate.catalogItemId,
        productId: candidate.productId,
        providerCondition: candidate.condition,
        providerVariant: candidate.variant,
        providerLanguage: candidate.language,
        fingerprint,
        policyRevisionId: curveResolution.documentId
          ? `${curveResolution.documentId}:${curveResolution.effectiveFrom}`
          : "fallback",
        ladderMethod: result.ladder.method,
        anchorCondition: result.ladder.anchorCondition,
        exposureStartReason: result.exposureStartReason,
        salesCoverage: result.salesCoverage,
        supplyStatus: supply.status,
        ownSellerExclusionApplied: supply.ownSellerExclusionApplied,
        points: result.points,
        builtAt: now,
      });
      if (written === "built") built++;
      else unchanged++;
    }
    const last = page.candidates.at(-1);
    const next = last && page.candidates.length === limit ? last : null;
    if (!(await saveDemandCurveCursor(db, after, next, now)))
      throw new Error("Demand-curve cursor changed concurrently.");
    return {
      candidatesConsidered: page.candidates.length,
      built,
      unchanged,
      superseded,
      unmapped: page.unmapped,
      supplyUnscoped,
      unknownCondition,
    };
  };
  return { runDemandCurveCloser, registerCurveBuilder };
}

async function ownSellerExclusion(db: PgTransactionalPool, captureId: string): Promise<boolean | null> {
  const row = (
    await db.query<{ own_seller_exclusion_applied: boolean }>(
      `SELECT capture.own_seller_exclusion_applied FROM pricing_external_market_captures AS capture WHERE capture.capture_id=$1`,
      [captureId],
    )
  ).rows[0];
  return row?.own_seller_exclusion_applied ?? null;
}
