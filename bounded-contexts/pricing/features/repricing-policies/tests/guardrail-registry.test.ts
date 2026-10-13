import { describe, expect, it } from "vitest";
import { marketEvidenceFloor } from "../domain/guardrails/market-evidence-floor";
import { hopelessForecastHold } from "../domain/guardrails/hopeless-forecast-hold";
import {
  createGuardrailRegistry,
  type GuardrailContext,
  type GuardrailCurveSummary,
} from "../domain/guardrails/registry";

const point = (amountCents: bigint, medianSellDays = 10, hopeless = false) => ({
  amountCents,
  medianSellDays,
  hopeless,
});
const context = (overrides: Partial<GuardrailContext> = {}): GuardrailContext => ({
  currencyCode: "USD",
  sellerAccountId: "acc_synthetic",
  currentCents: 1000n,
  targetCents: 700n,
  resolvedAnchorSource: "curve-objective",
  parameters: { percentOfEstimate: 90 },
  marketEstimate: { state: "present", currencyCode: "USD", amountCents: 1000n },
  otherSellerHardAsks: [],
  hardAskOutlierPriceRatio: 3,
  curve: { state: "absent" },
  ...overrides,
});
const ask = (amountCents: bigint, overrides = {}) => ({
  amountCents,
  currencyCode: "USD",
  sellerAccountId: "acc_other",
  pricingMode: "hard" as const,
  ...overrides,
});

describe("guardrail registry", () => {
  it("registers pure versioned kinds at their declared slots and rejects a duplicate kind", () => {
    const registry = createGuardrailRegistry([marketEvidenceFloor, hopelessForecastHold]);
    expect(registry.resolve("market-evidence-floor")).toBe(marketEvidenceFloor);
    expect(registry.resolve("unknown")).toBeNull();
    expect(marketEvidenceFloor).toMatchObject({ kind: "market-evidence-floor", version: 1, slot: "post-max-move" });
    expect(hopelessForecastHold).toMatchObject({ kind: "hopeless-forecast-hold", version: 1, slot: "pre-offset" });
    expect(() => registry.registerGuardrail(marketEvidenceFloor)).toThrow("guardrail-duplicate-kind");
  });
  it("clamps to 90% of the estimate, releasing to Second Ask and Curve Low", () => {
    expect(marketEvidenceFloor.apply(context())).toEqual({ outcome: "clamp", amountCents: 900n });
    expect(marketEvidenceFloor.apply(context({ otherSellerHardAsks: [ask(850n), ask(750n)] }))).toEqual({
      outcome: "clamp",
      amountCents: 850n,
    });
    expect(
      marketEvidenceFloor.apply(
        context({ curve: { state: "present", currencyCode: "USD", points: [point(950n), point(800n)] } }),
      ),
    ).toEqual({ outcome: "clamp", amountCents: 800n });
    expect(marketEvidenceFloor.apply(context({ targetCents: 950n }))).toEqual({ outcome: "inert" });
    expect(
      marketEvidenceFloor.apply(
        context({ marketEstimate: { state: "present", currencyCode: "USD", amountCents: 1001n } }),
      ),
    ).toEqual({ outcome: "clamp", amountCents: 901n });
    const input = context();
    const before = structuredClone(input);
    marketEvidenceFloor.apply(input);
    expect(input).toEqual(before);
  });
  it("releases to Second Ask when the canonical ask filter would remove every competing ask", () => {
    expect(
      marketEvidenceFloor.apply(
        context({
          targetCents: 300n,
          hardAskOutlierPriceRatio: 2,
          otherSellerHardAsks: [ask(400n), ask(450n)],
        }),
      ),
    ).toEqual({ outcome: "clamp", amountCents: 450n });
  });
  it.each([
    [ask(750n)],
    [ask(750n), ask(850n, { currencyCode: "CAD" })],
    [ask(750n), ask(850n, { currencyCode: null })],
    [ask(750n), ask(850n, { sellerAccountId: "acc_synthetic" })],
    [ask(750n), ask(850n, { pricingMode: "derived" })],
    [ask(100n), ask(850n)],
  ])("does not use a single, incompatible, own, derived or outlier ask as Second Ask (%#)", (...asks) => {
    expect(marketEvidenceFloor.apply(context({ otherSellerHardAsks: asks }))).toEqual({
      outcome: "clamp",
      amountCents: 900n,
    });
  });
  it.each(["absent", "stale", "currency-incomplete", "currency-mismatch"] as const)(
    "is inert for %s estimate",
    (state) => {
      expect(marketEvidenceFloor.apply(context({ marketEstimate: { state } }))).toEqual({ outcome: "inert" });
    },
  );
  it("does not trust a present estimate's mismatched currency", () => {
    expect(
      marketEvidenceFloor.apply(
        context({ marketEstimate: { state: "present", currencyCode: "CAD", amountCents: 1000n } }),
      ),
    ).toEqual({ outcome: "inert" });
  });
  it.each(["stale", "absent", "currency-incomplete", "currency-mismatch"] as const)(
    "does not release to a %s Curve Low",
    (state) => {
      const curve = {
        state,
        currencyCode: state === "currency-incomplete" ? null : "USD",
        points: [point(800n)],
      } as GuardrailCurveSummary;
      expect(marketEvidenceFloor.apply(context({ curve }))).toEqual({ outcome: "clamp", amountCents: 900n });
    },
  );
  it("does not release to a present curve in another currency or an empty curve", () => {
    for (const curve of [
      { state: "present", currencyCode: "CAD", points: [point(800n)] },
      { state: "present", currencyCode: "USD", points: [] },
    ] as const)
      expect(marketEvidenceFloor.apply(context({ curve }))).toEqual({ outcome: "clamp", amountCents: 900n });
  });
  it("holds only when the fastest curve point is hopeless and the resolved anchor is curve-objective", () => {
    const curve = {
      state: "present",
      currencyCode: "USD",
      points: [point(950n, 400, true), point(800n, 200, true)],
    } as const;
    expect(hopelessForecastHold.apply(context({ curve }))).toEqual({
      outcome: "hold",
      reason: "hopeless-forecast-hold",
    });
    expect(hopelessForecastHold.apply(context({ curve, resolvedAnchorSource: "market-estimate" }))).toEqual({
      outcome: "inert",
    });
    expect(
      hopelessForecastHold.apply(
        context({ curve: { ...curve, points: [point(950n, 400, true), point(800n, 10, false)] } }),
      ),
    ).toEqual({ outcome: "inert" });
    expect(hopelessForecastHold.apply(context())).toEqual({ outcome: "inert" });
    for (const state of ["stale", "absent", "currency-incomplete", "currency-mismatch"] as const) {
      expect(hopelessForecastHold.apply(context({ curve: { ...curve, state } }))).toEqual({ outcome: "inert" });
    }
    expect(hopelessForecastHold.apply(context({ curve: { ...curve, currencyCode: "CAD" } }))).toEqual({
      outcome: "inert",
    });
    expect(hopelessForecastHold.apply(context({ curve: { ...curve, points: [] } }))).toEqual({ outcome: "inert" });
  });
});
