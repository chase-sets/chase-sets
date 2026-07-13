import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const contextRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const architectureDocPath = resolve(contextRoot, "docs/catalog-integration-test-architecture.md");
const readModelTestPaths = [
  "primary-workbench-core-read-model.test.ts",
  "primary-workbench-profile-authoring.test.ts",
  "primary-workbench-validation-readiness.test.ts",
  "primary-workbench-lifecycle-recovery.test.ts",
  "primary-workbench-import-jobs.test.ts",
  "primary-workbench-health-triage.test.ts",
  "primary-workbench-source-observation-review.test.ts",
  "primary-workbench-conflict-resolution.test.ts",
  "primary-workbench-governance-controls.test.ts",
  "primary-workbench-audit-evidence.test.ts",
].map((fileName) => resolve(contextRoot, "features/source-observations/ui", fileName));
const pageTestPath = resolve(contextRoot, "features/source-observations/ui/primary-workbench-page.test.tsx");
const acceptanceGateTestPath = resolve(
  contextRoot,
  "features/source-observations/tests/catalog-integration-no-confusion-ux-acceptance.test.ts",
);
const routeTestPaths = [
  "admin-integrations-route-render.test.tsx",
  "admin-integrations-route-loader-core.test.tsx",
  "admin-integrations-route-loader-source-options.test.tsx",
  "admin-integrations-route-loader-provider-units.test.tsx",
  "admin-integrations-route-loader-operator.test.tsx",
  "admin-integrations-route-action.test.tsx",
  "admin-integrations-route-governance.test.tsx",
].map((fileName) => resolve(contextRoot, "tests", fileName));

describe("Catalog integration test architecture", () => {
  const doc = readFileSync(architectureDocPath, "utf8");

  it("keeps issue-required boundaries mapped to focused coverage", () => {
    const requiredAnchors = [
      "provider-adapters/provider-adapter.test.ts",
      "catalog-integration-engine.test.ts",
      "provider-profile-contract-harness.test.ts",
      "provider-profile-admin-contracts.test.ts",
      "provider-profile-section-registry.test.ts",
      "provider-profile-section-projection.test.ts",
      "runtime-service-facets.test.ts",
      "runtime.test.ts",
      "route-integration-jobs.test.ts",
      "route-provider-profile-admin.test.ts",
      "route-review-controls.test.ts",
      "primary-workbench-core-read-model.test.ts",
      "primary-workbench-profile-authoring.test.ts",
      "primary-workbench-validation-readiness.test.ts",
      "primary-workbench-lifecycle-recovery.test.ts",
      "primary-workbench-import-jobs.test.ts",
      "primary-workbench-health-triage.test.ts",
      "primary-workbench-source-observation-review.test.ts",
      "primary-workbench-conflict-resolution.test.ts",
      "primary-workbench-governance-controls.test.ts",
      "primary-workbench-audit-evidence.test.ts",
      "primary-workbench-page.test.tsx",
      "primary-workbench-route-context.test.ts",
      "primary-workbench-copy.test.ts",
      "admin-integrations-route-loader-core.test.tsx",
      "admin-integrations-route-loader-operator.test.tsx",
      "admin-integrations-route-loader-provider-units.test.tsx",
      "admin-integrations-route-loader-source-options.test.tsx",
      "admin-integrations-route-action.test.tsx",
      "admin-integrations-route-governance.test.tsx",
      "admin-integrations-route-render.test.tsx",
      "operator-acceptance-journeys.test.ts",
      "catalog-integration-no-confusion-ux-acceptance.test.ts",
    ];

    for (const anchor of requiredAnchors) {
      expect(doc).toContain(anchor);
    }
  });

  it("documents that provider, engine, API, runtime, UI, and E2E tests own different behavior", () => {
    expect(doc).toContain("Provider adapter tests may assert auth/session state");
    expect(doc).toContain("Catalog Integration Engine tests may assert Source Observation facts");
    expect(doc).toContain("API route tests may assert request validation");
    expect(doc).toContain("Runtime facet tests may prove the aggregate runtime");
    expect(doc).toContain("Primary workbench read-model seam tests, copy tests, and route-context tests own");
    expect(doc).toContain("E2E tests cover representative happy paths and critical blocked states");
  });

  it("anchors launch acceptance to rebuilt workbench tests and rejects old page evidence anchors", () => {
    const readModelTest = readModelTestPaths.map((testPath) => readFileSync(testPath, "utf8")).join("\n");
    const pageTest = readFileSync(pageTestPath, "utf8");
    const acceptanceGateTest = readFileSync(acceptanceGateTestPath, "utf8");

    expect(readModelTest).toContain("buildCatalogPrimaryWorkbenchReadModel");
    expect(pageTest).toContain("CatalogPrimaryWorkbenchPage");
    expect(acceptanceGateTest).toContain("no-confusion UX acceptance gate");
    expect(doc).not.toContain(["integration", "management", "page.test.tsx"].join("-"));
    expect(doc).not.toContain(["source", "observation", "list", "page.test.tsx"].join("-"));
    expect(doc).not.toContain("deployables/admin-web/e2e/catalog-integrations.spec.ts");
  });

  it("keeps the integrations route coverage split by behavior", () => {
    for (const routeTestPath of routeTestPaths) {
      expect(readFileSync(routeTestPath, "utf8")).toContain('describe("Catalog integrations route"');
    }
  });
});
