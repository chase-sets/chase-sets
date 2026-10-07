import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { generateSyntheticProviderObservationFixture } from "../../../price-signals/tests/fixtures/provider-observations/generate-fixture";
import { effectiveSaleAmountExact } from "../../../price-signals/domain/effective-sale-price";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../../../price-signals/domain/provider-observation-policy";
import { buildConditionLadder } from "../../domain/condition-ladder/condition-ladder";
import { DEMAND_CURVE_LAUNCH_POLICY_VALUE as policy } from "../../domain/demand-curve-policy";

/** Invoke from the pinned read-only app checkout via APP_ROOT; never queries the provider. */
export async function generateAppOracle(appRoot: string) {
  const base = resolve(appRoot, "app/features/pricing");
  const source = await import(pathToFileURL(resolve(base, "algorithms/getSuggestedPriceFromLatestSales.ts")).href);
  const policySource = await import(pathToFileURL(resolve(base, "domain/pricingPolicy.ts")).href);
  const fixture = generateSyntheticProviderObservationFixture();
  const capture = fixture.capture;
  const asOf = capture.header.captureStartedAt;
  const raw = capture.sales.map((sale) => ({
    condition: sale.providerCondition,
    price: effectiveSaleAmountExact(
      { quantity: sale.quantity, unitPrice: Number(sale.unitPrice), orderShipping: Number(sale.orderShipping) },
      Number(PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.freeShippingThreshold),
    ),
    soldAt: sale.soldAt,
  }));
  const ladder = buildConditionLadder({
    sales: raw,
    siblingMarketPrices: new Map(),
    targetCondition: "Near Mint",
    asOf,
    policy,
  });
  const scaled = raw.map((sale) => ({ ...sale, price: sale.price * ladder.multipliers.get(sale.condition)! }));
  const sorted = scaled.map((sale) => sale.price).sort((a, b) => a - b);
  const continuousPercentile = (fraction: number) => {
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
  };
  const low = continuousPercentile(0.05);
  const high = continuousPercentile(0.95);
  const sales = scaled
    .filter((sale) => sale.price >= low && sale.price <= high)
    .map((sale) => ({ price: sale.price, quantity: 1, timestamp: Date.parse(sale.soldAt) }));
  const listings = capture.askDepth.map((ask) => ({
    condition: ask.providerCondition,
    price: Number(ask.deliveredAmount) * ladder.multipliers.get(ask.providerCondition)!,
    shippingCost: 0,
    sellerId: String(ask.anonymousCaptureSellerOrdinal),
    sellerKey: String(ask.anonymousCaptureSellerOrdinal),
    listingId: 0,
  }));
  const points = source.getTimeDecayedPercentileWeightedSuggestedPrice(sales, {
    halfLifeDays: policy.decayHalfLifeDays,
    percentiles: policy.percentiles,
    asOfTimestamp: Date.parse(asOf),
    supplyObservation: { status: "observed", listings },
  });
  // No correction: the pinned toPricingCurve branch has the same positive-value filter,
  // medianSellDays formula and percentile ordering as the checked-out source.
  const curve = policySource.toPricingCurve(
    points.map(
      (point: {
        percentile: number;
        price: number;
        historicalSalesVelocityMs?: number;
        estimatedTimeToSellMs?: number;
        salesCount?: number;
        historyCapped?: boolean;
        listingsCount?: number;
        storeWinShare?: number;
        supplyStatus?: string;
      }) => ({
        percentile: point.percentile,
        suggestedPrice: point.price,
        historicalSalesVelocityDays: point.historicalSalesVelocityMs
          ? point.historicalSalesVelocityMs / 86_400_000
          : undefined,
        estimatedTimeToSellDays: point.estimatedTimeToSellMs ? point.estimatedTimeToSellMs / 86_400_000 : undefined,
        salesCount: point.salesCount,
        historyCapped: point.historyCapped,
        listingsCount: point.listingsCount,
        storeWinShare: point.storeWinShare,
        supplyStatus: point.supplyStatus,
      }),
    ),
  );
  return {
    status: "app-recorded-synthetic-not-live",
    sourceCommit: "bdeffa0190be035084abccb464716aaaa2541a59",
    asOf,
    modelVersion: "pooled-supply-v1",
    targetCondition: "Near Mint",
    ladderMethod: ladder.method,
    points: curve.map(
      (point: {
        percentile: number;
        price: number;
        buyerIntervalDays?: number;
        listingsCount?: number;
        estimatedMedianSellDays?: number;
        qualifyingSalesCount?: number;
      }) => ({
        percentile: point.percentile,
        price: point.price,
        buyerIntervalDays: point.buyerIntervalDays,
        sellers: point.listingsCount,
        medianSellDays: point.estimatedMedianSellDays,
        hopeless: (point.estimatedMedianSellDays ?? 0) > policy.hopelessHorizonDays,
        qualifyingSaleCount: point.qualifyingSalesCount,
      }),
    ),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.env.APP_ROOT;
  if (!root) throw new Error("APP_ROOT must point to the pinned read-only app checkout.");
  const output = new URL("./app-recorded-ninety-day-oracle.json", import.meta.url);
  writeFileSync(output, `${JSON.stringify(await generateAppOracle(root), null, 2)}\n`);
}
