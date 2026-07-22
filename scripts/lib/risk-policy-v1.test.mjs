import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { RISK_POLICY_V1, classifyRisk } from "./risk-policy-v1.mjs";

const highRiskCases = [
  ["money movement", "bounded-contexts/payments/features/refunds/domain/refund.ts", "money-movement"],
  ["settlement", "bounded-contexts/settlement/features/payouts/domain/payout.ts", "money-movement"],
  ["tax collection", "bounded-contexts/ordering/features/tax-quotes/domain/quote.ts", "money-movement"],
  ["public contract", "contracts/domain-events/src/order-paid.ts", "cross-context-contract"],
  ["event subscription metadata", "bounded-contexts/pricing/context.json", "cross-context-contract"],
  ["database migration", "bounded-contexts/catalog/migrations/019-add-index.sql", "database-change"],
  [
    "runtime projection migration",
    "bounded-contexts/fulfillment/support/runtime-support/unlogged-projection-migrations.ts",
    "database-change",
  ],
  ["destructive retention", "scripts/catalog-retention-purge.mjs", "database-change"],
  ["authentication", "bounded-contexts/auth/features/sign-in/domain/session.ts", "security-policy"],
  ["authorization", "bounded-contexts/catalog/features/authorization/policy.ts", "security-policy"],
  ["Terraform", "infrastructure/digitalocean/platform/main.tf", "deployment-control"],
  ["Helm", "infrastructure/helm/platform/templates/deployment.yaml", "deployment-control"],
  ["deployment workflow", ".github/workflows/platform-production.yml", "deployment-control"],
  ["rollback control", "scripts/rollback-readiness.mjs", "deployment-control"],
  ["shared shell integration", "deployables/admin-web/app/admin-root-shell.tsx", "integration-surface"],
  [
    "design-system navigation integration",
    "packages/design-system/src/components/actions/navigation-menu.tsx",
    "integration-surface",
  ],
  ["risk evaluator", "scripts/platform-risk-review.mjs", "risk-policy"],
];

describe("risk-policy/v1", () => {
  it.each(highRiskCases)("classifies %s through canonical semantics", (_label, filename, category) => {
    const result = classifyRisk({ changedFiles: [{ filename, status: "modified" }] });

    expect(result.classification).toBe("high");
    expect(result.categories).toContain(category);
    expect(result.scan).toEqual({ filesScanned: 1, pathsScanned: 1, uniquePathsScanned: 1, totalSurface: 1 });
  });

  it.each([
    "docs/architecture/payments-overview.md",
    "bounded-contexts/payments/features/refunds/domain/refund.test.ts",
    "bounded-contexts/auth/features/sign-in/domain/session.spec.ts",
    "deployables/marketplace/app/routes/browse.tsx",
    "scripts/fixtures/generated/catalog.json",
    "arbitrary/new/location/value.ts",
  ])("keeps a low-risk counterexample low: %s", (filename) => {
    expect(classifyRisk({ changedFiles: [{ filename, status: "modified" }] }).classification).toBe("low");
  });

  it("classifies the old and new paths of renames and reports the complete discovered surface", () => {
    const result = classifyRisk({
      changedFiles: [
        {
          filename: "archive/payments.ts",
          previousFilename: "bounded-contexts/payments/domain/capture.ts",
          status: "renamed",
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: null,
        },
      ],
    });

    expect(result.classification).toBe("high");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ path: "bounded-contexts/payments/domain/capture.ts" }),
    );
    expect(result.scan).toEqual({ filesScanned: 1, pathsScanned: 2, uniquePathsScanned: 2, totalSurface: 2 });
  });

  it("classifies deleted risky files", () => {
    const result = classifyRisk({
      changedFiles: [{ filename: "infrastructure/helm/platform/templates/secret.yaml", status: "removed" }],
    });
    expect(result.categories).toContain("deployment-control");
  });

  it("couples generated metadata only when a high-risk source is present", () => {
    const generated = { filename: "bounded-contexts/catalog/features/listings/generated/index.ts", status: "modified" };
    expect(classifyRisk({ changedFiles: [generated] }).classification).toBe("low");

    const mixed = classifyRisk({
      changedFiles: [generated, { filename: "bounded-contexts/payments/domain/capture.ts", status: "modified" }],
    });
    expect(mixed.categories).toContain("generated-coupling");
    expect(mixed.findings).toContainEqual(
      expect.objectContaining({ source: "generated-coupling", path: generated.filename }),
    );
  });

  it("supports only the approved explicit high-risk label", () => {
    expect(classifyRisk({ changedFiles: [], labels: ["risk:high"] }).categories).toEqual(["explicit-label"]);
    expect(classifyRisk({ changedFiles: [], labels: ["high-risk-ish"] }).classification).toBe("low");
  });

  it("rejects unknown and malformed nested change metadata", () => {
    expect(() => classifyRisk({ changedFiles: [{ filename: "x.ts", status: "modified", mystery: true }] })).toThrow(
      /unknown field/,
    );
    expect(() => classifyRisk({ changedFiles: [{ filename: "x.ts", status: "renamed" }] })).toThrow(/previousFilename/);
    expect(() => classifyRisk({ changedFiles: [""] })).toThrow(/non-empty path/);
  });

  it("is the single risk vocabulary consumed by change-scope and trusted-base workflow support", async () => {
    const [changeScope, e2eSuites, workflow] = await Promise.all([
      readFile(new URL("../change-scope.mjs", import.meta.url), "utf8"),
      readFile(new URL("../e2e-suites.mjs", import.meta.url), "utf8"),
      readFile(new URL("../../.github/workflows/platform-risk-review.yml", import.meta.url), "utf8"),
    ]);

    expect(RISK_POLICY_V1.categories).toEqual(
      expect.arrayContaining([
        "money-movement",
        "cross-context-contract",
        "database-change",
        "security-policy",
        "deployment-control",
      ]),
    );
    expect(changeScope).toContain('from "./lib/risk-policy-v1.mjs"');
    expect(changeScope).not.toContain("integrationRiskPatterns");
    expect(e2eSuites).toContain("isDesignSystemNavigationRiskPath");
    expect(workflow).toContain('"scripts/lib/risk-policy-v1.mjs"');
  });
});
