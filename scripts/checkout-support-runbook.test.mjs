import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const runbook = readFileSync(new URL("../docs/runbooks/checkout-support-operations.md", import.meta.url), "utf8");
const normalizedRunbook = runbook.replace(/\s+/g, " ");

describe("checkout support operations runbook", () => {
  it("covers the launch-required support scenarios", () => {
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

  it("keeps support recovery inside launch-safe boundaries", () => {
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
});
