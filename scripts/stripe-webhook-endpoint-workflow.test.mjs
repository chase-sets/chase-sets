import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(".github/workflows/platform-production-stripe-webhook-endpoint-verify.yml"),
  "utf8",
);
const createWorkflow = readFileSync(
  resolve(".github/workflows/platform-production-stripe-webhook-endpoint-create.yml"),
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

describe("production Stripe webhook endpoint creation workflow", () => {
  it("requires the exact production confirmation and remains main-only", () => {
    expect(createWorkflow).toContain("workflow_dispatch:");
    expect(createWorkflow).toContain("confirmation:");
    expect(createWorkflow).toContain("required: true");
    expect(createWorkflow).toContain("inputs.confirmation == 'create production payments webhook endpoint'");
    expect(createWorkflow).toContain("github.ref == 'refs/heads/main'");
    expect(createWorkflow).toMatch(/actions\/checkout@[^\n]+\n\s+with:\n\s+ref: refs\/heads\/main/);
    expect(createWorkflow).toContain('--confirm "$CONFIRMATION"');
  });

  it("uses a protected production environment, unique concurrency, and minimal permissions", () => {
    expect(createWorkflow).toContain("environment: production");
    expect(createWorkflow).toContain("group: platform-production-stripe-webhook-endpoint-create");
    expect(createWorkflow).toMatch(/permissions:\n  contents: read/);
    expect(createWorkflow).not.toMatch(/^\s{2}(?:actions|checks|deployments|issues|pull-requests): write$/m);
  });

  it("keeps credentials step-scoped and pipes the signing secret only to the production GitHub secret", () => {
    expect(createWorkflow).toContain("STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}");
    expect(createWorkflow).toContain("GH_TOKEN: ${{ secrets.GITHUB_ENVIRONMENT_SECRETS_TOKEN }}");
    expect(createWorkflow).not.toContain("GH_TOKEN: ${{ github.token }}");
    expect(createWorkflow).toContain("pnpm run ops stripe:webhook-endpoint -- create-canonical");
  });
});
