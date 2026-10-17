import { describe, expect, it, vi } from "vitest";

import {
  checkoutObservabilityTelemetryEvent,
  recordCheckoutObservabilityTelemetry,
  type CheckoutObservabilityTelemetryInput,
} from "./checkout-observability-telemetry";

const reviewRenderedInput = {
  state: "guest-buy-checkout",
  entrySource: "buy-now",
  actorMode: "guest",
  scenarioState: "normal",
  visibleState: "checkout-review-visible",
  sideEffectStatus: "forbidden-before-confirm",
  readinessContract: "checkout.session-read-model",
  readinessSnapshotState: "not-applicable",
  sourceRevisionState: "current",
  freshWriteReceiptPresence: "not-provided",
  supportReferencePresent: false,
  performanceBudgetId: "checkout-entry-review-render",
  providerCategory: "none",
  riskCategory: "none",
  downstreamStatus: "not-started",
  capabilityDecision: "not-required",
  freshStateScanResult: "not-applicable",
} satisfies CheckoutObservabilityTelemetryInput;

describe("checkout observability telemetry", () => {
  it("derives event metadata from the checkout observability profile", () => {
    const event = checkoutObservabilityTelemetryEvent(reviewRenderedInput);

    expect(event).toEqual(
      expect.objectContaining({
        eventName: "checkout.buy.guest_review_rendered",
        telemetryClass: "checkout-entry",
        alertClass: "event-only",
        operatorSignalRequired: false,
        entrySource: "buy-now",
        actorMode: "guest",
        visibleState: "checkout-review-visible",
        sideEffectStatus: "forbidden-before-confirm",
      }),
    );
    expect(event).not.toHaveProperty("state");
  });

  it("rejects scenario states outside the profile contract", () => {
    expect(() =>
      checkoutObservabilityTelemetryEvent({
        ...reviewRenderedInput,
        scenarioState: "blocked",
      }),
    ).toThrow("does not allow 'blocked'");
  });

  it("derives the fixed cart merge failure event without accepting exception data", () => {
    expect(
      checkoutObservabilityTelemetryEvent({
        state: "cart-merge-best-effort-failed",
        entrySource: "cart",
        actorMode: "signed-in",
        scenarioState: "reconciliation",
        visibleState: "entry-continues",
        sideEffectStatus: "merge-failed",
      }),
    ).toEqual({
      eventName: "checkout.entry.cart_merge_best_effort_failed",
      telemetryClass: "checkout-entry",
      alertClass: "event-only",
      operatorSignalRequired: false,
      entrySource: "cart",
      actorMode: "signed-in",
      scenarioState: "reconciliation",
      visibleState: "entry-continues",
      sideEffectStatus: "merge-failed",
      readinessContract: null,
      readinessSnapshotState: null,
      sourceRevisionState: null,
      freshWriteReceiptPresence: null,
      supportReferencePresent: false,
      performanceBudgetId: null,
      providerCategory: null,
      riskCategory: null,
      downstreamStatus: null,
      capabilityDecision: null,
      freshStateScanResult: null,
    });
  });

  it("records through the injected host port without raw identifiers", () => {
    const telemetry = { recordCheckoutEvent: vi.fn() };

    recordCheckoutObservabilityTelemetry(telemetry, reviewRenderedInput);

    expect(telemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "checkout.buy.guest_review_rendered",
        entrySource: "buy-now",
        actorMode: "guest",
      }),
    );
    const emitted = JSON.stringify(telemetry.recordCheckoutEvent.mock.calls[0]?.[0]);
    expect(emitted).not.toMatch(/checkoutSessionId|accountId|email|address|providerPayload|afterWrite/);
  });

  it("does nothing when the host port is unavailable", () => {
    expect(() => recordCheckoutObservabilityTelemetry(undefined, reviewRenderedInput)).not.toThrow();
  });
});
