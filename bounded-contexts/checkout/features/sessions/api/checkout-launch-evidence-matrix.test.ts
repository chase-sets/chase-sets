import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checkoutCopyPolicyEntries } from "./checkout-copy-policy";
import { checkoutPerformanceBudgets } from "./checkout-performance-budgets";
import {
  assertCheckoutLaunchEvidenceMatrixCoverage,
  checkoutLaunchEvidenceMatrixDocPath,
  checkoutLaunchEvidenceRequiredScenarioStates,
  checkoutLaunchEvidenceRows,
  type CheckoutLaunchScenarioState,
} from "./checkout-launch-evidence-matrix";
import {
  checkoutVisualRequiredTargets,
  checkoutVisualTargets,
  type CheckoutVisualTargetKey,
} from "./checkout-visual-targets";

describe("Checkout launch evidence matrix", () => {
  it("passes the executable coverage assertion", () => {
    expect(() => assertCheckoutLaunchEvidenceMatrixCoverage()).not.toThrow();
  });

  it("defines one launch evidence row for every required visual target", () => {
    const states = checkoutLaunchEvidenceRows.map((row) => row.state);

    expect(new Set(states).size).toBe(states.length);
    expect(states).toEqual(expect.arrayContaining([...checkoutVisualRequiredTargets]));
  });

  it("covers every required Milestone 17 scenario state", () => {
    const scenarioStates = new Set<CheckoutLaunchScenarioState>(
      checkoutLaunchEvidenceRows.flatMap((row) => row.scenarioStates),
    );

    for (const requiredScenario of checkoutLaunchEvidenceRequiredScenarioStates) {
      expect(scenarioStates.has(requiredScenario), requiredScenario).toBe(true);
    }
  });

  it("keeps rows anchored to approved copy, visual, and performance contracts", () => {
    const copySurfaces = new Set(checkoutCopyPolicyEntries.map((entry) => entry.surface));
    const performanceBySurface = new Map(checkoutPerformanceBudgets.map((budget) => [budget.surface, budget]));
    const visualBySurface = new Map(checkoutVisualTargets.map((target) => [target.surface, target]));

    for (const row of checkoutLaunchEvidenceRows) {
      const visualTarget = visualBySurface.get(row.visualTarget);
      const performanceBudget = performanceBySurface.get(row.performanceSurface);

      expect(row.state, row.state).toBe(row.visualTarget);
      expect(copySurfaces.has(row.copySurface), row.state).toBe(true);
      expect(performanceBudget, row.state).toBeDefined();
      expect(performanceBudget?.visibleStates, row.state).toContain(row.visibleState);
      expect(visualTarget?.copySurface, row.state).toBe(row.copySurface);
      expect(visualTarget?.performanceSurface, row.state).toBe(row.performanceSurface);
      expect(visualTarget?.visibleState, row.state).toBe(row.visibleState);
      expect(row.requiredEvidence, row.state).toEqual(expect.arrayContaining(["copy-policy", "visual-target"]));
    }
  });

  it("keeps unassigned fulfillment and optional optimization outside checkout", () => {
    const readinessStates = [
      "buy-readiness-unassigned-fulfillment",
      "buy-readiness-optimization",
      "sell-list-readiness-blocked",
    ] as const satisfies readonly CheckoutVisualTargetKey[];

    for (const state of readinessStates) {
      const row = checkoutLaunchEvidenceRows.find((entry) => entry.state === state);

      expect(row?.phase, state).toBe("cart-list-readiness");
      expect(row?.readinessBeforeCheckout, state).toBe(true);
      expect(row?.sideEffectStatus, state).toMatch(/not-attempted|forbidden-before-confirm/);
      expect(row?.freshStateCleanupProofRequired, state).toBe(true);
    }

    expect(
      checkoutLaunchEvidenceRows.find((row) => row.state === "buy-readiness-optimization")?.scenarioStates,
    ).toEqual(expect.arrayContaining(["optimization-accepted", "optimization-declined"]));
  });

  it("requires launch-register evidence for constrained, recovery, downstream, and cleanup rows", () => {
    const launchRows = checkoutLaunchEvidenceRows.filter((row) => row.launchRegisterStatus === "required");

    expect(launchRows.length).toBeGreaterThan(15);
    for (const row of launchRows) {
      expect(row.ownerIssues, row.state).toContain("#1116");
      expect(row.requiredEvidence, row.state).toContain("launch-register");
      expect(row.launchEvidenceExpectation, row.state).not.toMatch(/\b(todo|tbd)\b/i);
    }
  });

  it("separates pending downstream handoff from committed downstream facts", () => {
    const pendingRows = checkoutLaunchEvidenceRows.filter((row) => row.pendingDownstreamBoundaryRequired);

    expect(pendingRows.map((row) => row.state)).toEqual(
      expect.arrayContaining([
        "seller-confirmation-activity",
        "notification-support-reference",
        "account-history-handoff",
        "reconciliation-pending",
        "reversal-recovery-status",
      ]),
    );

    for (const row of pendingRows) {
      expect(row.supportReferenceRequired, row.state).toBe(true);
      expect(row.requiredEvidence, row.state).toEqual(
        expect.arrayContaining(["observability-event", "support-runbook"]),
      );

      if (row.state !== "account-history-handoff") {
        expect(row.sideEffectStatus, row.state).not.toBe("downstream-owned-committed");
      }
    }
  });

  it("requires fresh-state cleanup evidence on every launch row", () => {
    for (const row of checkoutLaunchEvidenceRows) {
      expect(row.freshStateCleanupProofRequired, row.state).toBe(true);
    }

    expect(
      checkoutLaunchEvidenceRows.find((row) => row.state === "fresh-state-cleanup-absence")?.scenarioStates,
    ).toEqual(expect.arrayContaining(["fresh-state-cleanup", "kill-switch"]));
  });

  it("documents the executable launch evidence matrix", () => {
    const doc = readFileSync(new URL("../../../docs/checkout-launch-evidence-matrix.md", import.meta.url), "utf8");
    const checkoutReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const docsIndex = readFileSync(new URL("../../../../../docs/README.md", import.meta.url), "utf8");

    expect(checkoutLaunchEvidenceMatrixDocPath).toBe(
      "bounded-contexts/checkout/docs/checkout-launch-evidence-matrix.md",
    );
    expect(doc).toContain("Checkout Launch Evidence Matrix");
    expect(doc).toContain(
      "The executable contract lives in `bounded-contexts/checkout/features/sessions/api/checkout-launch-evidence-matrix.ts`.",
    );
    expect(doc).toContain("Unassigned fulfillment and optional savings optimization stay before checkout");
    expect(doc).toContain("pending downstream handoff from committed downstream facts");
    expect(checkoutReadme).toContain("./docs/checkout-launch-evidence-matrix.md");
    expect(docsIndex).toContain("../bounded-contexts/checkout/docs/checkout-launch-evidence-matrix.md");

    for (const row of checkoutLaunchEvidenceRows) {
      expect(doc, row.state).toContain(`| ${row.docLabel} |`);
    }
  });
});
