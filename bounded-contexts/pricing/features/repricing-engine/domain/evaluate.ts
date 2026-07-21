import { centsToMoneyAmount, moneyToCents, roundRational, signedMoneyToCents } from "@chase-sets/primitives/money";
import type {
  RepricingRule,
  RepricingRuleCondition,
  RepricingRuleDirective,
} from "../../repricing-policies/domain/domain";
import { resolveRepricingFloorAmount } from "../../repricing-policies/domain/floor-resolution";

export type RepricingInputState = "present" | "stale" | "absent";

export type RepricingMarketInputSnapshot = Readonly<{
  catalogItemId: string;
  productId: string;
  capturedAt: string;
  hardAskOutlierPriceRatio: number;
  marketEstimate: Readonly<{ amount: string; freshUntil: string }> | null;
  lastSold: Readonly<{ amount: string; freshUntil: string }> | null;
  competingAsks: readonly Readonly<{
    listingId: string;
    sellerAccountId: string;
    amount: string;
    pricingMode: "hard" | "derived";
  }>[];
}>;

export type RepricingListingEvaluationInput = Readonly<{
  listingId: string;
  sellerAccountId: string;
  currentPriceAmount: string;
  quantityCap: number;
  categoryIds: readonly string[];
  grading: "graded" | "raw" | null;
  createdAt: string | null;
  costBasisAmount: string | null;
  rules: readonly RepricingRule[];
}>;

export type RepricingClampTrace = Readonly<{
  floor: boolean;
  ceiling: boolean;
  maxMove: boolean;
}>;

export type RepricingAnchorTrace = Readonly<{
  source: "market-estimate" | "lowest-competing-ask" | "comp-percentile" | "last-sold";
  amount: string;
  stratum: "market-estimate" | "hard-ask" | "last-sold";
  contributingListingCount: number;
}>;

export type RepricingListingEvaluation = Readonly<{
  listingId: string;
  currentPriceAmount: string;
  targetPriceAmount: string | null;
  ruleIndex: number;
  anchor: RepricingAnchorTrace | null;
  exhaustedAnchors: readonly Readonly<{ source: string; state: RepricingInputState }>[];
  clamps: RepricingClampTrace;
  tolerance: RepricingRuleDirective["tolerance"];
  flags: readonly ("floor-binding" | "ceiling-binding" | "max-move-binding")[];
  action: "update-price" | "hold" | "pause" | "notify-only";
  skipReason:
    | "within-tolerance"
    | "anchor-chain-exhausted"
    | "terminal-hold"
    | "terminal-pause"
    | "terminal-notify-only"
    | null;
}>;

/**
 * The single evaluation path used by both live product rounds and dry-run
 * previews. It is intentionally pure: a product round captures inputs once,
 * calls this function for every assigned listing, then decides whether live
 * command emission is enabled.
 */
export function evaluateRepricingListing(
  listing: RepricingListingEvaluationInput,
  snapshot: RepricingMarketInputSnapshot,
): RepricingListingEvaluation {
  const competingHardAsks = filterCompetingHardAskOutliers(
    snapshot.competingAsks.filter(
      (ask) => ask.pricingMode === "hard" && ask.sellerAccountId !== listing.sellerAccountId,
    ),
    snapshot,
  );
  const ruleIndex = listing.rules.findIndex((rule) =>
    rule.conditions.every((condition) => conditionMatches(condition, listing, competingHardAsks.length, snapshot)),
  );
  const matchedRuleIndex = ruleIndex >= 0 ? ruleIndex : listing.rules.length - 1;
  const rule = listing.rules[matchedRuleIndex];
  if (!rule) {
    throw new Error("Repricing policy must include an unconditional default rule.");
  }

  const resolved = resolveAnchor(rule.directive, snapshot, competingHardAsks);
  if (!resolved.anchor) {
    return evaluateTerminal(listing, matchedRuleIndex, rule.directive, resolved.exhaustedAnchors);
  }

  return evaluateTarget(
    listing,
    matchedRuleIndex,
    rule.directive,
    resolved.anchor.amount,
    resolved.anchor,
    resolved.exhaustedAnchors,
  );
}

function conditionMatches(
  condition: RepricingRuleCondition,
  listing: RepricingListingEvaluationInput,
  competingListingCount: number,
  snapshot: RepricingMarketInputSnapshot,
): boolean {
  switch (condition.type) {
    case "category":
      return listing.categoryIds.includes(condition.categoryId);
    case "item-grading":
      return listing.grading === condition.grading;
    case "quantity-at-least":
      return listing.quantityCap >= condition.quantity;
    case "listing-age-at-least":
      return (
        listing.createdAt !== null &&
        Date.parse(snapshot.capturedAt) - Date.parse(listing.createdAt) >= condition.days * 24 * 60 * 60 * 1_000
      );
    case "cost-basis-present":
      return listing.costBasisAmount !== null;
    case "cost-basis-absent":
      return listing.costBasisAmount === null;
    case "competing-listing-count-at-least":
      return competingListingCount >= condition.count;
    case "schedule-window": {
      const now = new Date(snapshot.capturedAt);
      const time = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
      return (
        condition.daysOfWeek.includes(now.getUTCDay()) &&
        (condition.startTime <= condition.endTime
          ? time >= condition.startTime && time < condition.endTime
          : time >= condition.startTime || time < condition.endTime)
      );
    }
  }
}

function resolveAnchor(
  directive: RepricingRuleDirective,
  snapshot: RepricingMarketInputSnapshot,
  hardAsks: readonly RepricingMarketInputSnapshot["competingAsks"][number][],
): Readonly<{
  anchor: RepricingAnchorTrace | null;
  exhaustedAnchors: readonly Readonly<{ source: string; state: RepricingInputState }>[];
}> {
  const exhaustedAnchors: Array<{ source: string; state: RepricingInputState }> = [];

  for (const candidate of directive.anchorChain) {
    switch (candidate.source) {
      case "market-estimate": {
        const estimate = snapshot.marketEstimate;
        const state: RepricingInputState =
          estimate === null
            ? "absent"
            : Date.parse(estimate.freshUntil) < Date.parse(snapshot.capturedAt)
              ? "stale"
              : "present";
        if (state === "present") {
          return {
            anchor: {
              source: candidate.source,
              amount: estimate!.amount,
              stratum: "market-estimate",
              contributingListingCount: 0,
            },
            exhaustedAnchors,
          };
        }
        exhaustedAnchors.push({ source: candidate.source, state });
        break;
      }
      case "lowest-competing-ask": {
        if (hardAsks.length > 0) {
          return {
            anchor: {
              source: candidate.source,
              amount: centsToMoneyAmount(
                hardAsks.reduce(
                  (lowest, ask) => min(lowest, moneyToCents(ask.amount)),
                  moneyToCents(hardAsks[0]!.amount),
                ),
              ),
              stratum: "hard-ask",
              contributingListingCount: hardAsks.length,
            },
            exhaustedAnchors,
          };
        }
        exhaustedAnchors.push({ source: candidate.source, state: "absent" });
        break;
      }
      case "comp-percentile": {
        if (hardAsks.length > 0) {
          const ordered = hardAsks.map((ask) => moneyToCents(ask.amount)).sort(compareBigInt);
          const index = Math.min(
            ordered.length - 1,
            Math.max(0, Math.ceil((candidate.percentile / 100) * ordered.length) - 1),
          );
          return {
            anchor: {
              source: candidate.source,
              amount: centsToMoneyAmount(ordered[index]!),
              stratum: "hard-ask",
              contributingListingCount: hardAsks.length,
            },
            exhaustedAnchors,
          };
        }
        exhaustedAnchors.push({ source: candidate.source, state: "absent" });
        break;
      }
      case "last-sold": {
        const lastSold = snapshot.lastSold;
        const state: RepricingInputState =
          lastSold === null
            ? "absent"
            : Date.parse(lastSold.freshUntil) < Date.parse(snapshot.capturedAt)
              ? "stale"
              : "present";
        if (state === "present") {
          return {
            anchor: {
              source: candidate.source,
              amount: lastSold!.amount,
              stratum: "last-sold",
              contributingListingCount: 0,
            },
            exhaustedAnchors,
          };
        }
        exhaustedAnchors.push({ source: candidate.source, state });
        break;
      }
    }
  }

  return { anchor: null, exhaustedAnchors };
}

function evaluateTerminal(
  listing: RepricingListingEvaluationInput,
  ruleIndex: number,
  directive: RepricingRuleDirective,
  exhaustedAnchors: readonly Readonly<{ source: string; state: RepricingInputState }>[],
): RepricingListingEvaluation {
  const base = {
    listingId: listing.listingId,
    currentPriceAmount: listing.currentPriceAmount,
    ruleIndex,
    anchor: null,
    exhaustedAnchors,
    clamps: { floor: false, ceiling: false, maxMove: false },
    tolerance: directive.tolerance,
    flags: [] as const,
  };

  switch (directive.terminal.kind) {
    case "fallback-price":
      return evaluateTarget(listing, ruleIndex, directive, directive.terminal.amount, null, exhaustedAnchors);
    case "price-at-floor":
      return evaluateTarget(
        listing,
        ruleIndex,
        directive,
        resolveRepricingFloorAmount(directive.floor, listing.costBasisAmount),
        null,
        exhaustedAnchors,
      );
    case "pause":
      return { ...base, targetPriceAmount: null, action: "pause", skipReason: "terminal-pause" };
    case "notify-only":
      return { ...base, targetPriceAmount: null, action: "notify-only", skipReason: "terminal-notify-only" };
    case "hold":
      return { ...base, targetPriceAmount: null, action: "hold", skipReason: "terminal-hold" };
  }
}

function evaluateTarget(
  listing: RepricingListingEvaluationInput,
  ruleIndex: number,
  directive: RepricingRuleDirective,
  baseAmount: string,
  anchor: RepricingAnchorTrace | null,
  exhaustedAnchors: readonly Readonly<{ source: string; state: RepricingInputState }>[],
): RepricingListingEvaluation {
  const current = moneyToCents(listing.currentPriceAmount);
  const anchorCents = moneyToCents(baseAmount);
  let target = applyOffset(anchorCents, directive);
  target = applyRounding(target, directive);

  const floor = moneyToCents(resolveRepricingFloorAmount(directive.floor, listing.costBasisAmount));
  const ceiling = resolveCeiling(anchorCents, directive);
  const clamps = { floor: false, ceiling: false, maxMove: false };

  // The movement guard constrains the proposal first. Seller-authored
  // floor/ceiling clamps are terminal and no later adjustment may escape.
  if (directive.maxMovePercent !== null) {
    const moveBps = Math.round(directive.maxMovePercent * 100);
    const maxDown = current - roundRational(current * BigInt(moveBps), 10_000n, "nearest");
    const maxUp = current + roundRational(current * BigInt(moveBps), 10_000n, "nearest");
    const bounded = max(maxDown, min(maxUp, target));
    if (bounded !== target) {
      clamps.maxMove = true;
      target = bounded;
    }
  }
  if (target < floor) {
    target = floor;
    clamps.floor = true;
  }
  if (ceiling !== null && target > ceiling) {
    target = ceiling;
    clamps.ceiling = true;
  }

  const tolerance =
    directive.tolerance.mode === "absolute"
      ? moneyToCents(directive.tolerance.amount)
      : roundRational(current * BigInt(Math.round(directive.tolerance.percent * 100)), 10_000n, "nearest");
  const delta = target >= current ? target - current : current - target;
  const flags = [
    ...(clamps.floor ? (["floor-binding"] as const) : []),
    ...(clamps.ceiling ? (["ceiling-binding"] as const) : []),
    ...(clamps.maxMove ? (["max-move-binding"] as const) : []),
  ];

  return {
    listingId: listing.listingId,
    currentPriceAmount: centsToMoneyAmount(current),
    targetPriceAmount: centsToMoneyAmount(target),
    ruleIndex,
    anchor,
    exhaustedAnchors,
    clamps,
    tolerance: directive.tolerance,
    flags,
    action: delta <= tolerance ? "hold" : "update-price",
    skipReason: delta <= tolerance ? "within-tolerance" : null,
  };
}

function filterCompetingHardAskOutliers(
  asks: readonly RepricingMarketInputSnapshot["competingAsks"][number][],
  snapshot: RepricingMarketInputSnapshot,
): readonly RepricingMarketInputSnapshot["competingAsks"][number][] {
  if (asks.length < 2) {
    return asks;
  }
  const ordered = asks.map((ask) => moneyToCents(ask.amount)).sort(compareBigInt);
  const midpoint = ordered.length / 2;
  const median =
    ordered.length % 2 === 1
      ? ordered[Math.floor(midpoint)]!
      : roundRational(ordered[midpoint - 1]! + ordered[midpoint]!, 2n, "nearest");
  const core = snapshot.marketEstimate ? moneyToCents(snapshot.marketEstimate.amount) : median;
  const ratioHundredths = BigInt(Math.round(snapshot.hardAskOutlierPriceRatio * 100));
  const lower = roundRational(core * 100n, ratioHundredths, "nearest");
  const upper = roundRational(core * ratioHundredths, 100n, "nearest");
  const filtered = asks.filter((ask) => {
    const amount = moneyToCents(ask.amount);
    return amount >= lower && amount <= upper;
  });
  return filtered.length > 0 ? filtered : asks;
}

function applyOffset(anchor: bigint, directive: RepricingRuleDirective): bigint {
  if (directive.offset.mode === "absolute") {
    return max(0n, anchor + signedMoneyToCents(directive.offset.amount));
  }
  const bps = Math.round(directive.offset.percent * 100);
  const magnitude = roundRational(anchor * BigInt(Math.abs(bps)), 10_000n, "nearest");
  return max(0n, bps < 0 ? anchor - magnitude : anchor + magnitude);
}

function applyRounding(target: bigint, directive: RepricingRuleDirective): bigint {
  switch (directive.rounding.mode) {
    case "none":
      return target;
    case "charm":
      return target < 99n ? 99n : ((target + 1n) / 100n) * 100n - 1n;
    case "increment": {
      const increment = moneyToCents(directive.rounding.incrementAmount);
      return roundRational(target, increment, "nearest") * increment;
    }
  }
}

function resolveCeiling(anchor: bigint, directive: RepricingRuleDirective): bigint | null {
  if (directive.ceiling === null) {
    return null;
  }
  if (directive.ceiling.mode === "absolute") {
    return moneyToCents(directive.ceiling.amount);
  }
  const bps = Math.round(directive.ceiling.percent * 100);
  return anchor + roundRational(anchor * BigInt(bps), 10_000n, "nearest");
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function max(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
