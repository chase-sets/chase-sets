import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const contextRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const architectureDocPath = resolve(contextRoot, "docs/catalog-integration-test-architecture.md");
const readModelTestPath = resolve(contextRoot, "features/source-observations/ui/primary-workbench-read-model.test.ts");
const pageTestPath = resolve(contextRoot, "features/source-observations/ui/primary-workbench-page.test.tsx");
const acceptanceGateTestPath = resolve(
  contextRoot,
  "features/source-observations/api/catalog-integration-no-confusion-ux-acceptance.test.ts",
);

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
      "route.test.ts",
      "primary-workbench-read-model.test.ts",
      "primary-workbench-page.test.tsx",
      "primary-workbench-route-context.test.ts",
      "primary-workbench-copy.test.ts",
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
    expect(doc).toContain("Primary workbench read-model/copy/route-context tests own");
    expect(doc).toContain("E2E tests cover representative happy paths and critical blocked states");
  });

  it("anchors launch acceptance to rebuilt workbench tests and rejects old page evidence anchors", () => {
    const readModelTest = readFileSync(readModelTestPath, "utf8");
    const pageTest = readFileSync(pageTestPath, "utf8");
    const acceptanceGateTest = readFileSync(acceptanceGateTestPath, "utf8");

    expect(readModelTest).toContain("buildCatalogPrimaryWorkbenchReadModel");
    expect(pageTest).toContain("CatalogPrimaryWorkbenchPage");
    expect(acceptanceGateTest).toContain("no-confusion UX acceptance gate");
    expect(doc).not.toContain("integration-management-page.test.tsx");
    expect(doc).not.toContain("source-observation-list-page.test.tsx");
    expect(doc).not.toContain("deployables/admin-web/e2e/catalog-integrations.spec.ts");
  });
});
