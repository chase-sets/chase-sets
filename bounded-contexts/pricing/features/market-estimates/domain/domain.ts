import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { BlendedMarketValueEstimate, MarketEstimateInputCounts } from "./blended-estimate";

/**
 * The Market Price aggregate: one event-sourced stream per resolved Product
 * carrying its published fair-value estimates. `pricing.market-price.estimated`
 * is the wire fact (GLOSSARY.md "Market Price") -- the derived answer
 * consumers subscribe to (collections' saved-list valuation already declares
 * the subscription; m113's signal-reactive repricing evaluation engine
 * anchors on it). A Market Price Snapshot remains a recorded market-state
 * INPUT, not this estimate -- see the m122 snapshot-vs-estimate delineation
 * in the glossary.
 *
 * Wire contract: `schemaVersion: 1` as decoded by
 * bounded-contexts/collections/features/saved-list-valuation/integrations/pricing/market-price-estimated.ts.
 * `previousAmount` and `inputs` are additive publisher fields (consumers
 * ignore unknown fields): `previousAmount` carries the prior published
 * estimate so the m113 engine's downstream tolerance filtering works
 * without a read.
 *
 * Idempotence: a recompute that is SEMANTICALLY identical to the current
 * estimate on the same UTC day is a no-op -- the every-few-minutes closer
 * pass never floods the stream. "Semantically identical" covers everything
 * a consumer or a policy revision could care about: amount, band,
 * confidence, input counts, currency, the lookback-window DURATION, and the
 * freshness DURATION (`freshUntil - estimatedAt`). Durations, not absolute
 * timestamps, because each pass legitimately advances `window.endedAt` and
 * `freshUntil` with the clock -- but a same-day Market-Estimate Policy
 * revision (say freshness 48h -> 1h, or a different lookback) changes the
 * duration and MUST publish immediately, not at the next UTC day. Durations
 * are policy-derived constants (hours x 3.6e6 ms), so they compare exactly
 * across passes regardless of input-timestamp clock skew.
 *
 * A recompute on a LATER day always publishes (even with identical values)
 * so `freshUntil` advances while the inputs still clear the minimum-input
 * gate. A below-gate recompute never publishes anything: the estimate simply
 * ages past its `freshUntil` and consumers classify it stale.
 */

export const marketPriceEstimatedEventType = "pricing.market-price.estimated" as const;

export type MarketPriceEstimateState = Readonly<{
  catalogItemId: string | null;
  productId: string | null;
  /** Monotonic published-revision counter; `estimateVersion` on the wire. */
  revision: number;
  amount: string | null;
  bandLowAmount: string | null;
  bandHighAmount: string | null;
  confidence: "low" | "medium" | "high" | null;
  inputCounts: MarketEstimateInputCounts | null;
  estimatedAt: string | null;
  currencyCode: string | null;
  windowStartedAt: string | null;
  windowEndedAt: string | null;
  freshUntil: string | null;
}>;

export const initialMarketPriceEstimateState: MarketPriceEstimateState = {
  catalogItemId: null,
  productId: null,
  revision: 0,
  amount: null,
  bandLowAmount: null,
  bandHighAmount: null,
  confidence: null,
  inputCounts: null,
  estimatedAt: null,
  currencyCode: null,
  windowStartedAt: null,
  windowEndedAt: null,
  freshUntil: null,
};

export type RecomputeMarketPriceEstimateCommand = Readonly<{
  type: "RecomputeMarketPriceEstimate";
  catalogItemId: string;
  productId: string;
  /** The blended calculation's outcome -- the minimum-input gate has already spoken. */
  estimate: BlendedMarketValueEstimate;
  window: Readonly<{ startedAt: string; endedAt: string }>;
  currencyCode: string;
  estimatedAt: string;
  freshUntil: string;
}>;

export type MarketPriceEstimateCommand = RecomputeMarketPriceEstimateCommand;

export type MarketPriceEstimatedEvent = DomainEvent<
  typeof marketPriceEstimatedEventType,
  Readonly<{
    schemaVersion: 1;
    catalogItemId: string;
    productId: string;
    estimateVersion: string;
    window: Readonly<{ startedAt: string; endedAt: string }>;
    amount: string;
    currencyCode: string;
    band: Readonly<{ lowAmount: string; highAmount: string }> | null;
    confidence: "low" | "medium" | "high";
    estimatedAt: string;
    freshUntil: string;
    disclosure: "internal" | "account" | "public";
    /** The previously published estimate amount, for change-only downstream filtering (m113 repricing engine). */
    previousAmount: string | null;
    /** Input counts behind the estimate, so surfaces show evidence instead of false precision. */
    inputs: MarketEstimateInputCounts;
  }>
>;

export type MarketPriceEstimateEvent = MarketPriceEstimatedEvent;

/** Estimates are internal + seller-facing guidance; buyer-facing surfaces stay neutral-factual (m111 framing rule). */
const MARKET_PRICE_ESTIMATE_DISCLOSURE = "account" as const;

export const decideMarketPriceEstimate: AggregateDecider<
  MarketPriceEstimateState,
  MarketPriceEstimateCommand,
  MarketPriceEstimateEvent
> = (state, command) => {
  // The minimum-input gate as a publication rule: a below-gate (or empty)
  // recompute publishes NOTHING -- never a garbage number.
  if (command.estimate.status !== "estimated") {
    return [];
  }

  const catalogItemId = requiredText(command.catalogItemId, "Catalog item id is required.");
  const productId = requiredText(command.productId, "Product id is required.");
  const currencyCode = normalizeCurrencyCode(command.currencyCode);
  const estimatedAt = requiredTimestamp(command.estimatedAt, "Estimate time is required.");
  const freshUntil = requiredTimestamp(command.freshUntil, "Estimate fresh-until time is required.");
  const windowStartedAt = requiredTimestamp(command.window.startedAt, "Estimate window start is required.");
  const windowEndedAt = requiredTimestamp(command.window.endedAt, "Estimate window end is required.");
  if (Date.parse(windowEndedAt) < Date.parse(windowStartedAt)) {
    throw new Error("Estimate window must end after it starts.");
  }
  if (Date.parse(freshUntil) < Date.parse(estimatedAt)) {
    throw new Error("Estimate freshUntil must not precede estimatedAt.");
  }

  const amount = positiveMoney(command.estimate.amount, "Estimate amount must be a positive money amount.");
  const bandLowAmount = positiveMoney(
    command.estimate.bandLowAmount,
    "Band low amount must be a positive money amount.",
  );
  const bandHighAmount = positiveMoney(
    command.estimate.bandHighAmount,
    "Band high amount must be a positive money amount.",
  );
  if (!(Number(bandLowAmount) <= Number(amount) && Number(amount) <= Number(bandHighAmount))) {
    throw new Error("Confidence band must contain its estimate amount.");
  }

  if (
    isUnchangedSameDayEstimate(state, {
      amount,
      bandLowAmount,
      bandHighAmount,
      confidence: command.estimate.confidence,
      inputCounts: command.estimate.inputCounts,
      currencyCode,
      windowStartedAt,
      windowEndedAt,
      estimatedAt,
      freshUntil,
    })
  ) {
    return [];
  }

  return [
    {
      type: marketPriceEstimatedEventType,
      data: {
        schemaVersion: 1,
        catalogItemId,
        productId,
        estimateVersion: String(state.revision + 1),
        window: { startedAt: windowStartedAt, endedAt: windowEndedAt },
        amount,
        currencyCode,
        band: { lowAmount: bandLowAmount, highAmount: bandHighAmount },
        confidence: command.estimate.confidence,
        estimatedAt,
        freshUntil,
        disclosure: MARKET_PRICE_ESTIMATE_DISCLOSURE,
        previousAmount: state.amount,
        inputs: command.estimate.inputCounts,
      },
    },
  ];
};

export const evolveMarketPriceEstimate: AggregateEvolver<MarketPriceEstimateState, MarketPriceEstimateEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case marketPriceEstimatedEventType:
      return {
        catalogItemId: event.data.catalogItemId,
        productId: event.data.productId,
        revision: Number(event.data.estimateVersion),
        amount: event.data.amount,
        bandLowAmount: event.data.band?.lowAmount ?? null,
        bandHighAmount: event.data.band?.highAmount ?? null,
        confidence: event.data.confidence,
        inputCounts: event.data.inputs,
        estimatedAt: event.data.estimatedAt,
        currencyCode: event.data.currencyCode,
        windowStartedAt: event.data.window.startedAt,
        windowEndedAt: event.data.window.endedAt,
        freshUntil: event.data.freshUntil,
      };
    default:
      return state;
  }
};

function isUnchangedSameDayEstimate(
  state: MarketPriceEstimateState,
  candidate: Readonly<{
    amount: string;
    bandLowAmount: string;
    bandHighAmount: string;
    confidence: "low" | "medium" | "high";
    inputCounts: MarketEstimateInputCounts;
    currencyCode: string;
    windowStartedAt: string;
    windowEndedAt: string;
    estimatedAt: string;
    freshUntil: string;
  }>,
): boolean {
  if (
    state.estimatedAt === null ||
    state.currencyCode === null ||
    state.windowStartedAt === null ||
    state.windowEndedAt === null ||
    state.freshUntil === null
  ) {
    return false;
  }
  return (
    utcDay(state.estimatedAt) === utcDay(candidate.estimatedAt) &&
    state.amount === candidate.amount &&
    state.bandLowAmount === candidate.bandLowAmount &&
    state.bandHighAmount === candidate.bandHighAmount &&
    state.confidence === candidate.confidence &&
    inputCountsEqual(state.inputCounts, candidate.inputCounts) &&
    state.currencyCode === candidate.currencyCode &&
    // Durations, not absolute timestamps (see the module header): the
    // lookback window and freshness horizon are the policy inputs consumers
    // feel; their absolute endpoints legitimately ride the clock every pass.
    durationMs(state.windowStartedAt, state.windowEndedAt) ===
      durationMs(candidate.windowStartedAt, candidate.windowEndedAt) &&
    durationMs(state.estimatedAt, state.freshUntil) === durationMs(candidate.estimatedAt, candidate.freshUntil)
  );
}

function durationMs(startedAt: string, endedAt: string): number {
  return Date.parse(endedAt) - Date.parse(startedAt);
}

function inputCountsEqual(left: MarketEstimateInputCounts | null, right: MarketEstimateInputCounts): boolean {
  return (
    left !== null &&
    left.platformVerifiedTradeCount === right.platformVerifiedTradeCount &&
    left.platformTradeCount === right.platformTradeCount &&
    left.externalCompCount === right.externalCompCount
  );
}

function utcDay(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function requiredText(value: string, message: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(message);
  }
  return normalized;
}

function requiredTimestamp(value: string, message: string): string {
  const normalized = value.trim();
  if (!normalized || !Number.isFinite(Date.parse(normalized))) {
    throw new Error(message);
  }
  return new Date(normalized).toISOString();
}

function normalizeCurrencyCode(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(normalized)) {
    throw new Error("Estimate currency code must be a three-letter code.");
  }
  return normalized;
}

function positiveMoney(value: string, message: string): string {
  const normalized = value.trim();
  if (!/^\d+\.\d{2}$/.test(normalized) || Number(normalized) <= 0) {
    throw new Error(message);
  }
  return normalized;
}
