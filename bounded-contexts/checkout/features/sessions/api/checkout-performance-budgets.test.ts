import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertCheckoutPerformanceBudgetCoverage,
  checkoutPerformanceBudgetDocPath,
  checkoutPerformanceBudgets,
  checkoutPerformancePlatformGatewayTimeoutMs,
  checkoutPerformanceRequiredSurfaces,
  type CheckoutPerformanceActorMode,
  type CheckoutPerformanceEntrySource,
  type CheckoutSideEffectClass,
} from "./checkout-performance-budgets";

const allEnvironments = ["local", "staging", "production-like"] as const;
const allEntrySources = [
  "buy-now",
  "buy-cart-readiness",
  "sell-list-readiness",
] as const satisfies readonly CheckoutPerformanceEntrySource[];
const allActorModes = ["guest", "signed-in"] as const satisfies readonly CheckoutPerformanceActorMode[];
const downstreamSideEffects = [
  "payment",
  "order",
  "label",
  "payout",
  "settlement",
  "notification",
  "account-history",
  "support",
] as const satisfies readonly CheckoutSideEffectClass[];

describe("Checkout performance budgets", () => {
  it("passes the executable coverage assertion", () => {
    expect(() => assertCheckoutPerformanceBudgetCoverage()).not.toThrow();
  });

  it("defines every required Milestone 17 surface once", () => {
    const surfaces = checkoutPerformanceBudgets.map((budget) => budget.surface);

    expect(new Set(surfaces).size).toBe(surfaces.length);
    expect(surfaces).toEqual(expect.arrayContaining([...checkoutPerformanceRequiredSurfaces]));
  });

  it("keeps route timeouts below the platform gateway with visible-state targets", () => {
    for (const budget of checkoutPerformanceBudgets) {
      expect(budget.p95Ms, budget.surface).toBeGreaterThan(0);
      expect(budget.timeoutMs, budget.surface).toBeGreaterThanOrEqual(budget.p95Ms);
      expect(budget.timeoutMs + budget.gatewayHeadroomMs, budget.surface).toBeLessThanOrEqual(
        checkoutPerformancePlatformGatewayTimeoutMs,
      );
      expect(budget.visibleStates.length, budget.surface).toBeGreaterThan(0);
      expect(budget.ambiguousNoStateFails, budget.surface).toBe(true);
    }
  });

  it("requires local, staging, and production-like evidence for every surface", () => {
    for (const budget of checkoutPerformanceBudgets) {
      expect(budget.environments, budget.surface).toEqual(expect.arrayContaining([...allEnvironments]));
      expect(budget.verification.length, budget.surface).toBeGreaterThan(0);
      expect(budget.acceptanceNote, budget.surface).not.toMatch(/\b(todo|tbd)\b/i);
    }
  });

  it("covers every checkout entry source and actor for review, temporary recovery, and permanent recovery", () => {
    const checkoutEntryBudgets = checkoutPerformanceBudgets.filter((budget) =>
      budget.surface.startsWith("checkout-entry-"),
    );

    expect(checkoutEntryBudgets.map((budget) => budget.surface)).toEqual(
      expect.arrayContaining([
        "checkout-entry-review-render",
        "checkout-entry-temporary-recovery-render",
        "checkout-entry-permanent-recovery-render",
      ]),
    );

    for (const budget of checkoutEntryBudgets) {
      expect(budget.entrySources, budget.surface).toEqual(expect.arrayContaining([...allEntrySources]));
      expect(budget.actorModes, budget.surface).toEqual(expect.arrayContaining([...allActorModes]));
      expect(budget.sideEffectsForbiddenBeforeExplicitConfirm, budget.surface).toEqual(
        expect.arrayContaining([...downstreamSideEffects]),
      );
    }
  });

  it("sets launch-supported line and group counts for composite buy and sell evidence", () => {
    for (const budget of checkoutPerformanceBudgets) {
      expect(budget.maxLines, budget.surface).toBeGreaterThanOrEqual(50);
      expect(budget.maxFulfillmentGroups, budget.surface).toBeGreaterThanOrEqual(8);
      expect(budget.maxSummaryRows, budget.surface).toBeGreaterThanOrEqual(budget.maxLines);
    }

    expect(
      checkoutPerformanceBudgets.filter(
        (budget) => budget.maxFulfillmentGroups > 1 && budget.verification.some((kind) => kind === "e2e"),
      ).length,
    ).toBeGreaterThanOrEqual(8);
  });

  it("documents the executable budget contract and launch failure rules", () => {
    const doc = readFileSync(new URL("../../../docs/checkout-performance-budgets.md", import.meta.url), "utf8");
    const checkoutReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const docsIndex = readFileSync(new URL("../../../../../docs/README.md", import.meta.url), "utf8");

    expect(checkoutPerformanceBudgetDocPath).toBe("bounded-contexts/checkout/docs/checkout-performance-budgets.md");
    expect(doc).toContain("Checkout Performance Budgets");
    expect(doc).toContain("ambiguous no-state renders fail this gate");
    expect(doc).toContain("up to 50 cart or Sell List lines");
    expect(doc).toContain("up to 8 fulfillment or seller groups");
    expect(doc).toContain("Buy Now, Buy Cart readiness, and Sell List readiness");
    expect(doc).toContain(
      "payment, order, label, payout, settlement, notification, account-history, and support side effects are not attempted",
    );
    expect(doc).toContain(
      "The executable contract lives in `bounded-contexts/checkout/features/sessions/api/checkout-performance-budgets.ts`.",
    );
    expect(checkoutReadme).toContain("./docs/checkout-performance-budgets.md");
    expect(docsIndex).toContain("../bounded-contexts/checkout/docs/checkout-performance-budgets.md");

    for (const budget of checkoutPerformanceBudgets) {
      expect(doc, budget.surface).toContain(
        `| ${budget.docLabel} | ${formatMs(budget.p95Ms)} | ${formatMs(budget.timeoutMs)} |`,
      );
    }
  });
});

function formatMs(value: number): string {
  return `${value.toLocaleString("en-US")} ms`;
}
