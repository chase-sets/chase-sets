import { createHash } from "node:crypto";
import {
  centsToMoneyAmount,
  centsToSignedMoneyAmount,
  moneyToCents,
  roundRational,
  type MoneyAmount,
  type SignedMoneyAmount,
} from "@chase-sets/primitives/money";
import {
  pointAtPrice,
  pointAtSellTime,
  readBackAtPrice,
  toMoneyAmount,
  type GoalCurveViews,
  type GoalForecast,
} from "../goals/curve-math";
import {
  goalCurveViews,
  type GoalCurve,
  type GoalCurveFeature,
  type GoalDecision,
  type GoalParameters,
  type GoalUnavailableReason,
} from "../goals/registry";
import { PORTFOLIO_SOLVER_POLICY } from "./policy";
import type { HorizonRange } from "./search";

/** A seller's constraint on one listing: the price it ends at when its goal anchors it at a price. */
export type PortfolioConstraint = Readonly<{
  /** Identifies everything the constraint reads, so a changed constraint changes the plan's snapshot. */
  identity: string;
  apply(priceAmount: MoneyAmount): MoneyAmount;
}>;

/** One listing of an explicit portfolio; a plan values one copy of each. */
export type PortfolioListing = Readonly<{
  listingId: string;
  /** In the portfolio currency; a listing without a positive current price stays out of the baseline. */
  currentPriceAmount: MoneyAmount | null;
  /** Null when no fresh curve in the portfolio currency is served for the listing. */
  curve: GoalCurve | null;
  constraint?: PortfolioConstraint;
}>;

export type PortfolioSolveInput = Readonly<{
  currencyCode: string;
  listings: readonly PortfolioListing[];
  parameters: GoalParameters;
}>;

export type PortfolioPlanStatus = "matched" | "boundary" | "infeasible";

export type PortfolioListingResult = Readonly<{
  listingId: string;
  /** The listing's price under the plan: its decision's selected price, or its current price while held. */
  planPriceAmount: MoneyAmount | null;
  decision: GoalDecision | null;
  /** Why the plan holds the listing instead of pricing it; null when it carries a decision. */
  heldReason: GoalUnavailableReason | null;
}>;

/** One goal's answer across a portfolio: a single target horizon, applied to every listing it can model. */
export type PortfolioPlan = Readonly<{
  /** sha256 of the Goal Version, its parameters, the solver policy and the snapshot: equal inputs, equal id. */
  planId: string;
  /** sha256 of the listing set in listing-id order: current price, constraint identity and curve. */
  snapshotHash: string;
  goalId: string;
  goalVersion: number;
  currencyCode: string;
  parameters: GoalParameters;
  status: PortfolioPlanStatus;
  resolvedHorizonDays: number;
  /** The value the plan aims at: the listed value it holds, or the cash it targets. */
  targetValueAmount: MoneyAmount;
  /** The value at the resolved horizon, summed from the prices the plan lists after every constraint. */
  resolvedValueAmount: MoneyAmount;
  valueDifferenceAmount: SignedMoneyAmount;
  valueToleranceAmount: MoneyAmount;
  /** The lowest and highest value the searched horizons reach. */
  reachableValueRange: Readonly<{ minimumAmount: MoneyAmount; maximumAmount: MoneyAmount }>;
  counts: Readonly<{
    listings: number;
    modeled: number;
    unavailableBaseline: number;
    raised: number;
    lowered: number;
    held: number;
    sparse: number;
    capped: number;
  }>;
  /** Every listing, in listing-id order. */
  listings: readonly PortfolioListingResult[];
}>;

/** A baseline listing ready to price at any horizon; `views` is null while the plan holds it. */
export type PreparedListing = Readonly<{
  listingId: string;
  currentCents: bigint;
  views: GoalCurveViews | null;
  heldReason: GoalUnavailableReason | null;
  constraint: PortfolioConstraint | undefined;
}>;

export type PreparedPortfolio = Readonly<{
  currencyCode: string;
  /** Listings with a positive current price, in listing-id order. */
  baseline: readonly PreparedListing[];
  /** Listings without one, in listing-id order. */
  unpriced: readonly string[];
  modeledCount: number;
  baselineCents: bigint;
  /** The horizons over which a target horizon changes any modeled price. */
  range: HorizonRange;
  snapshotHash: string;
}>;

/** How a goal resolved its portfolio, in cents; the plan prices every listing at `horizonDays`. */
export type PortfolioResolution = Readonly<{
  status: PortfolioPlanStatus;
  horizonDays: number;
  targetCents: bigint;
  resolvedCents: bigint;
  toleranceCents: bigint;
  reachableCents: Readonly<{ minimum: bigint; maximum: bigint }>;
}>;

/** A baseline listing priced at one horizon: its constrained anchor, or its current price while held. */
export type PricedListing = Readonly<{
  listing: PreparedListing;
  anchorAmount: MoneyAmount | null;
  selectedCents: bigint;
}>;

const compareIds = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Validates and orders a portfolio. A repeated listing is a caller defect and
 * throws, as does a curve in another currency. A baseline listing that the
 * curve cannot price is held at its current price with the reason its goal
 * would give alone, so it moves neither the baseline nor any candidate value.
 */
export function preparePortfolio(
  input: PortfolioSolveInput,
  requiredCurveFeatures: readonly GoalCurveFeature[],
): PreparedPortfolio {
  const currencyCode = input.currencyCode.toUpperCase();
  const listings = [...input.listings].sort((left, right) => compareIds(left.listingId, right.listingId));
  const repeated = [
    ...new Set(
      listings.filter((listing, index) => listings[index - 1]?.listingId === listing.listingId).map((l) => l.listingId),
    ),
  ];
  if (repeated.length > 0) throw new Error(`A portfolio lists each listing once; repeated: ${repeated.join(", ")}.`);
  const baseline: PreparedListing[] = [];
  const unpriced: string[] = [];
  for (const listing of listings) {
    if (listing.curve !== null && listing.curve.currencyCode.toUpperCase() !== currencyCode)
      throw new Error(
        `Portfolio listing ${listing.listingId} has a ${listing.curve.currencyCode} curve in a ${currencyCode} portfolio.`,
      );
    const currentCents = listing.currentPriceAmount === null ? 0n : moneyToCents(listing.currentPriceAmount);
    if (currentCents <= 0n) {
      unpriced.push(listing.listingId);
      continue;
    }
    const curve = listing.curve === null ? null : goalCurveViews(listing.curve.points, requiredCurveFeatures);
    const views = curve === null || "kind" in curve || curve.bySellTime.length === 0 ? null : curve;
    baseline.push({
      listingId: listing.listingId,
      currentCents,
      views,
      heldReason:
        curve === null
          ? "curve-empty"
          : "kind" in curve
            ? curve.reason
            : views === null
              ? "curve-feature-missing:medianSellDays"
              : null,
      constraint: listing.constraint,
    });
  }
  const modeled = baseline.flatMap((listing) => (listing.views === null ? [] : [listing.views.bySellTime]));
  const observedMaximum = Math.max(0, ...modeled.map((points) => points.at(-1)!.medianSellDays));
  return {
    currencyCode,
    baseline,
    unpriced,
    modeledCount: modeled.length,
    baselineCents: baseline.reduce((sum, listing) => sum + listing.currentCents, 0n),
    range:
      observedMaximum === 0
        ? PORTFOLIO_SOLVER_POLICY.unobservedHorizonRange
        : {
            minimumDays: Math.max(
              PORTFOLIO_SOLVER_POLICY.minimumHorizonDays,
              Math.min(...modeled.map((points) => points[0]!.medianSellDays)),
            ),
            maximumDays: observedMaximum,
          },
    snapshotHash: sha256({
      currencyCode,
      listings: listings.map((listing) => ({
        listingId: listing.listingId,
        currentPriceAmount: listing.currentPriceAmount,
        constraint: listing.constraint?.identity ?? null,
        curve: listing.curve,
      })),
    }),
  };
}

export function priceAtHorizon(listing: PreparedListing, horizonDays: number): PricedListing {
  if (listing.views === null) return { listing, anchorAmount: null, selectedCents: listing.currentCents };
  const anchorAmount = toMoneyAmount(pointAtSellTime(listing.views.bySellTime, horizonDays).price);
  const selected = listing.constraint === undefined ? anchorAmount : listing.constraint.apply(anchorAmount);
  return { listing, anchorAmount, selectedCents: moneyToCents(selected) };
}

/** The forecast at a priced listing's selected price, as its decision reads it back; null while held. */
export function forecastAtSelectedPrice(priced: PricedListing): GoalForecast | null {
  return priced.listing.views === null
    ? null
    : readBackAtPrice(priced.listing.views, Number(priced.selectedCents) / 100).forecast;
}

/** A value within this many cents of the target matches it. */
export function valueToleranceCents(targetCents: bigint): bigint {
  const relative = roundRational(targetCents * BigInt(PORTFOLIO_SOLVER_POLICY.valueToleranceBps), 10_000n, "nearest");
  const minimum = BigInt(PORTFOLIO_SOLVER_POLICY.minimumValueToleranceCents);
  return relative > minimum ? relative : minimum;
}

/** Prices every listing at the resolved horizon and counts what the plan moves, as the app's portfolio plan does. */
export function buildPortfolioPlan(
  goal: Readonly<{ id: string; version: number }>,
  parameters: GoalParameters,
  portfolio: PreparedPortfolio,
  resolution: PortfolioResolution,
): PortfolioPlan {
  const counts = {
    listings: portfolio.baseline.length + portfolio.unpriced.length,
    modeled: portfolio.modeledCount,
    unavailableBaseline: portfolio.unpriced.length,
    raised: 0,
    lowered: 0,
    held: 0,
    sparse: 0,
    capped: 0,
  };
  const results: PortfolioListingResult[] = portfolio.unpriced.map((listingId) => ({
    listingId,
    planPriceAmount: null,
    decision: null,
    heldReason: "current-price-missing",
  }));
  for (const listing of portfolio.baseline) {
    const priced = priceAtHorizon(listing, resolution.horizonDays);
    if (priced.selectedCents > listing.currentCents) counts.raised += 1;
    else if (priced.selectedCents < listing.currentCents) counts.lowered += 1;
    else counts.held += 1;
    const planPriceAmount = centsToMoneyAmount(priced.selectedCents);
    if (listing.views === null || priced.anchorAmount === null) {
      results.push({ listingId: listing.listingId, planPriceAmount, decision: null, heldReason: listing.heldReason });
      continue;
    }
    const price = Number(priced.selectedCents) / 100;
    const finalPoint = pointAtPrice(listing.views, price);
    if (
      finalPoint.qualifyingSaleCount === null ||
      finalPoint.qualifyingSaleCount < PORTFOLIO_SOLVER_POLICY.sparseQualifyingSaleCount
    )
      counts.sparse += 1;
    if (finalPoint.historyCapped) counts.capped += 1;
    results.push({
      listingId: listing.listingId,
      planPriceAmount,
      decision: {
        kind: "decision",
        selectedPriceAmount: planPriceAmount,
        unconstrainedPriceAmount: priced.anchorAmount,
        ...readBackAtPrice(listing.views, price),
        unprofitable: false,
        rationale: { parameters, dailyReturnHurdle: null, netProceeds: null },
      },
      heldReason: null,
    });
  }
  results.sort((left, right) => compareIds(left.listingId, right.listingId));
  return {
    planId: sha256({
      goalId: goal.id,
      goalVersion: goal.version,
      parameters,
      policy: PORTFOLIO_SOLVER_POLICY,
      snapshotHash: portfolio.snapshotHash,
    }),
    snapshotHash: portfolio.snapshotHash,
    goalId: goal.id,
    goalVersion: goal.version,
    currencyCode: portfolio.currencyCode,
    parameters,
    status: resolution.status,
    resolvedHorizonDays: resolution.horizonDays,
    targetValueAmount: centsToMoneyAmount(resolution.targetCents),
    resolvedValueAmount: centsToMoneyAmount(resolution.resolvedCents),
    valueDifferenceAmount: centsToSignedMoneyAmount(resolution.resolvedCents - resolution.targetCents),
    valueToleranceAmount: centsToMoneyAmount(resolution.toleranceCents),
    reachableValueRange: {
      minimumAmount: centsToMoneyAmount(resolution.reachableCents.minimum),
      maximumAmount: centsToMoneyAmount(resolution.reachableCents.maximum),
    },
    counts,
    listings: results,
  };
}

/** sha256 of a value's canonical JSON. */
export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** JSON with object keys in code-unit order, so equal values hash equally whatever order built them; cents may be bigint. */
function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareIds(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
