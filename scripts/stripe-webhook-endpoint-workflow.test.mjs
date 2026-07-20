import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(".github/workflows/platform-production-stripe-webhook-endpoint-verify.yml"),
  "utf8",
);

describe("production Stripe webhook endpoint verification workflow", () => {
  it("exposes only the fixed verify-only production command", () => {
    expect(workflow).toContain("workflow_dispatch: {}");
    expect(workflow).not.toMatch(/^\s+inputs:/m);
    expect(workflow).not.toContain("${{ inputs.");
    expect(workflow).not.toContain("${{ github.event.inputs.");
    expect(workflow).toContain("run: pnpm run ops stripe:webhook-endpoint -- verify --environment production");
    expect(workflow).not.toContain("repoint-staging");
  });

  it("refuses to expose the production secret to code from another ref", () => {
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toMatch(/actions\/checkout@[^\n]+\n\s+with:\n\s+ref: refs\/heads\/main/);
  });

  it("uses only the production environment secret with read-only repository permissions", () => {
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}");
    expect(workflow).toMatch(/permissions:\n  contents: read/);
  });
});
