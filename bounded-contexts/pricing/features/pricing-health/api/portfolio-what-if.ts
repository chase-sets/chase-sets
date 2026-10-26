import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { MoneyAmount } from "@chase-sets/primitives/money";
import type { EconomicsServices } from "../../economics/api/services";
import { toEconomicsForPricingGoal, type EconomicsResolution } from "../../economics/domain/resolution";
import { listDemandCurvesAsOf, type DemandCurveWithPoints } from "../../market-estimates/read-model/demand-curve-queries";
import { capitalCycle } from "../../repricing-policies/domain/portfolio/capital-cycle";
import { portfolioHorizonModel, sweepDailyReturnHurdles, type HurdleScenario, type HurdleSweepListing } from "../../repricing-policies/domain/portfolio/preview";
import type { GoalCurve } from "../../repricing-policies/domain/goals/registry";
import { assemblePortfolio } from "../../repricing-policies/domain/portfolio/assemble";
import { readCatalogItemProductLineInputs } from "../../recommendations/read-model/queries";

type ListingRow = Readonly<{
  listing_id: string;
  inventory_item_id: string | null;
  catalog_catalog_item_id: string;
  product_id: string;
  price_amount: string;
  price_currency_code: string | null;
  quantity_cap: number;
}>;

type WhatIfListing = HurdleSweepListing & Readonly<{
  catalogItemId: string;
  productId: string;
  currentPriceAmount: MoneyAmount | null;
  economicsResolution: EconomicsResolution | null;
}>;

export type PricingHealthWhatIfPortfolio = Readonly<{
  key: string;
  label: string;
  productLineReferenceId: string | null;
  listingCount: number;
  currencyCode: string;
  snapshotHash: string | null;
  horizon: Readonly<{
    samples: readonly Readonly<{ horizonDays: number; valueAmount: MoneyAmount }>[];
    kneeDays: number | null;
  }>;
  hurdle: Readonly<{
    scenarios: readonly (HurdleScenario & Readonly<{ dailyReturn: number | null }>)[];
    configuredDailyReturnHurdles: readonly number[];
    best: Readonly<{ dailyReturnHurdle: number; dailyReturn: number; valueAmount: MoneyAmount; waitDays: number | null }> | null;
    valueDeltaAmount: number | null;
    waitDeltaDays: number | null;
  }>;
}>;

export type PricingHealthWhatIf = Readonly<{ portfolios: readonly PricingHealthWhatIfPortfolio[] }>;

/**
 * Pricing Health's only portfolio adapter. It reads the caller's complete
 * active listing set through keyset pages, resolves each immutable input once,
 * then reuses those Economics and curves for the overall and Product Line
 * previews. The adapter never writes, enqueues, or calls a provider.
 */
export function createPricingHealthWhatIfAdapter({
  db,
  economics,
}: Readonly<{ db: PgQueryable; economics: Pick<EconomicsServices, "resolve"> }>) {
  return {
    get: async (accountId: string, capturedAt: string): Promise<PricingHealthWhatIf> => {
      const rows = await assemblePortfolio(async ({ after, limit }) => {
        const result = await db.query<ListingRow>(
          `SELECT listing_id, inventory_item_id, catalog_catalog_item_id, product_id,
                  price_amount::text, price_currency_code, quantity_cap
             FROM pricing_market_listing_inputs
            WHERE seller_account_id = $1 AND status = 'active'
              AND ($2::text IS NULL OR listing_id > $2)
            ORDER BY listing_id ASC LIMIT $3`,
          [accountId, after, limit],
        );
        return result.rows.map((row) => ({ listingId: row.listing_id, row }));
      });
      if (rows.length === 0) return { portfolios: [] };

      const identities = [...new Map(rows.map(({ row }) => [`${row.catalog_catalog_item_id}\u0000${row.product_id}`, {
        catalogItemId: row.catalog_catalog_item_id,
        productId: row.product_id,
      }])).values()];
      const [curves, productLines] = await Promise.all([
        listDemandCurvesAsOf(db, { identities, asOf: capturedAt }),
        readCatalogItemProductLineInputs(db, rows.map(({ row }) => row.catalog_catalog_item_id)),
      ]);
      const curvesByIdentity = new Map(curves.map((curve) => [identityKey(curve), curve]));
      const linesByCatalogItem = new Map(productLines.map((input) => [input.catalogItemId, input.productLine]));
      const prepared = await Promise.all(rows.map(async ({ listingId, row }) => {
        const currency = row.price_currency_code?.trim().toUpperCase() || null;
        const curveRecord = curvesByIdentity.get(`${row.catalog_catalog_item_id}\u0000${row.product_id}`);
        const curve = currency && curveRecord ? toGoalCurve(curveRecord, currency) : null;
        const currentPriceAmount = currency ? (row.price_amount as MoneyAmount) : null;
        const economicsResolution =
          currency && row.inventory_item_id
            ? await economics.resolve({
                accountId,
                scope: { kind: "native-marketplace" },
                catalogItemId: row.catalog_catalog_item_id,
                inventoryItemId: row.inventory_item_id,
                marketUnitPrice: { amount: row.price_amount as MoneyAmount, currency: currency.toLowerCase() },
                quantity: 1,
                effectiveAt: capturedAt,
              })
            : null;
        const economicsForGoal = economicsResolution ? toEconomicsForPricingGoal(economicsResolution) : null;
        return {
          listingId,
          catalogItemId: row.catalog_catalog_item_id,
          productId: row.product_id,
          currentPriceAmount,
          currency,
          curve,
          economicsResolution,
          economics: economicsForGoal,
        } satisfies WhatIfListing;
      }));
      const byLine = new Map<string, WhatIfListing[]>();
      for (const listing of prepared) {
        const ref = linesByCatalogItem.get(listing.catalogItemId)?.referenceId ?? null;
        const key = ref ?? "__none__";
        const bucket = byLine.get(key) ?? [];
        bucket.push(listing);
        byLine.set(key, bucket);
      }
      const portfolios = [
        summarizePortfolio("overall", "Overall portfolio", null, prepared),
        ...[...byLine.entries()]
          .filter(([key]) => key !== "__none__")
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, listings]) => summarizePortfolio(key, linesByCatalogItem.get(listings[0]!.catalogItemId)?.name ?? key, key, listings)),
        ...(byLine.has("__none__") ? [summarizePortfolio("__none__", "No product line", null, byLine.get("__none__")!)] : []),
      ];
      return { portfolios };

      function summarizePortfolio(key: string, label: string, productLineReferenceId: string | null, listings: readonly WhatIfListing[]): PricingHealthWhatIfPortfolio {
        const currency = listings.find((listing) => listing.currency)?.currency ?? "USD";
        const normalized = listings.map((listing) => ({
          listingId: listing.listingId,
          currentPriceAmount: listing.currentPriceAmount,
          curve: listing.curve,
          economics: listing.economics,
        }));
        const horizon = portfolioHorizonModel({ currencyCode: currency, listings: normalized });
        const sweep = sweepDailyReturnHurdles({
          currencyCode: currency,
          listings: normalized.map((listing) => ({ ...listing, economics: listings.find((entry) => entry.listingId === listing.listingId)!.economics })),
        });
        const scenarios = sweep.scenarios.map((scenario) => ({ ...scenario, dailyReturn: scenarioDailyReturn(scenario, listings) }));
        const configured = [...new Set(listings.flatMap((listing) => {
          const hurdle = listing.economics?.dailyReturnHurdle.effectiveValue;
          return hurdle !== undefined && Number.isFinite(hurdle) ? [hurdle] : [];
        }))].sort((left, right) => left - right);
        const best = scenarios
          .filter((scenario) => scenario.dailyReturn !== null && scenario.dailyReturn > 0)
          .sort((left, right) => (right.dailyReturn ?? -Infinity) - (left.dailyReturn ?? -Infinity))[0];
        const configuredScenario =
          configured.length === 0 || scenarios.length === 0
            ? null
            : scenarios.reduce((closest, scenario) =>
                Math.abs(scenario.dailyReturnHurdle - configured[0]!) <
                Math.abs(closest.dailyReturnHurdle - configured[0]!)
                  ? scenario
                  : closest,
              scenarios[0]!);
        return {
          key,
          label,
          productLineReferenceId,
          listingCount: listings.length,
          currencyCode: currency,
          snapshotHash: sweep.snapshotHash,
          horizon: { samples: horizon.samples, kneeDays: horizon.kneeDays },
          hurdle: {
            scenarios,
            configuredDailyReturnHurdles: configured,
            best: best
              ? { dailyReturnHurdle: best.dailyReturnHurdle, dailyReturn: best.dailyReturn!, valueAmount: best.oneCopyValueAmount, waitDays: best.wait?.medianDays ?? null }
              : null,
            valueDeltaAmount: best && configuredScenario ? Number(best.oneCopyValueAmount) - Number(configuredScenario.oneCopyValueAmount) : null,
            waitDeltaDays: best && configuredScenario && best.wait && configuredScenario.wait ? best.wait.medianDays - configuredScenario.wait.medianDays : null,
          },
        };
      }
    },
  };
}

function identityKey(curve: DemandCurveWithPoints): string {
  return `${curve.catalogItemId}\u0000${curve.productId}`;
}

function toGoalCurve(curve: DemandCurveWithPoints, currency: string): GoalCurve {
  return { currencyCode: curve.currencyCode?.toUpperCase() ?? currency, version: curve.version, points: curve.points };
}

function scenarioDailyReturn(scenario: HurdleScenario, listings: readonly WhatIfListing[]): number | null {
  const resolved = listings.filter((listing) => listing.economicsResolution?.kind === "resolved");
  if (resolved.length === 0 || scenario.wait === null) return null;
  const cost = resolved.reduce((sum, listing) => {
    const economics = listing.economicsResolution!;
    if (economics.kind !== "resolved") return sum;
    const facts = economics.economics.facts;
    const market = Number(listing.currentPriceAmount ?? "0");
    return sum + (market * facts.costBasisShareOfMarketBps.effectiveValue) / 10_000 - Number(facts.costBasisDiscountPerUnitAmount.effectiveValue.amount);
  }, 0);
  const turnaround = resolved.reduce((sum, listing) => {
    const economics = listing.economicsResolution!;
    return economics.kind === "resolved" ? sum + economics.economics.facts.turnaroundDays.effectiveValue : sum;
  }, 0) / resolved.length;
  const cycle = capitalCycle(Number(scenario.oneCopyValueAmount), cost, scenario.wait.medianDays, turnaround);
  return Number.isFinite(cycle.dailyReturn) ? cycle.dailyReturn : null;
}

