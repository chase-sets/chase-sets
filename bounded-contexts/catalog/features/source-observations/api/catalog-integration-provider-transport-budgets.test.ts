import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertCatalogProviderTransportBudgetCoverage,
  catalogProviderTransportBudgetDocPath,
  catalogProviderTransportFailureConditions,
  catalogProviderTransportFirstSliceBudgets,
  catalogProviderTransportFirstSliceProofProviders,
  catalogProviderTransportProofCriteria,
  catalogProviderTransportRetiredSurfaceRule,
  getCatalogProviderTransportFirstSliceProofProvider,
} from "./catalog-integration-provider-transport-budgets";
import { getCatalogAdminControlPlaneReadModelSlo } from "./admin-control-plane-read-model-slos";
import {
  catalogPrimaryWorkbenchBlockers,
  catalogPrimaryWorkbenchProviderTransportCategories,
  catalogPrimaryWorkbenchRetirementPolicy,
} from "./primary-workbench-admin-contracts";
import { TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY } from "./provider-adapters/tcgdex";
import { TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY } from "./provider-adapters/tcgplayer";

describe("Catalog provider transport budgets", () => {
  it("passes the executable coverage assertion", () => {
    expect(() => assertCatalogProviderTransportBudgetCoverage()).not.toThrow();
  });

  it("maps every primary workbench transport category to a fail-closed provider blocker", () => {
    const blockerByCategory = new Map(catalogPrimaryWorkbenchBlockers.map((blocker) => [blocker.category, blocker]));

    for (const category of catalogPrimaryWorkbenchProviderTransportCategories) {
      const condition = catalogProviderTransportFailureConditions.find(
        (entry) => entry.condition === category && entry.transportCategory === category,
      );

      expect(condition, category).toBeDefined();
      if (!condition) {
        throw new Error(`Missing condition for ${category}.`);
      }
      const blocker = blockerByCategory.get(condition.blockerCategory);

      expect(condition.firstSliceRequired).toBe(true);
      expect(condition.blockerCategory).toMatch(/^provider-transport-/);
      expect(blocker?.failClosed).toBe(true);
      expect(blocker?.actionStates).toContain(condition.actionState);
    }
  });

  it("selects TCGdex as the only first-slice proof provider and keeps TCGplayer supplemental", () => {
    const selected = getCatalogProviderTransportFirstSliceProofProvider();
    const tcgplayer = catalogProviderTransportFirstSliceProofProviders.find(
      (provider) => provider.providerKey === "tcgplayer",
    );

    expect(
      catalogProviderTransportFirstSliceProofProviders.filter((provider) => provider.selectedForFirstSlice),
    ).toHaveLength(1);
    expect(selected).toMatchObject({
      providerKey: "tcgdex",
      unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      role: "primary-first-slice",
      launchPromotionActive: true,
    });
    expect(tcgplayer).toMatchObject({
      unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      role: "supplemental-transport",
      selectedForFirstSlice: false,
      launchPromotionActive: false,
    });
  });

  it("requires the selected provider to cover every first-slice proof criterion or name an owner", () => {
    const selected = getCatalogProviderTransportFirstSliceProofProvider();
    const selectedCoverage = new Map(selected.coverage.map((entry) => [entry.criterion, entry]));

    for (const criterion of catalogProviderTransportProofCriteria) {
      const coverage = selectedCoverage.get(criterion.key);

      expect(criterion.requiredForFirstSlice, criterion.key).toBe(true);
      expect(coverage, criterion.key).toBeDefined();
      if (coverage?.status === "planned-proof") {
        expect(coverage.ownerIssue, criterion.key).toBeDefined();
        expect(criterion.ownerIssues).toContain(coverage.ownerIssue);
      }
    }

    expect(JSON.stringify(selected.coverage)).not.toMatch(/raw-json|two-page|compatibility redirect/i);
    expect(selectedCoverage.get("provider-transport-degraded-condition")).toMatchObject({
      status: "covered-by-test",
      ownerIssue: "#1062",
    });
    expect(selectedCoverage.get("promotion-preview-counts")).toMatchObject({
      status: "covered-by-test",
      ownerIssue: "#1062",
    });
    expect(selectedCoverage.get("redaction-safe-evidence")).toMatchObject({
      status: "covered-by-test",
      ownerIssue: "#1064",
    });
  });

  it("keeps provider transport budgets aligned with read-model SLOs and high-volume evidence", () => {
    const bySurface = new Map(catalogProviderTransportFirstSliceBudgets.map((budget) => [budget.surface, budget]));
    const selectorSlo = getCatalogAdminControlPlaneReadModelSlo("provider-transport-readiness-summary");
    const reviewSlo = getCatalogAdminControlPlaneReadModelSlo("source-observation-review-query");
    const promotionSlo = getCatalogAdminControlPlaneReadModelSlo("promotion-plan-preview");
    const jobSlo = getCatalogAdminControlPlaneReadModelSlo("import-job-progress-summary");

    expect(bySurface.get("provider-scope-selector")).toMatchObject({
      p95Ms: selectorSlo.latency.p95Ms,
      timeoutMs: selectorSlo.latency.timeoutMs,
      optionQueryCache: {
        freshTtlSeconds: 900,
        staleTtlSeconds: 86_400,
        defaultPageSize: 50,
        maxPageSize: 200,
      },
    });
    expect(bySurface.get("source-observation-review-table")).toMatchObject({
      p95Ms: reviewSlo.latency.p95Ms,
      timeoutMs: reviewSlo.latency.timeoutMs,
      pagination: { mode: "cursor", defaultLimit: 100, maxLimit: 500, representativeRows: 100_000 },
    });
    expect(bySurface.get("promotion-preview")).toMatchObject({
      p95Ms: promotionSlo.latency.p95Ms,
      timeoutMs: promotionSlo.latency.timeoutMs,
      pagination: { mode: "cursor", defaultLimit: 100, maxLimit: 500, representativeRows: 50_000 },
    });
    expect(bySurface.get("durable-job-progress")).toMatchObject({
      p95Ms: jobSlo.latency.p95Ms,
      timeoutMs: jobSlo.latency.timeoutMs,
      pagination: { mode: "sse", defaultLimit: 50, maxLimit: 200, representativeRows: 10_000 },
    });

    for (const budget of catalogProviderTransportFirstSliceBudgets.filter((entry) => entry.highVolume)) {
      expect(budget.verification.some((kind) => kind === "explain-plan" || kind === "load-sample")).toBe(true);
    }
  });

  it("defines retirement as complete deletion of code, patterns, documentation, and compatibility surfaces", () => {
    expect(catalogPrimaryWorkbenchRetirementPolicy).toMatchObject({
      term: "retire",
      requiredDisposition: "complete-removal",
    });
    expect(catalogProviderTransportRetiredSurfaceRule.policy.surfaces).toEqual(
      expect.arrayContaining(["runtime code", "product patterns", "documentation", "compatibility shims"]),
    );
    expect(catalogProviderTransportRetiredSurfaceRule.policy.forbiddenOutcomes).toEqual(
      expect.arrayContaining([
        "soft deprecation",
        "compatibility shim",
        "legacy support path",
        "migration of the current two-page surface",
        "raw JSON escape hatch",
      ]),
    );
    expect(catalogProviderTransportRetiredSurfaceRule.appliesTo).toEqual(
      expect.arrayContaining([
        "API, client, and read-model compatibility behavior",
        "tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, and operator instructions that teach retired behavior",
      ]),
    );
    expect(catalogProviderTransportRetiredSurfaceRule.ownerIssue).toBe("#1090");
  });

  it("promotes durable docs for #1062 evidence without preserving the current god page", () => {
    const doc = readFileSync(
      new URL("../../../docs/catalog-integration-provider-transport-budgets.md", import.meta.url),
      "utf8",
    );
    const proofDoc = readFileSync(
      new URL("../../../docs/catalog-integration-real-provider-proof.md", import.meta.url),
      "utf8",
    );

    expect(catalogProviderTransportBudgetDocPath).toBe(
      "bounded-contexts/catalog/docs/catalog-integration-provider-transport-budgets.md",
    );
    expect(doc).toContain("TCGdex");
    expect(doc).toContain("complete removal");
    expect(doc).toContain("not a migration");
    expect(doc).toContain("catalog-real-provider-proof/v1");
    expect(doc).toContain("pnpm run catalog:real-provider-proof");
    expect(doc).toContain("Provider Transport Reliability Vocabulary");
    expect(doc).toContain("First-Slice Performance Budgets");
    expect(proofDoc).toContain("Catalog Integration Real-Provider Proof");
    expect(proofDoc).toContain("pnpm run catalog:real-provider-proof");
    expect(proofDoc).toContain("Retirement Rule");
    expect(doc).not.toMatch(/operators can keep using the old|fallback to raw JSON/i);
    expect(`${doc}\n${proofDoc}`).not.toMatch(/#800|thin real-provider proof/i);
  });
});
