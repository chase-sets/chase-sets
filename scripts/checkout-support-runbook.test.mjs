import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const runbook = readFileSync(new URL("../docs/runbooks/checkout-support-operations.md", import.meta.url), "utf8");
const platformReadiness = readFileSync(
  new URL("../bounded-contexts/platform-operations/docs/support-operations-readiness.md", import.meta.url),
  "utf8",
);
const ops = readFileSync(new URL("./ops.mjs", import.meta.url), "utf8");
const normalizedRunbook = runbook.replace(/\s+/g, " ");

describe("checkout support operations runbook", () => {
  it("covers the checkout support scenarios", () => {
    for (const heading of [
      "## Stuck Checkout Procedure",
      "## Payment Dispute Or Failure Procedure",
      "## Missing Or Failed Downstream Handoff Procedure",
      "## Refund Request Procedure",
    ]) {
      expect(runbook).toContain(heading);
    }

    for (const scenario of [
      "Stuck checkout before confirmation",
      "Payment failure, dispute, or duplicate charge concern",
      "Missing or failed order/sale/account-history handoff",
      "Buyer asks for refund",
    ]) {
      expect(runbook).toContain(scenario);
    }
  });

  it("keeps support recovery inside safe boundaries", () => {
    for (const requiredBoundary of [
      "Use only support-safe references",
      "Do not open a fake order or sale support request",
      "Never route a customer to the dense legacy checkout",
      "Support records pending downstream handoff as pending",
      "Items without fulfillment assignment stay in cart, Sell List, or the conditional pre-checkout readiness step",
    ]) {
      expect(normalizedRunbook).toContain(requiredBoundary);
    }
  });

  it("does not restore launch evidence ceremony", () => {
    expect(runbook).not.toContain("## Launch Evidence");
    expect(runbook).not.toContain("marketplace:support-operations-evidence");
    expect(runbook).not.toContain("Marketplace Launch Evidence packet");
    expect(platformReadiness).not.toContain("marketplace:support-operations-evidence");
    expect(platformReadiness).not.toContain("Marketplace Launch Evidence");
    expect(platformReadiness).not.toContain("launch evidence packet");
    expect(platformReadiness).not.toContain("rehearsalCompletedAt");
    expect(ops).not.toContain("marketplace:support-operations-evidence");
    expect(ops).not.toContain("marketplace-support-operations-evidence.mjs");
  });
});
