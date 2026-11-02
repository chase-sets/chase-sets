import { readFileSync } from "node:fs";
import type { CurvePoint } from "../../../market-estimates/domain/demand-curve/curve";

export type ParityCurve = Readonly<{ currencyCode: string; version: number; points: readonly CurvePoint[] }>;

type FixtureListing = Readonly<{
  listingId: string;
  sku: number;
  curve: string;
  priceScale: number;
  timeScale: number;
  currentPriceAmount: string | null;
  qualifyingSaleCount?: number;
  historyCapped?: boolean;
  floorAmount?: string;
}>;

type FixtureScenario = Readonly<{ currentPriceScale: number; listingIds?: readonly string[] }>;

export type PortfolioScenarioName = "matched" | "boundary-high" | "boundary-low" | "infeasible" | "one-listing";

/** One listing as both the pinned app and Chase Sets receive it. */
export type PortfolioFixtureListing = Readonly<{
  listingId: string;
  sku: number;
  currentPriceAmount: string | null;
  curve: ParityCurve;
  /** A synthetic constraint: the listing never prices below this amount. */
  floorAmount: string | null;
}>;

export const portfolioFixtureFile = "portfolio-parity-fixture.json";

export const portfolioFixtureBytes = readFileSync(new URL(`./${portfolioFixtureFile}`, import.meta.url));

export const portfolioFixture = JSON.parse(portfolioFixtureBytes.toString("utf8")) as Readonly<{
  currencyCode: string;
  listings: readonly FixtureListing[];
  scenarios: Readonly<Record<PortfolioScenarioName, FixtureScenario>>;
  capitalCycle: Readonly<{
    economics: Readonly<{
      costBasisShareOfMarket: number;
      costBasisDiscountPerUnit: number;
      relativeOverhead: number;
      staticOverheadPerUnit: number;
      turnaroundDays: number;
    }>;
  }>;
}>;

const parityCurves = (
  JSON.parse(readFileSync(new URL("./goal-parity-curve.json", import.meta.url), "utf8")) as {
    curves: Readonly<Record<string, ParityCurve>>;
  }
).curves;

/** A parity curve with every price and sell time rescaled; sell times scale through the buyer arrival interval. */
export function rescaledParityCurve(
  listing: Pick<FixtureListing, "curve" | "priceScale" | "timeScale" | "qualifyingSaleCount" | "historyCapped">,
): ParityCurve {
  const curve = parityCurves[listing.curve];
  if (!curve) throw new Error(`No parity curve named ${listing.curve}.`);
  return {
    ...curve,
    points: curve.points.map((point) => ({
      ...point,
      priceAmount: (Number(point.priceAmount) * listing.priceScale).toFixed(2),
      buyerArrivalIntervalDays:
        point.buyerArrivalIntervalDays === null ? null : point.buyerArrivalIntervalDays * listing.timeScale,
      medianSellDays: point.medianSellDays === null ? null : point.medianSellDays * listing.timeScale,
      qualifyingSaleCount: listing.qualifyingSaleCount ?? point.qualifyingSaleCount,
      historyCapped: listing.historyCapped ?? point.historyCapped,
    })),
  };
}

/** The scenario's listings, in fixture order, with current prices rescaled to the cent. */
export function portfolioScenario(name: PortfolioScenarioName): readonly PortfolioFixtureListing[] {
  const scenario = portfolioFixture.scenarios[name];
  return portfolioFixture.listings
    .filter((listing) => scenario.listingIds === undefined || scenario.listingIds.includes(listing.listingId))
    .map((listing) => ({
      listingId: listing.listingId,
      sku: listing.sku,
      currentPriceAmount:
        listing.currentPriceAmount === null
          ? null
          : (Number(listing.currentPriceAmount) * scenario.currentPriceScale).toFixed(2),
      curve: rescaledParityCurve(listing),
      floorAmount: listing.floorAmount ?? null,
    }));
}
