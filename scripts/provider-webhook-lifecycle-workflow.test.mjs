import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/stripe-webhook-contract-proof.yml", "utf8");

describe("Stripe webhook contract proof workflow", () => {
  it("uses the existing preview test-mode credential path without adding secret names", () => {
    expect(workflow).toContain("environment: preview");
    expect(workflow).toContain("provider-webhook-lifecycle.mjs prove-payment-events");
    expect([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((match) => match[1])).toEqual(["STRIPE_SECRET_KEY"]);
  });
});
