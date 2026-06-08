import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const contextRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const architectureDocPath = resolve(contextRoot, "docs/catalog-integration-test-architecture.md");
const previewTestPath = resolve(
  contextRoot,
  "features/source-observations/ui/integration-management-profile-previews.test.ts",
);
const pageTestPath = resolve(contextRoot, "features/source-observations/ui/integration-management-page.test.tsx");

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
      "integration-management-profile-previews.test.ts",
      "integration-management-page.test.tsx",
      "source-observation-list-page.test.tsx",
      "operator-acceptance-journeys.test.ts",
      "deployables/admin-web/e2e/catalog-integrations.spec.ts",
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
    expect(doc).toContain("UI profile preview tests own pure form-to-preview behavior");
    expect(doc).toContain("E2E tests cover representative happy paths and critical blocked states");
  });

  it("moves pure profile-preview coverage out of the rendered page suite", () => {
    const previewTest = readFileSync(previewTestPath, "utf8");
    const pageTest = readFileSync(pageTestPath, "utf8");

    expect(previewTest).toContain("builds provider option import surface preview text");
    expect(previewTest).toContain("builds ordered promotion command previews from fixture payloads");
    expect(pageTest).not.toContain("builds provider option import surface preview text");
    expect(pageTest).not.toContain("builds ordered promotion command previews from fixture payloads");
  });
});
