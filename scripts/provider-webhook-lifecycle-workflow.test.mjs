import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/platform-production-stripe-webhook-endpoint-verify.yml", "utf8");

describe("Stripe webhook contract proof workflow", () => {
  it("uses the existing preview test-mode credential path without adding secret names", () => {
    expect(workflow).toContain("environment: preview");
    expect(workflow).toContain("if: github.ref != 'refs/heads/main'");
    expect(workflow).toContain("provider-webhook-lifecycle.mjs prove-payment-events");
    expect(new Set([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((match) => match[1]))).toEqual(
      new Set(["STRIPE_SECRET_KEY"]),
    );
  });
});
