import { existsSync, readFileSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertCheckoutVisualTargetCoverage,
  checkoutVisualRequiredTargets,
  checkoutVisualSuppliedReferenceFiles,
  checkoutVisualTargetArtifacts,
  checkoutVisualTargetAssetDirectory,
  checkoutVisualTargetDocPath,
  checkoutVisualTargets,
  type CheckoutVisualTargetKey,
} from "./checkout-visual-targets";

describe("Checkout visual targets", () => {
  it("passes the executable coverage assertion", () => {
    expect(() => assertCheckoutVisualTargetCoverage()).not.toThrow();
  });

  it("defines every required Milestone 17 visual target once", () => {
    const surfaces = checkoutVisualTargets.map((target) => target.surface);

    expect(new Set(surfaces).size).toBe(surfaces.length);
    expect(surfaces).toEqual(expect.arrayContaining([...checkoutVisualRequiredTargets]));
  });

  it("persists generated image-first artifacts under Checkout docs", () => {
    expect(checkoutVisualTargetArtifacts.map((artifact) => artifact.key)).toEqual(
      expect.arrayContaining(["buy-flow", "sell-flow", "recovery-launch", "capability-states"]),
    );

    for (const artifact of checkoutVisualTargetArtifacts) {
      const artifactUrl = new URL(`../../../../../${artifact.path}`, import.meta.url);

      expect(artifact.path, artifact.key).toContain(checkoutVisualTargetAssetDirectory);
      expect(artifact.path, artifact.key).toMatch(/\.png$/);
      expect(existsSync(artifactUrl), artifact.path).toBe(true);
      expect(statSync(artifactUrl).size, artifact.path).toBeGreaterThan(100_000);
      expect(artifact.reviewStatus, artifact.key).toBe("ready-for-design-review");
    }
  });

  it("keeps readiness and optional optimization outside checkout", () => {
    const readinessTargets = [
      "buy-readiness-unassigned-fulfillment",
      "buy-readiness-optimization",
      "sell-list-readiness-blocked",
    ] as const satisfies readonly CheckoutVisualTargetKey[];

    for (const surface of readinessTargets) {
      const target = checkoutVisualTargets.find((entry) => entry.surface === surface);

      expect(target?.readinessBeforeCheckout, surface).toBe(true);
      expect(target?.layoutRequirements, surface).toContain("cart-list-before-checkout");
      expect(target?.noSideEffectCopyRequired, surface).toBe(true);
      expect(target?.forbiddenPatterns, surface).toEqual(
        expect.arrayContaining(["allocation-control", "provider-diagnostic", "dense-checkout-panel"]),
      );
    }
  });

  it("requires Shopify-simple responsive layout coverage for checkout screens", () => {
    const desktopCheckoutTargets = checkoutVisualTargets.filter(
      (target) =>
        target.surface === "guest-buy-checkout" ||
        target.surface === "guest-sell-checkout" ||
        target.surface === "signed-in-sell-checkout" ||
        target.surface === "split-group-summary",
    );

    for (const target of desktopCheckoutTargets) {
      expect(target.layoutRequirements, target.surface).toContain("desktop-two-column-checkout");
      expect(target.layoutRequirements, target.surface).toContain("no-horizontal-overflow");
    }

    const mobileCheckoutTargets = checkoutVisualTargets.filter(
      (target) =>
        target.viewports.includes("mobile") &&
        (target.visibleState === "checkout-review-visible" ||
          target.visibleState === "checkout-permanent-recovery-visible" ||
          target.visibleState === "reversal-or-recovery-status-visible"),
    );

    expect(mobileCheckoutTargets.length).toBeGreaterThanOrEqual(5);
    for (const target of mobileCheckoutTargets) {
      expect(target.layoutRequirements, target.surface).toContain("mobile-single-column-checkout");
      expect(target.layoutRequirements, target.surface).toContain("no-horizontal-overflow");
    }
  });

  it("separates pending activity from committed downstream facts", () => {
    const pendingTargets = checkoutVisualTargets.filter((target) => target.pendingDownstreamBoundaryRequired);

    expect(pendingTargets.map((target) => target.surface)).toEqual(
      expect.arrayContaining([
        "seller-confirmation-activity",
        "notification-support-reference",
        "account-history-handoff",
        "reconciliation-pending",
        "reversal-recovery-status",
      ]),
    );

    for (const target of pendingTargets) {
      expect(target.layoutRequirements, target.surface).toContain("pending-vs-committed-separated");
      expect(target.forbiddenPatterns, target.surface).toContain("fake-downstream-completion");
    }
  });

  it("links visual targets to copy, performance, and acceptance coverage", () => {
    for (const target of checkoutVisualTargets) {
      expect(target.copySurface, target.surface).not.toHaveLength(0);
      expect(target.performanceSurface, target.surface).not.toHaveLength(0);
      expect(target.ownerIssues, target.surface).toContain("#1112");
      expect(target.deltaOwnerIssues, target.surface).toEqual(expect.arrayContaining(["#1115"]));
      expect(target.acceptanceNote, target.surface).not.toMatch(/\b(todo|tbd)\b/i);
    }
  });

  it("documents the image-first visual target register and supplied references", () => {
    const doc = readFileSync(new URL("../../../docs/checkout-visual-targets.md", import.meta.url), "utf8");
    const checkoutReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const docsIndex = readFileSync(new URL("../../../../../docs/README.md", import.meta.url), "utf8");

    expect(checkoutVisualTargetDocPath).toBe("bounded-contexts/checkout/docs/checkout-visual-targets.md");
    expect(doc).toContain("Checkout Visual Targets");
    expect(doc).toContain("image-first");
    expect(doc).toContain(
      "The executable contract lives in `bounded-contexts/checkout/features/sessions/api/checkout-visual-targets.ts`.",
    );
    expect(doc).toContain("Unassigned fulfillment stays in Buy Cart or Sell List readiness");
    expect(doc).toContain("pending Checkout activity from committed downstream facts");
    expect(checkoutReadme).toContain("./docs/checkout-visual-targets.md");
    expect(docsIndex).toContain("../bounded-contexts/checkout/docs/checkout-visual-targets.md");

    for (const artifact of checkoutVisualTargetArtifacts) {
      expect(doc, artifact.path).toContain(artifact.path);
    }

    for (const reference of checkoutVisualSuppliedReferenceFiles) {
      expect(doc, reference).toContain(reference);
    }

    for (const target of checkoutVisualTargets) {
      expect(doc, target.surface).toContain(`| ${target.docLabel} |`);
    }
  });
});
