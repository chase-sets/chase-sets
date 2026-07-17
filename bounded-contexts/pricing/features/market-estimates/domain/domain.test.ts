import { describe, expect, it } from "vitest";
import { foldEvents } from "@chase-sets/event-core";
import type { BlendedMarketValueEstimate } from "./blended-estimate";
import {
  decideMarketPriceEstimate,
  evolveMarketPriceEstimate,
  initialMarketPriceEstimateState,
  marketPriceEstimatedEventType,
  type MarketPriceEstimateEvent,
  type RecomputeMarketPriceEstimateCommand,
} from "./domain";

const estimated: Extract<BlendedMarketValueEstimate, { status: "estimated" }> = {
  status: "estimated",
  amount: "12.50",
  bandLowAmount: "10.00",
  bandHighAmount: "15.00",
  confidence: "medium",
  inputCounts: { platformVerifiedTradeCount: 4, platformTradeCount: 3, externalCompCount: 2 },
};

function recompute(overrides: Partial<RecomputeMarketPriceEstimateCommand> = {}): RecomputeMarketPriceEstimateCommand {
  return {
    type: "RecomputeMarketPriceEstimate",
    catalogItemId: "cat_1",
    productId: "cat_1::dim:opt",
    estimate: estimated,
    window: { startedAt: "2026-04-17T12:00:00.000Z", endedAt: "2026-07-16T12:00:00.000Z" },
    currencyCode: "usd",
    estimatedAt: "2026-07-16T12:00:00.000Z",
    freshUntil: "2026-07-18T12:00:00.000Z",
    ...overrides,
  };
}

function stateAfter(events: readonly MarketPriceEstimateEvent[]) {
  return foldEvents(initialMarketPriceEstimateState, evolveMarketPriceEstimate, events);
}

describe("decideMarketPriceEstimate", () => {
  it("publishes the schema-version-1 Market Price fact with band, counts, and freshness", () => {
    const events = decideMarketPriceEstimate(initialMarketPriceEstimateState, recompute());

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: marketPriceEstimatedEventType,
      data: {
        schemaVersion: 1,
        catalogItemId: "cat_1",
        productId: "cat_1::dim:opt",
        estimateVersion: "1",
        window: { startedAt: "2026-04-17T12:00:00.000Z", endedAt: "2026-07-16T12:00:00.000Z" },
        amount: "12.50",
        currencyCode: "usd",
        band: { lowAmount: "10.00", highAmount: "15.00" },
        confidence: "medium",
        estimatedAt: "2026-07-16T12:00:00.000Z",
        freshUntil: "2026-07-18T12:00:00.000Z",
        disclosure: "account",
        previousAmount: null,
        inputs: { platformVerifiedTradeCount: 4, platformTradeCount: 3, externalCompCount: 2 },
      },
    });
  });

  it("publishes NOTHING for a below-gate recompute -- the minimum-input gate is a publication rule", () => {
    const events = decideMarketPriceEstimate(
      initialMarketPriceEstimateState,
      recompute({
        estimate: {
          status: "no-estimate",
          reason: "below-minimum-inputs",
          inputCounts: { platformVerifiedTradeCount: 1, platformTradeCount: 1, externalCompCount: 0 },
        },
      }),
    );

    expect(events).toEqual([]);
  });

  it("no-ops an unchanged recompute on the same UTC day (idempotent closer cadence)", () => {
    const state = stateAfter(decideMarketPriceEstimate(initialMarketPriceEstimateState, recompute()));

    const events = decideMarketPriceEstimate(
      state,
      recompute({ estimatedAt: "2026-07-16T18:30:00.000Z", freshUntil: "2026-07-18T18:30:00.000Z" }),
    );

    expect(events).toEqual([]);
  });

  it("no-ops an unchanged same-day recompute whose window and freshUntil merely rode the clock (same durations)", () => {
    // Exactly what the closer produces every few minutes: identical values,
    // window.endedAt and freshUntil advanced with `now`, durations unchanged.
    const state = stateAfter(decideMarketPriceEstimate(initialMarketPriceEstimateState, recompute()));

    const events = decideMarketPriceEstimate(
      state,
      recompute({
        window: { startedAt: "2026-04-17T18:30:00.000Z", endedAt: "2026-07-16T18:30:00.000Z" },
        estimatedAt: "2026-07-16T18:30:00.000Z",
        freshUntil: "2026-07-18T18:30:00.000Z",
      }),
    );

    expect(events).toEqual([]);
  });

  it("republishes SAME DAY when a policy revision shortens the freshness horizon (48h -> 1h takes effect immediately)", () => {
    const state = stateAfter(decideMarketPriceEstimate(initialMarketPriceEstimateState, recompute()));

    const events = decideMarketPriceEstimate(
      state,
      recompute({
        estimatedAt: "2026-07-16T14:00:00.000Z",
        freshUntil: "2026-07-16T15:00:00.000Z", // 1h horizon, was 48h
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.data.freshUntil).toBe("2026-07-16T15:00:00.000Z");
    expect(events[0]!.data.estimateVersion).toBe("2");
  });

  it("republishes SAME DAY when a policy revision changes the lookback-window duration", () => {
    const state = stateAfter(decideMarketPriceEstimate(initialMarketPriceEstimateState, recompute()));

    const events = decideMarketPriceEstimate(
      state,
      recompute({
        // 30-day window instead of the state's 90-day one, same end.
        window: { startedAt: "2026-06-16T12:00:00.000Z", endedAt: "2026-07-16T12:00:00.000Z" },
        estimatedAt: "2026-07-16T14:00:00.000Z",
        freshUntil: "2026-07-18T14:00:00.000Z",
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.data.estimateVersion).toBe("2");
  });

  it("republishes SAME DAY when the currency changes", () => {
    const state = stateAfter(decideMarketPriceEstimate(initialMarketPriceEstimateState, recompute()));

    const events = decideMarketPriceEstimate(
      state,
      recompute({
        currencyCode: "eur",
        estimatedAt: "2026-07-16T14:00:00.000Z",
        freshUntil: "2026-07-18T14:00:00.000Z",
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.data.currencyCode).toBe("eur");
  });

  it("republishes an unchanged estimate on a LATER day so freshUntil advances, carrying previousAmount", () => {
    const state = stateAfter(decideMarketPriceEstimate(initialMarketPriceEstimateState, recompute()));

    const events = decideMarketPriceEstimate(
      state,
      recompute({ estimatedAt: "2026-07-17T12:05:00.000Z", freshUntil: "2026-07-19T12:05:00.000Z" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.data.estimateVersion).toBe("2");
    expect(events[0]!.data.previousAmount).toBe("12.50");
    expect(events[0]!.data.freshUntil).toBe("2026-07-19T12:05:00.000Z");
  });

  it("publishes a changed estimate on the same day, carrying the previous amount for delta filtering", () => {
    const state = stateAfter(decideMarketPriceEstimate(initialMarketPriceEstimateState, recompute()));

    const events = decideMarketPriceEstimate(
      state,
      recompute({
        estimate: { ...estimated, amount: "13.25", bandHighAmount: "16.00" },
        estimatedAt: "2026-07-16T14:00:00.000Z",
        freshUntil: "2026-07-18T14:00:00.000Z",
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.data.amount).toBe("13.25");
    expect(events[0]!.data.previousAmount).toBe("12.50");
    expect(events[0]!.data.estimateVersion).toBe("2");
  });

  it("rejects a confidence band that does not contain its estimate", () => {
    expect(() =>
      decideMarketPriceEstimate(
        initialMarketPriceEstimateState,
        recompute({ estimate: { ...estimated, bandLowAmount: "13.00" } }),
      ),
    ).toThrow("Confidence band must contain its estimate amount.");
  });

  it("rejects a freshUntil preceding estimatedAt", () => {
    expect(() =>
      decideMarketPriceEstimate(initialMarketPriceEstimateState, recompute({ freshUntil: "2026-07-16T11:00:00.000Z" })),
    ).toThrow("Estimate freshUntil must not precede estimatedAt.");
  });

  it("rejects a window ending before it starts", () => {
    expect(() =>
      decideMarketPriceEstimate(
        initialMarketPriceEstimateState,
        recompute({ window: { startedAt: "2026-07-16T12:00:00.000Z", endedAt: "2026-04-17T12:00:00.000Z" } }),
      ),
    ).toThrow("Estimate window must end after it starts.");
  });

  it("evolves state to the latest published estimate with a monotonic revision", () => {
    const first = decideMarketPriceEstimate(initialMarketPriceEstimateState, recompute());
    const afterFirst = stateAfter(first);
    const second = decideMarketPriceEstimate(
      afterFirst,
      recompute({
        estimate: { ...estimated, amount: "14.00", bandHighAmount: "16.00" },
        estimatedAt: "2026-07-17T12:00:00.000Z",
        freshUntil: "2026-07-19T12:00:00.000Z",
      }),
    );
    const state = foldEvents(afterFirst, evolveMarketPriceEstimate, second);

    expect(state.revision).toBe(2);
    expect(state.amount).toBe("14.00");
    expect(state.estimatedAt).toBe("2026-07-17T12:00:00.000Z");
  });
});
