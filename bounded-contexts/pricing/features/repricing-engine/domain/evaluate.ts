import {
  centsToMoneyAmount,
  moneyToCents,
  roundRational,
  signedMoneyToCents,
  tryMoneyToCents,
  type MoneyAmount,
} from "@chase-sets/primitives/money";
import type { EconomicsForPricingGoal } from "../../economics/domain/resolution";
import type { CurvePoint } from "../../market-estimates/domain/demand-curve/curve";
import {
  resolvePricingGoal,
  resolveRepricingGuardrail,
  type RepricingAnchor,
  type RepricingRule,
  type RepricingRuleCondition,
  type RepricingRuleDirective,
} from "../../repricing-policies/domain/domain";
import { resolveRepricingFloorAmount } from "../../repricing-policies/domain/floor-resolution";
import {
  netProceedsAtPrice,
  readBackAtPrice,
  toGoalCurveViews,
  type GoalCurveViews,
  type GoalForecast,
} from "../../repricing-policies/domain/goals/curve-math";
import type {
  GoalCurve,
  GoalCurveFeature,
  PricingGoalDefinition,
} from "../../repricing-policies/domain/goals/registry";
import {
  sha256,
  type PortfolioConstraint,
  type PortfolioListingResult,
} from "../../repricing-policies/domain/portfolio/portfolio";
import type {
  GuardrailContext,
  GuardrailCurveSummary,
  GuardrailDefinition,
} from "../../repricing-policies/domain/guardrails/registry";
import { filterCompetingAskOutliers } from "./competing-ask-outliers";

export type RepricingInputState = "present" | "stale" | "absent" | "currency-incomplete" | "currency-mismatch";

/** The product's Demand Curve served at the capture instant, with its ordered points. */
export type RepricingDemandCurveInput = Readonly<{
  version: number;
  currencyCode: string | null;
  freshUntil: string | null;
  points: readonly CurvePoint[];
}>;

/** Economics captured for a listing whose matched chain requires it; a listing without an inventory item is unavailable without a resolve. */
export type RepricingListingEconomics =
  | EconomicsForPricingGoal
  | Readonly<{ availability: "unavailable"; reason: "inventory-item-missing" }>;

export type RepricingMarketInputSnapshot = Readonly<{
  catalogItemId: string;
  productId: string;
  capturedAt: string;
  hardAskOutlierPriceRatio: number;
  marketEstimate: Readonly<{ amount: string; currencyCode?: string | null; freshUntil: string }> | null;
  lastSold: Readonly<{ amount: string; currencyCode?: string | null; freshUntil: string }> | null;
  competingAsks: readonly Readonly<{
    listingId: string;
    sellerAccountId: string;
    amount: string;
    currencyCode?: string | null;
    pricingMode: "hard" | "derived";
  }>[];
  demandCurve: RepricingDemandCurveInput | null;
  economics: RepricingListingEconomics | null;
}>;

export type RepricingListingEvaluationInput = Readonly<{
  listingId: string;
  sellerAccountId: string;
  currentPriceAmount: string;
  currentPriceCurrencyCode?: string | null;
  currentPriceSourceVersion?: number | null;
  quantityCap: number;
  categoryIds: readonly string[];
  grading: "graded" | "raw" | null;
  createdAt: string | null;
  costBasisAmount: string | null;
  costBasisCurrencyCode?: string | null;
  rules: readonly RepricingRule[];
}>;

export type RepricingClampTrace = Readonly<{
  floor: boolean;
  ceiling: boolean;
  maxMove: boolean;
  evidenceFloor?: boolean;
}>;

/** A curve-objective anchor's goal, read back at the evaluation's final price. */
export type RepricingGoalTrace = Readonly<{
  goalId: string;
  goalVersion: number;
  curveVersion: number;
  equivalentPercentile: number;
  forecastMedianSellDays: number | null;
  forecastStatus: GoalForecast["status"];
  unprofitable: boolean;
}>;

export type RepricingAnchorTrace = Readonly<{
  source: "market-estimate" | "lowest-competing-ask" | "comp-percentile" | "last-sold" | "curve-objective";
  amount: string;
  stratum: "market-estimate" | "hard-ask" | "any-ask" | "last-sold" | "curve-objective";
  contributingListingCount: number;
  goal?: RepricingGoalTrace;
}>;

export type RepricingExhaustedAnchor = Readonly<{
  source: string;
  state: RepricingInputState;
  reason?: "economics-unavailable" | "goal-retired" | `curve-feature-missing:${GoalCurveFeature}`;
}>;

export type RepricingListingEvaluation = Readonly<{
  listingId: string;
  currentPriceAmount: string;
  targetPriceAmount: string | null;
  ruleIndex: number;
  anchor: RepricingAnchorTrace | null;
  exhaustedAnchors: readonly RepricingExhaustedAnchor[];
  clamps: RepricingClampTrace;
  tolerance: RepricingRuleDirective["tolerance"];
  flags: readonly (
    | "floor-binding"
    | "ceiling-binding"
    | "max-move-binding"
    | "band-binding"
    | "evidence-floor-binding"
  )[];
  action: "update-price" | "hold" | "pause" | "notify-only" | "no-reprice";
  skipReason:
    | "within-tolerance"
    | "anchor-chain-exhausted"
    | "terminal-hold"
    | "terminal-pause"
    | "terminal-notify-only"
    | "currency-input-incomplete-or-mismatched"
    | "hopeless-forecast-hold"
    | null;
  /** The round's Portfolio Plan this listing belongs to, whether the plan priced or held it. */
  portfolioPlanId?: string;
}>;

/** A listing's share of a round's Portfolio Plan: the plan, the anchor it governs, and the listing's result. */
export type RepricingPortfolioAssignment = Readonly<{
  planId: string;
  anchorIndex: number;
  result: PortfolioListingResult;
}>;

/**
 * The single evaluation path used by both live product rounds and dry-run
 * previews. It is intentionally pure: a product round captures inputs once,
 * calls this function for every assigned listing, then decides whether live
 * command emission is enabled. A round's Portfolio Plan, when the listing
 * belongs to one, supplies the anchor at the plan's anchor index; without one
 * a portfolio goal decides the listing as a one-listing portfolio.
 */
export function evaluateRepricingListing(
  listing: RepricingListingEvaluationInput,
  snapshot: RepricingMarketInputSnapshot,
  shadowAnchorIndex?: number,
  portfolio?: RepricingPortfolioAssignment,
): RepricingListingEvaluation {
  const evaluation = evaluateMatchedListing(listing, snapshot, shadowAnchorIndex, portfolio);
  return portfolio === undefined ? evaluation : { ...evaluation, portfolioPlanId: portfolio.planId };
}

function evaluateMatchedListing(
  listing: RepricingListingEvaluationInput,
  snapshot: RepricingMarketInputSnapshot,
  shadowAnchorIndex: number | undefined,
  portfolio: RepricingPortfolioAssignment | undefined,
): RepricingListingEvaluation {
  const match = matchRepricingRule(listing, snapshot);
  if (!match) {
    return noReprice(listing, 0, listing.rules[0]?.directive);
  }
  const { listing: compatibleListing, ruleIndex, rule, competingHardAsks } = match;

  const resolved = resolveAnchor(
    rule.directive,
    snapshot,
    competingHardAsks,
    compatibleListing,
    shadowAnchorIndex,
    portfolio,
  );
  if (resolved.exhaustedAnchors.some(isCurrencyExhaustion)) {
    return noReprice(compatibleListing, ruleIndex, rule.directive, resolved.exhaustedAnchors);
  }
  if (!resolved.anchor) {
    return evaluateTerminal(compatibleListing, ruleIndex, rule.directive, snapshot, resolved.exhaustedAnchors);
  }

  return evaluateTarget(compatibleListing, ruleIndex, rule.directive, snapshot, {
    ...resolved,
    baseAmount: resolved.anchor.amount,
  });
}

/**
 * The listing's first-match rule, or null when the listing's own currency
 * inputs make it a named no-reprice. Pure over the same captured inputs, so
 * the page loader reads the matched chain before the evaluation runs.
 */
export function matchRepricingRule(
  listing: RepricingListingEvaluationInput,
  snapshot: RepricingMarketInputSnapshot,
): Readonly<{
  listing: RepricingListingEvaluationInput & Readonly<{ currentPriceCurrencyCode: string }>;
  ruleIndex: number;
  rule: RepricingRule;
  competingHardAsks: readonly RepricingMarketInputSnapshot["competingAsks"][number][];
}> | null {
  const listingCurrencyCode = listing.currentPriceCurrencyCode?.trim().toUpperCase() ?? null;
  const costBasisCurrencyCode = listing.costBasisCurrencyCode?.trim().toUpperCase() ?? null;
  const ruleCurrencyCodes = listing.rules.map((rule) => rule.directive.currencyCode?.trim().toUpperCase() ?? null);
  if (
    !listingCurrencyCode ||
    !/^[A-Z]{3}$/.test(listingCurrencyCode) ||
    !listing.currentPriceSourceVersion ||
    ruleCurrencyCodes.some((currencyCode) => currencyCode === null || currencyCode !== listingCurrencyCode) ||
    (listing.costBasisAmount === null) !== (costBasisCurrencyCode === null) ||
    (listing.costBasisAmount !== null && costBasisCurrencyCode !== listingCurrencyCode)
  ) {
    return null;
  }
  const compatibleListing = {
    ...listing,
    currentPriceCurrencyCode: listingCurrencyCode,
    costBasisCurrencyCode,
  };
  const competingHardAsks = filterCompetingAskOutliers(
    snapshot.competingAsks.filter(
      (ask) =>
        ask.pricingMode === "hard" &&
        ask.sellerAccountId !== listing.sellerAccountId &&
        ask.currencyCode === listingCurrencyCode,
    ),
    (ask) => moneyToCents(ask.amount),
    snapshot.marketEstimate?.currencyCode === listingCurrencyCode
      ? tryMoneyToCents(snapshot.marketEstimate.amount)
      : null,
    snapshot.hardAskOutlierPriceRatio,
  );
  const ruleIndex = listing.rules.findIndex((rule) =>
    rule.conditions.every((condition) =>
      conditionMatches(condition, compatibleListing, competingHardAsks.length, snapshot),
    ),
  );
  const matchedRuleIndex = ruleIndex >= 0 ? ruleIndex : listing.rules.length - 1;
  const rule = listing.rules[matchedRuleIndex];
  if (!rule) {
    throw new Error("Repricing policy must include an unconditional default rule.");
  }
  return { listing: compatibleListing, ruleIndex: matchedRuleIndex, rule, competingHardAsks };
}

/** Where a listing's matched chain reaches a portfolio goal, with what a round's plan needs to price it there. */
export type RepricingPortfolioReach = Readonly<{
  anchorIndex: number;
  goal: PricingGoalDefinition;
  parameters: Readonly<Record<string, number>>;
  currencyCode: string;
  currentPriceAmount: MoneyAmount;
  /** The Demand Curve when its evidence is present, else null and the plan holds the listing. */
  curve: GoalCurve | null;
  /** Prices the listing at the anchor through every stage after it, so a plan sums the prices the round lists. */
  constraint: PortfolioConstraint;
}>;

/**
 * The first selectable portfolio goal anchor in the listing's matched chain,
 * when every anchor before it is exhausted, so that a plan is what anchors the
 * listing; null otherwise. Pure over the same captured inputs as the
 * evaluation, and identifies the constraint by everything its stages read
 * except the capture instant.
 */
export function reachPortfolioAnchor(
  listing: RepricingListingEvaluationInput,
  snapshot: RepricingMarketInputSnapshot,
): RepricingPortfolioReach | null {
  // Rules without a portfolio goal never pay for a second rule match.
  if (!listing.rules.some((rule) => rule.directive.anchorChain.some(isPortfolioAnchor))) return null;
  const match = matchRepricingRule(listing, snapshot);
  if (!match) return null;
  const { listing: compatibleListing, ruleIndex, rule, competingHardAsks } = match;
  const { anchorChain } = rule.directive;
  const anchorIndex = anchorChain.findIndex(isPortfolioAnchor);
  if (anchorIndex < 0) return null;
  const earlier = resolveAnchor(
    { ...rule.directive, anchorChain: anchorChain.slice(0, anchorIndex) },
    snapshot,
    competingHardAsks,
    compatibleListing,
  );
  if (earlier.anchor !== null || earlier.exhaustedAnchors.some(isCurrencyExhaustion)) return null;
  const candidate = anchorChain[anchorIndex] as Extract<RepricingAnchor, { source: "curve-objective" }>;
  const currencyCode = compatibleListing.currentPriceCurrencyCode;
  const currentCents = moneyToCents(compatibleListing.currentPriceAmount);
  const currentPriceAmount = centsToMoneyAmount(currentCents);
  const curve = snapshot.demandCurve;
  return {
    anchorIndex,
    goal: resolvePricingGoal(candidate.goalId, candidate.goalVersion)!,
    parameters: candidate.parameters,
    currencyCode,
    currentPriceAmount,
    curve:
      curve !== null && evidenceState(curve, currencyCode, snapshot.capturedAt) === "present"
        ? { currencyCode: curve.currencyCode!, version: curve.version, points: curve.points }
        : null,
    constraint: {
      identity: sha256({
        ruleIndex,
        directive: rule.directive,
        currentPriceAmount,
        costBasisAmount: compatibleListing.costBasisAmount,
        costBasisCurrencyCode: compatibleListing.costBasisCurrencyCode,
        guardrailEvidence: rule.directive.guardrails?.length
          ? captureGuardrailEvidence(compatibleListing, snapshot, currentCents, candidate.source)
          : null,
      }),
      apply: (amount) => {
        const anchored = evaluateTarget(compatibleListing, ruleIndex, rule.directive, snapshot, {
          anchor: { source: candidate.source, amount, stratum: "curve-objective", contributingListingCount: 0 },
          exhaustedAnchors: earlier.exhaustedAnchors,
          baseAmount: amount,
        });
        return anchored.action === "update-price"
          ? centsToMoneyAmount(moneyToCents(anchored.targetPriceAmount!))
          : currentPriceAmount;
      },
    },
  };
}

/** A curve-objective anchor whose goal is selectable and resolves a Portfolio Plan. */
function isPortfolioAnchor(anchor: RepricingAnchor): boolean {
  if (anchor.source !== "curve-objective") return false;
  const goal = resolvePricingGoal(anchor.goalId, anchor.goalVersion);
  return goal?.lifecycle === "selectable" && goal.solvePortfolio !== undefined;
}

function isCurrencyExhaustion(anchor: RepricingExhaustedAnchor): boolean {
  return anchor.state === "currency-incomplete" || anchor.state === "currency-mismatch";
}

function noReprice(
  listing: RepricingListingEvaluationInput,
  ruleIndex: number,
  directive: RepricingRuleDirective | undefined,
  exhaustedAnchors: RepricingListingEvaluation["exhaustedAnchors"] = [],
): RepricingListingEvaluation {
  return {
    listingId: listing.listingId,
    currentPriceAmount: listing.currentPriceAmount,
    targetPriceAmount: null,
    ruleIndex,
    anchor: null,
    exhaustedAnchors,
    clamps: { floor: false, ceiling: false, maxMove: false },
    tolerance: directive?.tolerance ?? { mode: "percent", percent: 0 },
    flags: [],
    action: "no-reprice",
    skipReason: "currency-input-incomplete-or-mismatched",
  };
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

/** A solved curve objective, kept so the trace can read the goal back at the final price. */
type ResolvedGoal = Readonly<{
  goalId: string;
  goalVersion: number;
  curveVersion: number;
  curve: GoalCurveViews;
  /** Present only for a goal that requires Economics. */
  economics: Extract<EconomicsForPricingGoal, { availability: "resolved" }> | null;
}>;

type ResolvedAnchor = Readonly<{
  anchor: RepricingAnchorTrace | null;
  exhaustedAnchors: readonly RepricingExhaustedAnchor[];
  bandBinding?: boolean;
  goal?: ResolvedGoal;
}>;

type CompatibleListing = RepricingListingEvaluationInput & Readonly<{ currentPriceCurrencyCode: string }>;

function resolveAnchor(
  directive: RepricingRuleDirective,
  snapshot: RepricingMarketInputSnapshot,
  hardAsks: readonly RepricingMarketInputSnapshot["competingAsks"][number][],
  listing: CompatibleListing,
  shadowAnchorIndex?: number,
  portfolio?: RepricingPortfolioAssignment,
): ResolvedAnchor {
  const { currentPriceCurrencyCode: targetCurrencyCode, sellerAccountId } = listing;
  const exhaustedAnchors: RepricingExhaustedAnchor[] = [];

  for (const [anchorIndex, candidate] of directive.anchorChain.entries()) {
    switch (candidate.source) {
      case "market-estimate": {
        const estimate = snapshot.marketEstimate;
        const state: RepricingInputState =
          estimate === null
            ? "absent"
            : !estimate.currencyCode
              ? "currency-incomplete"
              : estimate.currencyCode !== targetCurrencyCode
                ? "currency-mismatch"
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
        if (candidate.strata === "any") {
          const ground = snapshot.marketEstimate;
          const groundCents = ground && typeof ground.amount === "string" ? tryMoneyToCents(ground.amount) : null;
          if (
            groundCents === null ||
            ground?.currencyCode !== targetCurrencyCode ||
            !(Date.parse(ground.freshUntil) >= Date.parse(snapshot.capturedAt))
          ) {
            exhaustedAnchors.push({ source: candidate.source, state: "absent" });
            break;
          }
          const anyAsks = filterCompetingAskOutliers(
            snapshot.competingAsks.filter(
              (ask) => ask.sellerAccountId !== sellerAccountId && ask.currencyCode === targetCurrencyCode,
            ),
            (ask) => moneyToCents(ask.amount),
            groundCents,
            snapshot.hardAskOutlierPriceRatio,
          );
          if (anyAsks.length === 0) {
            exhaustedAnchors.push({
              source: candidate.source,
              state: incompatibleAskState(snapshot.competingAsks, targetCurrencyCode, sellerAccountId, "any"),
            });
            break;
          }
          const lowest = anyAsks.reduce(
            (amount, ask) => min(amount, moneyToCents(ask.amount)),
            moneyToCents(anyAsks[0]!.amount),
          );
          const bandFloor = anchorBandFloor(groundCents, candidate.band.minPercentOfGround);
          return {
            anchor: {
              source: candidate.source,
              amount: centsToMoneyAmount(max(lowest, bandFloor)),
              stratum: "any-ask",
              contributingListingCount: anyAsks.length,
            },
            exhaustedAnchors,
            bandBinding: bandFloor > lowest,
          };
        }
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
        exhaustedAnchors.push({
          source: candidate.source,
          state: incompatibleAskState(snapshot.competingAsks, targetCurrencyCode, sellerAccountId),
        });
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
        exhaustedAnchors.push({
          source: candidate.source,
          state: incompatibleAskState(snapshot.competingAsks, targetCurrencyCode, sellerAccountId),
        });
        break;
      }
      case "last-sold": {
        const lastSold = snapshot.lastSold;
        const state: RepricingInputState =
          lastSold === null
            ? "absent"
            : !lastSold.currencyCode
              ? "currency-incomplete"
              : lastSold.currencyCode !== targetCurrencyCode
                ? "currency-mismatch"
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
      case "curve-objective": {
        const goal = resolvePricingGoal(candidate.goalId, candidate.goalVersion);
        if (
          !goal ||
          goal.lifecycle === "retired" ||
          (goal.lifecycle === "shadow" && anchorIndex !== shadowAnchorIndex)
        ) {
          exhaustedAnchors.push({ source: candidate.source, state: "absent", reason: "goal-retired" });
          break;
        }
        const curve = snapshot.demandCurve;
        const state = evidenceState(curve, targetCurrencyCode, snapshot.capturedAt);
        if (curve === null || state !== "present") {
          exhaustedAnchors.push({ source: candidate.source, state });
          break;
        }
        const economics = snapshot.economics?.availability === "resolved" ? snapshot.economics : null;
        const planned = portfolio?.anchorIndex === anchorIndex ? portfolio.result : null;
        const decision =
          planned === null
            ? goal.solve({
                curve: { currencyCode: curve.currencyCode!, version: curve.version, points: curve.points },
                economics,
                parameters: candidate.parameters,
                currentPriceAmount: centsToMoneyAmount(moneyToCents(listing.currentPriceAmount)),
              })
            : (planned.decision ?? { kind: "unavailable" as const, reason: planned.heldReason! });
        if (decision.kind === "unavailable") {
          exhaustedAnchors.push(
            decision.reason === "economics-currency-mismatch"
              ? { source: candidate.source, state: "currency-mismatch" }
              : decision.reason === "curve-empty" || decision.reason === "current-price-missing"
                ? { source: candidate.source, state: "absent" }
                : { source: candidate.source, state: "absent", reason: decision.reason },
          );
          break;
        }
        return {
          anchor: {
            source: candidate.source,
            // The unconstrained price: the stages below constrain it, so a plan's constrained price is never constrained twice.
            amount: decision.unconstrainedPriceAmount,
            stratum: "curve-objective",
            contributingListingCount: 0,
          },
          exhaustedAnchors,
          goal: {
            goalId: goal.id,
            goalVersion: goal.version,
            curveVersion: curve.version,
            curve: toGoalCurveViews(curve.points)!,
            economics: goal.requiresEconomics ? economics : null,
          },
        };
      }
    }
  }

  return { anchor: null, exhaustedAnchors };
}

/** Currency before freshness, ISO codes compared case-insensitively; missing or unparseable freshness is stale. */
function evidenceState(
  evidence: Readonly<{ currencyCode?: string | null; freshUntil: string | null }> | null,
  targetCurrencyCode: string,
  capturedAt: string,
): RepricingInputState {
  if (evidence === null) return "absent";
  if (!evidence.currencyCode) return "currency-incomplete";
  if (evidence.currencyCode.toUpperCase() !== targetCurrencyCode) return "currency-mismatch";
  return evidence.freshUntil !== null && Date.parse(evidence.freshUntil) >= Date.parse(capturedAt)
    ? "present"
    : "stale";
}

function incompatibleAskState(
  asks: RepricingMarketInputSnapshot["competingAsks"],
  targetCurrencyCode: string,
  sellerAccountId: string,
  strata: "hard" | "any" = "hard",
): RepricingInputState {
  const candidates = asks.filter(
    (ask) => (strata === "any" || ask.pricingMode === "hard") && ask.sellerAccountId !== sellerAccountId,
  );
  if (candidates.length === 0) return "absent";
  if (candidates.some((ask) => !ask.currencyCode)) return "currency-incomplete";
  return candidates.some((ask) => ask.currencyCode !== targetCurrencyCode) ? "currency-mismatch" : "absent";
}

function evaluateTerminal(
  listing: RepricingListingEvaluationInput & Readonly<{ currentPriceCurrencyCode: string }>,
  ruleIndex: number,
  directive: RepricingRuleDirective,
  snapshot: RepricingMarketInputSnapshot,
  exhaustedAnchors: readonly RepricingExhaustedAnchor[],
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
      return evaluateTarget(listing, ruleIndex, directive, snapshot, {
        baseAmount: directive.terminal.amount,
        anchor: null,
        exhaustedAnchors,
      });
    case "price-at-floor":
      return evaluateTarget(listing, ruleIndex, directive, snapshot, {
        baseAmount: resolveRepricingFloorAmount(
          directive.floor,
          listing.costBasisCurrencyCode === listing.currentPriceCurrencyCode ? listing.costBasisAmount : null,
        ),
        anchor: null,
        exhaustedAnchors,
      });
    case "pause":
      return { ...base, targetPriceAmount: null, action: "pause", skipReason: "terminal-pause" };
    case "notify-only":
      return { ...base, targetPriceAmount: null, action: "notify-only", skipReason: "terminal-notify-only" };
    case "hold":
      return { ...base, targetPriceAmount: null, action: "hold", skipReason: "terminal-hold" };
  }
}

function evaluateTarget(
  listing: RepricingListingEvaluationInput & Readonly<{ currentPriceCurrencyCode: string }>,
  ruleIndex: number,
  directive: RepricingRuleDirective,
  snapshot: RepricingMarketInputSnapshot,
  resolved: ResolvedAnchor & Readonly<{ baseAmount: string }>,
): RepricingListingEvaluation {
  const { anchor, exhaustedAnchors, bandBinding = false, goal } = resolved;
  const current = moneyToCents(listing.currentPriceAmount);
  const anchorCents = moneyToCents(resolved.baseAmount);
  const guardrailEvidence = directive.guardrails?.length
    ? captureGuardrailEvidence(listing, snapshot, current, anchor?.source ?? directive.terminal.kind)
    : null;
  const tracedAnchor = (priceCents: bigint) =>
    anchor && goal ? { ...anchor, goal: traceGoalAtPrice(goal, priceCents) } : anchor;
  const hold = (reason: "hopeless-forecast-hold"): RepricingListingEvaluation => ({
    listingId: listing.listingId,
    currentPriceAmount: centsToMoneyAmount(current),
    targetPriceAmount: null,
    ruleIndex,
    anchor: tracedAnchor(current),
    exhaustedAnchors,
    clamps: { floor: false, ceiling: false, maxMove: false },
    tolerance: directive.tolerance,
    flags: bandBinding ? ["band-binding"] : [],
    action: "hold",
    skipReason: reason,
  });

  const preOffset = applyGuardrails("pre-offset", directive, guardrailEvidence, anchorCents);
  if (preOffset.outcome === "hold") {
    return hold(preOffset.reason);
  }
  let target = applyOffset(preOffset.targetCents, directive);
  target = applyRounding(target, directive);

  const floor = moneyToCents(
    resolveRepricingFloorAmount(
      directive.floor,
      listing.costBasisCurrencyCode === listing.currentPriceCurrencyCode ? listing.costBasisAmount : null,
    ),
  );
  const ceiling = resolveCeiling(anchorCents, directive);
  const clamps: { floor: boolean; ceiling: boolean; maxMove: boolean; evidenceFloor?: boolean } = {
    floor: false,
    ceiling: false,
    maxMove: false,
  };

  // The movement guard constrains the proposal first; a post-max-move
  // guardrail may then raise it. Seller-authored floor/ceiling clamps are
  // terminal and no earlier stage may escape them.
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
  const postMaxMove = applyGuardrails("post-max-move", directive, guardrailEvidence, target);
  if (postMaxMove.outcome === "hold") {
    return hold(postMaxMove.reason);
  }
  target = postMaxMove.targetCents;
  // The Market-Evidence Floor is the only registered clamp kind.
  if (preOffset.clamped || postMaxMove.clamped) {
    clamps.evidenceFloor = true;
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
    ...(bandBinding ? (["band-binding"] as const) : []),
    ...(clamps.floor ? (["floor-binding"] as const) : []),
    ...(clamps.ceiling ? (["ceiling-binding"] as const) : []),
    ...(clamps.maxMove ? (["max-move-binding"] as const) : []),
    ...(clamps.evidenceFloor ? (["evidence-floor-binding"] as const) : []),
  ];

  return {
    listingId: listing.listingId,
    currentPriceAmount: centsToMoneyAmount(current),
    targetPriceAmount: centsToMoneyAmount(target),
    ruleIndex,
    anchor: tracedAnchor(target),
    exhaustedAnchors,
    clamps,
    tolerance: directive.tolerance,
    flags,
    action: delta <= tolerance ? "hold" : "update-price",
    skipReason: delta <= tolerance ? "within-tolerance" : null,
  };
}

type GuardrailEvidence = Omit<GuardrailContext, "targetCents" | "parameters">;

/**
 * Runs the directive's guardrails registered at one slot, in authored order.
 * A hold ends evaluation; a clamp only ever raises the target. Every authored
 * kind passed registry validation, so an unregistered kind is a deploy defect
 * and fails loudly instead of letting a target bypass it.
 */
function applyGuardrails(
  slot: GuardrailDefinition["slot"],
  directive: RepricingRuleDirective,
  evidence: GuardrailEvidence | null,
  targetCents: bigint,
):
  | Readonly<{ outcome: "hold"; reason: "hopeless-forecast-hold" }>
  | Readonly<{ outcome: "continue"; targetCents: bigint; clamped: boolean }> {
  let target = targetCents;
  let clamped = false;
  for (const { kind, ...parameters } of directive.guardrails ?? []) {
    const definition = resolveRepricingGuardrail(kind);
    if (!definition) throw new Error(`Repricing guardrail kind ${kind} is not registered.`);
    if (definition.slot !== slot) continue;
    const result = definition.apply({ ...evidence!, parameters, targetCents: target });
    if (result.outcome === "hold") return { outcome: "hold", reason: result.reason };
    if (result.outcome === "clamp" && result.amountCents > target) {
      target = result.amountCents;
      clamped = true;
    }
  }
  return { outcome: "continue", targetCents: target, clamped };
}

/** Guardrail evidence in the listing currency; no guardrail derives freshness or currency itself. */
function captureGuardrailEvidence(
  listing: RepricingListingEvaluationInput & Readonly<{ currentPriceCurrencyCode: string }>,
  snapshot: RepricingMarketInputSnapshot,
  currentCents: bigint,
  resolvedAnchorSource: string,
): GuardrailEvidence {
  const currencyCode = listing.currentPriceCurrencyCode;
  const estimate = snapshot.marketEstimate;
  const estimateState = evidenceState(estimate, currencyCode, snapshot.capturedAt);
  const estimateCents = estimate === null ? null : tryMoneyToCents(estimate.amount);
  // Present evidence is never null: evidenceState reports a null input as absent.
  const curveState = evidenceState(snapshot.demandCurve, currencyCode, snapshot.capturedAt);
  const curve: GuardrailCurveSummary =
    curveState !== "present"
      ? { state: curveState }
      : {
          state: curveState,
          currencyCode,
          points: snapshot.demandCurve!.points.map((point) => ({
            amountCents: moneyToCents(point.priceAmount),
            medianSellDays: point.medianSellDays,
            hopeless: point.hopeless,
          })),
        };
  return {
    currencyCode,
    sellerAccountId: listing.sellerAccountId,
    currentCents,
    resolvedAnchorSource,
    marketEstimate:
      estimateState !== "present"
        ? { state: estimateState }
        : estimateCents === null
          ? { state: "absent" }
          : { state: estimateState, currencyCode, amountCents: estimateCents },
    otherSellerHardAsks: snapshot.competingAsks
      .filter((ask) => ask.pricingMode === "hard" && ask.sellerAccountId !== listing.sellerAccountId)
      .map((ask) => ({
        sellerAccountId: ask.sellerAccountId,
        pricingMode: ask.pricingMode,
        currencyCode: ask.currencyCode?.toUpperCase() ?? null,
        amountCents: moneyToCents(ask.amount),
      })),
    hardAskOutlierPriceRatio: snapshot.hardAskOutlierPriceRatio,
    curve,
  };
}

function traceGoalAtPrice(goal: ResolvedGoal, priceCents: bigint): RepricingGoalTrace {
  const price = Number(priceCents) / 100;
  const { equivalentPercentile, forecast } = readBackAtPrice(goal.curve, price);
  return {
    goalId: goal.goalId,
    goalVersion: goal.goalVersion,
    curveVersion: goal.curveVersion,
    equivalentPercentile,
    forecastMedianSellDays: forecast.medianSellDays,
    forecastStatus: forecast.status,
    unprofitable: goal.economics !== null && netProceedsAtPrice(price, goal.economics) <= 0,
  };
}

function anchorBandFloor(groundCents: bigint, percent: number): bigint {
  // Validated 50-100 percentages have no exponent notation. Preserve all authored
  // decimal places and round upward so the anchor never crosses below the band.
  const [whole, fraction = ""] = percent.toString().split(".");
  return roundRational(groundCents * BigInt(whole! + fraction), 100n * 10n ** BigInt(fraction.length), "ceil");
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
