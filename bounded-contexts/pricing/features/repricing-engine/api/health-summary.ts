import type { EconomicsResolution } from "../../economics/domain/resolution";
import { toEconomicsForPricingGoal } from "../../economics/domain/resolution";
import { capitalCycle } from "../../repricing-policies/domain/portfolio/capital-cycle";
import {
  netProceedsAtPrice,
  readBackAtPrice,
  toGoalCurveViews,
} from "../../repricing-policies/domain/goals/curve-math";
import type { DemandCurvePolicyValue } from "../../market-estimates/domain/demand-curve-policy";
import { saleProbability } from "../../forecast-ledger/domain/grading";
import type { DemandCurveWithPoints } from "../../market-estimates/read-model/demand-curve-queries";
import type { RepricingPolicyListingTrace } from "../domain/fact";
import type { RepricingRoundListing } from "../read-model/queries";

export type RepricingHealthReason =
  | "no-curve"
  | "stale-curve"
  | "currency-mismatch"
  | "supply-unavailable"
  | "no-currency"
  | "zero-quantity";

export type RepricingHealthContribution = Readonly<{
  listingId: string;
  quantity: number;
  currentPriceAmount: string;
  effectivePriceAmount: string;
  currencyCode: string | null;
  modeled: Readonly<{
    medianDays: number;
    curveVersion: number;
    builtAt: string;
    policyRevisionId: string;
    forecastStatus: "interpolated" | "lower-bound" | "upper-bound";
  }> | null;
  modeledReason: RepricingHealthReason | null;
  economics: Readonly<{
    resolution: "resolved";
    unitCostAmount: string;
    turnaroundDays: number;
    dailyReturnHurdle: number;
    sourceKinds: readonly string[];
    netProceedsAmount: string;
  }> | null;
  economicsReason: string | null;
  risk: "hopeless" | "slow" | "none" | "unknown";
}>;

export type RepricingHealthCurrencySummary = Readonly<{
  listedValueAmount: string;
  modeledValueAmount: string;
  modeledValueDeltaAmount: string;
  coverage: Readonly<{
    listingCount: number;
    listingTotal: number;
    unitCount: number;
    unitTotal: number;
    listingRatio: number;
    unitRatio: number;
    missingReasons: Readonly<Record<string, number>>;
    boundStatusCount: number;
  }>;
  curveAge: Readonly<{ newestAgeDays: number | null; oldestAgeDays: number | null; staleCount: number }>;
  expectedWait: Readonly<{ medianDays: number | null; p90Days: number | null }>;
  expectedSales: Readonly<{ listingCount: number; valueAmount: string }>;
  valueAtRisk: Readonly<{
    hopeless: Readonly<{ listingCount: number; unitCount: number; valueAmount: string }>;
    slow: Readonly<{ listingCount: number; unitCount: number; valueAmount: string }>;
    unknownPolicyListingCount: number;
  }>;
  profitPerDay: Readonly<{
    value: number | null;
    cycleDays: number | null;
    economicsListingCount: number;
    unavailableReason: string | null;
    economicsUnavailableReasons: Readonly<Record<string, number>>;
    costBasisSourceKinds: Readonly<Record<string, number>>;
  }>;
  capitalTurn: Readonly<{
    value: number | null;
    cycleDays: number | null;
    dailyReturnHurdle: number | null;
    dailyReturnHurdleSourceKinds: Readonly<Record<string, number>>;
    unavailableReason: string | null;
  }>;
}>;

export type RepricingHealthSummary = Readonly<{
  capturedAt: string;
  population: Readonly<{ listingCount: number; unitCount: number }>;
  currencies: Readonly<Record<string, RepricingHealthCurrencySummary>>;
  uncategorized: Readonly<{ listingCount: number; unitCount: number; reasons: Readonly<Record<string, number>> }>;
}>;

type StoredPolicy = Readonly<{ revisionId: string; value: DemandCurvePolicyValue }>;
type HealthEconomics = Readonly<{ resolution: EconomicsResolution; marketUnitPriceAmount: string }>;

export function buildHealthContributions(
  listings: readonly RepricingRoundListing[],
  traces: readonly RepricingPolicyListingTrace[],
  curves: ReadonlyMap<string, DemandCurveWithPoints>,
  policies: ReadonlyMap<string, StoredPolicy>,
  capturedAt: string,
  resolveEconomics: (listing: RepricingRoundListing) => Promise<HealthEconomics>,
): Promise<readonly RepricingHealthContribution[]> {
  const traceById = new Map(traces.map((trace) => [trace.listingId, trace]));
  return Promise.all(
    listings.map(async (listing) => {
      const trace = traceById.get(listing.listingId)!;
      const effectivePriceAmount =
        trace.outcome === "changed" && trace.targetPriceAmount !== null
          ? trace.targetPriceAmount
          : trace.currentPriceAmount;
      const currencyCode = listing.priceCurrencyCode?.trim().toUpperCase() || null;
      const base = {
        listingId: listing.listingId,
        quantity: listing.quantityCap,
        currentPriceAmount: listing.priceAmount,
        effectivePriceAmount,
        currencyCode,
      };
      if (!currencyCode)
        return {
          ...base,
          modeled: null,
          modeledReason: "no-currency" as const,
          economics: null,
          economicsReason: null,
          risk: "unknown" as const,
        };
      if (listing.quantityCap <= 0)
        return {
          ...base,
          modeled: null,
          modeledReason: "zero-quantity" as const,
          economics: null,
          economicsReason: null,
          risk: "unknown" as const,
        };
      const curve = curves.get(JSON.stringify([listing.catalogItemId, listing.productId]));
      if (!curve)
        return {
          ...base,
          modeled: null,
          modeledReason: "no-curve" as const,
          economics: null,
          economicsReason: null,
          risk: "unknown" as const,
        };
      if (!curve.currencyCode || curve.currencyCode.toUpperCase() !== currencyCode)
        return {
          ...base,
          modeled: null,
          modeledReason: "currency-mismatch" as const,
          economics: null,
          economicsReason: null,
          risk: "unknown" as const,
        };
      if (!curve.freshUntil || Date.parse(curve.freshUntil) <= Date.parse(capturedAt))
        return {
          ...base,
          modeled: null,
          modeledReason: "stale-curve" as const,
          economics: null,
          economicsReason: null,
          risk: "unknown" as const,
        };
      const views = toGoalCurveViews(curve.points);
      const price = Number(effectivePriceAmount);
      const readBack = views && Number.isFinite(price) ? readBackAtPrice(views, price) : null;
      if (
        !readBack ||
        readBack.forecast.status === "unavailable" ||
        readBack.forecast.medianSellDays === null ||
        !Number.isFinite(readBack.forecast.medianSellDays) ||
        readBack.forecast.medianSellDays <= 0
      )
        return {
          ...base,
          modeled: null,
          modeledReason: "supply-unavailable" as const,
          economics: null,
          economicsReason: null,
          risk: "unknown" as const,
        };
      const medianDays = readBack.forecast.medianSellDays;
      const policy = policies.get(curve.policyRevisionId);
      const risk = policy
        ? medianDays > policy.value.hopelessHorizonDays
          ? "hopeless"
          : medianDays > policy.value.historyDays
            ? "slow"
            : "none"
        : "unknown";
      let economics: RepricingHealthContribution["economics"] = null;
      let economicsReason: string | null = null;
      try {
        const { resolution, marketUnitPriceAmount } = await resolveEconomics(listing);
        if (resolution.kind === "resolved") {
          const goalEconomics = toEconomicsForPricingGoal(resolution);
          const facts = resolution.economics.facts;
          const unitCost =
            (Number(marketUnitPriceAmount) * facts.costBasisShareOfMarketBps.effectiveValue) / 10_000 -
            Number(facts.costBasisDiscountPerUnitAmount.effectiveValue.amount);
          economics = {
            resolution: "resolved",
            unitCostAmount: unitCost.toFixed(2),
            turnaroundDays: facts.turnaroundDays.effectiveValue,
            dailyReturnHurdle: facts.dailyReturnHurdle.effectiveValue,
            sourceKinds: [
              facts.costBasisShareOfMarketBps.source.kind,
              facts.costBasisDiscountPerUnitAmount.source.kind,
              facts.turnaroundDays.source.kind,
              facts.dailyReturnHurdle.source.kind,
            ],
            netProceedsAmount:
              goalEconomics.availability === "resolved" ? netProceedsAtPrice(price, goalEconomics).toFixed(2) : "0.00",
          };
        } else economicsReason = resolution.reason;
      } catch {
        economicsReason = "provider-unavailable";
      }
      return {
        ...base,
        modeled: {
          medianDays,
          curveVersion: curve.version,
          builtAt: curve.builtAt,
          policyRevisionId: curve.policyRevisionId,
          forecastStatus: readBack.forecast.status,
        },
        modeledReason: null,
        economics,
        economicsReason,
        risk,
      };
    }),
  );
}

export function summarizeHealth(
  contributions: readonly RepricingHealthContribution[],
  capturedAt: string,
): RepricingHealthSummary {
  const population = {
    listingCount: contributions.length,
    unitCount: contributions.reduce((sum, item) => sum + Math.max(0, item.quantity), 0),
  };
  const grouped = new Map<string, RepricingHealthContribution[]>();
  const uncategorizedReasons: Record<string, number> = {};
  for (const contribution of contributions) {
    if (!contribution.currencyCode) {
      uncategorizedReasons[contribution.modeledReason ?? "no-currency"] =
        (uncategorizedReasons[contribution.modeledReason ?? "no-currency"] ?? 0) + 1;
      continue;
    }
    const items = grouped.get(contribution.currencyCode) ?? [];
    items.push(contribution);
    grouped.set(contribution.currencyCode, items);
  }
  const currencies = Object.fromEntries(
    [...grouped]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, items]) => [currency, summarizeCurrency(items, capturedAt)]),
  );
  return {
    capturedAt,
    population,
    currencies,
    uncategorized: {
      listingCount: contributions.filter((item) => !item.currencyCode).length,
      unitCount: contributions
        .filter((item) => !item.currencyCode)
        .reduce((sum, item) => sum + Math.max(0, item.quantity), 0),
      reasons: uncategorizedReasons,
    },
  };
}

function summarizeCurrency(
  items: readonly RepricingHealthContribution[],
  capturedAt: string,
): RepricingHealthCurrencySummary {
  // Summary totals are aggregates, so they may exceed the bounded single-money
  // value accepted by the primitives package. Keep the display contract while
  // formatting the aggregate directly.
  const money = (cents: number) => {
    const amount = cents / 100;
    if (!Number.isFinite(amount)) return "0.00";
    const formatted = amount.toFixed(2);
    return formatted === "-0.00" ? "0.00" : formatted;
  };
  const units = items.reduce((sum, item) => sum + Math.max(0, item.quantity), 0);
  const listed = items.reduce((sum, item) => sum + Math.max(0, item.quantity) * Number(item.currentPriceAmount), 0);
  const modeled = items.reduce((sum, item) => sum + Math.max(0, item.quantity) * Number(item.effectivePriceAmount), 0);
  const modeledItems = items.filter((item) => item.modeled !== null);
  const reasons: Record<string, number> = {};
  for (const item of items)
    if (item.modeledReason) reasons[item.modeledReason] = (reasons[item.modeledReason] ?? 0) + 1;
  const quantile = (values: readonly { value: number; quantity: number; listingId: string }[], fraction: number) => {
    if (!values.length) return null;
    const ordered = [...values].sort((a, b) => a.value - b.value || a.listingId.localeCompare(b.listingId));
    const target = fraction * ordered.reduce((sum, item) => sum + Math.max(0, item.quantity), 0);
    let seen = 0;
    for (const item of ordered) {
      seen += Math.max(0, item.quantity);
      if (seen >= target) return item.value;
    }
    return ordered.at(-1)!.value;
  };
  const waits = modeledItems.map((item) => ({
    value: item.modeled!.medianDays,
    quantity: item.quantity,
    listingId: item.listingId,
  }));
  const expectedSales = modeledItems.reduce((sum, item) => sum + saleProbability(item.modeled!.medianDays, 7), 0);
  const expectedSaleValue = modeledItems.reduce(
    (sum, item) => sum + Number(item.effectivePriceAmount) * saleProbability(item.modeled!.medianDays, 7),
    0,
  );
  const risk = (kind: "hopeless" | "slow") => items.filter((item) => item.risk === kind);
  const riskValue = (kind: "hopeless" | "slow") =>
    risk(kind).reduce((sum, item) => sum + item.quantity * Number(item.effectivePriceAmount), 0);
  const economicsItems = modeledItems.filter((item) => item.economics !== null);
  const net = economicsItems.reduce((sum, item) => sum + item.quantity * Number(item.economics!.netProceedsAmount), 0);
  const cost = economicsItems.reduce((sum, item) => sum + item.quantity * Number(item.economics!.unitCostAmount), 0);
  const wait = quantile(
    economicsItems.map((item) => ({
      value: item.modeled!.medianDays,
      quantity: item.quantity,
      listingId: item.listingId,
    })),
    0.5,
  );
  const turnaround = quantile(
    economicsItems.map((item) => ({
      value: item.economics!.turnaroundDays,
      quantity: item.quantity,
      listingId: item.listingId,
    })),
    0.5,
  );
  const cycle = wait === null || turnaround === null ? null : capitalCycle(net, cost, wait, turnaround);
  const sourceKinds: Record<string, number> = {};
  const hurdleSources: Record<string, number> = {};
  const economicsUnavailableReasons: Record<string, number> = {};
  for (const item of modeledItems) {
    if (item.economicsReason)
      economicsUnavailableReasons[item.economicsReason] = (economicsUnavailableReasons[item.economicsReason] ?? 0) + 1;
  }
  for (const item of economicsItems)
    for (const source of item.economics!.sourceKinds) sourceKinds[source] = (sourceKinds[source] ?? 0) + 1;
  for (const item of economicsItems) {
    const source = item.economics!.sourceKinds.at(-1)!;
    hurdleSources[source] = (hurdleSources[source] ?? 0) + 1;
  }
  const curves = modeledItems
    .map((item) => Date.parse(capturedAt) - Date.parse(item.modeled!.builtAt))
    .filter(Number.isFinite)
    .map((ms) => ms / 86_400_000);
  const capitalTurnUnavailableReason =
    economicsItems.length === 0
      ? "no-economics"
      : cycle === null || cycle.cycleDays <= 0
        ? "non-positive-cycle"
        : net <= 0
          ? "non-positive-net-proceeds"
          : cost <= 0
            ? "non-positive-cost"
            : null;
  return {
    listedValueAmount: money(listed * 100),
    modeledValueAmount: money(modeled * 100),
    modeledValueDeltaAmount: money((modeled - listed) * 100),
    coverage: {
      listingCount: modeledItems.length,
      listingTotal: items.length,
      unitCount: modeledItems.reduce((sum, item) => sum + Math.max(0, item.quantity), 0),
      unitTotal: units,
      listingRatio: items.length ? modeledItems.length / items.length : 0,
      unitRatio: units ? modeledItems.reduce((sum, item) => sum + Math.max(0, item.quantity), 0) / units : 0,
      missingReasons: reasons,
      boundStatusCount: modeledItems.filter((item) => item.modeled!.forecastStatus !== "interpolated").length,
    },
    curveAge: {
      newestAgeDays: curves.length ? Math.min(...curves) : null,
      oldestAgeDays: curves.length ? Math.max(...curves) : null,
      staleCount: items.filter((item) => item.modeledReason === "stale-curve").length,
    },
    expectedWait: { medianDays: quantile(waits, 0.5), p90Days: quantile(waits, 0.9) },
    expectedSales: { listingCount: expectedSales, valueAmount: money(expectedSaleValue * 100) },
    valueAtRisk: {
      hopeless: {
        listingCount: risk("hopeless").length,
        unitCount: risk("hopeless").reduce((sum, item) => sum + item.quantity, 0),
        valueAmount: money(riskValue("hopeless") * 100),
      },
      slow: {
        listingCount: risk("slow").length,
        unitCount: risk("slow").reduce((sum, item) => sum + item.quantity, 0),
        valueAmount: money(riskValue("slow") * 100),
      },
      unknownPolicyListingCount: modeledItems.filter((item) => item.risk === "unknown").length,
    },
    profitPerDay: {
      value: cycle && cycle.cycleDays > 0 ? cycle.profitPerDay : null,
      cycleDays: cycle?.cycleDays ?? null,
      economicsListingCount: economicsItems.length,
      unavailableReason:
        economicsItems.length === 0
          ? modeledItems.length
            ? "no-economics"
            : "no-modeled-listings"
          : cycle && cycle.cycleDays <= 0
            ? "non-positive-cycle"
            : null,
      economicsUnavailableReasons,
      costBasisSourceKinds: sourceKinds,
    },
    capitalTurn: {
      value: cycle && Number.isFinite(cycle.dailyReturn) ? cycle.dailyReturn : null,
      cycleDays: cycle?.cycleDays ?? null,
      dailyReturnHurdle: quantile(
        economicsItems.map((item) => ({
          value: item.economics!.dailyReturnHurdle,
          quantity: item.quantity,
          listingId: item.listingId,
        })),
        0.5,
      ),
      dailyReturnHurdleSourceKinds: hurdleSources,
      unavailableReason: capitalTurnUnavailableReason,
    },
  };
}
