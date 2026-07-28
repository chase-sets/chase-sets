import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scenarioFiles = [
  {
    name: "automation-app response fixtures",
    file: "bounded-contexts/catalog/features/source-observations/api/providers/tcgplayer-automation-response-fixtures.test-data.ts",
    evidence: ["productLines", "catalogSetNames", "productSearch", "productDetail"],
  },
  {
    name: "Catalog response contract and pricing boundary",
    file: "bounded-contexts/catalog/features/source-observations/api/providers/tcgplayer-automation-response-contract.test.ts",
    evidence: [
      "keeps sanitized fixtures for every Catalog-relevant automation endpoint",
      "keeps price, listing, seller, and quantity fields out of Catalog observation hashes",
      "productConditionId gap",
    ],
  },
  {
    name: "Catalog automation client normalization",
    file: "bounded-contexts/catalog/features/source-observations/api/providers/tcgplayer-automation-catalog-client.test.ts",
    evidence: [
      "normalizes product detail into one provider-product Source Observation",
      "maps only SKU references whose selected options validate against the Product schema",
      "carries sealed-product merge evidence",
      "excludes price and listing fields from the Catalog observation hash material",
    ],
  },
  {
    name: "Catalog import",
    file: "bounded-contexts/catalog/features/source-observations/api/runtime-provider-integration-jobs.test.ts",
    evidence: [
      "imports TCGplayer set scopes as provider-product source observations",
      "imports TCGplayer Magic single-card set scopes through the selected production profile unit",
      "imports TCGplayer Magic sealed-product set scopes through the selected production profile unit",
    ],
  },
  {
    name: "Catalog TCGplayer Magic profile contract",
    file: "bounded-contexts/catalog/features/source-observations/api/providers/provider-profile-fixture-cases.ts",
    evidence: [
      "mtg-single-card-product-sku",
      "tcgplayer:mtg:single-card:source-observation-import",
      "Fury Sliver",
      "mtg-sealed-product-sku",
      "tcgplayer:mtg:sealed-product:source-observation-import",
      "Time Spiral Booster Pack",
    ],
  },
  {
    name: "Catalog TCGplayer Magic adapter scoping",
    file: "bounded-contexts/catalog/features/source-observations/api/provider-adapters/provider-adapter.test.ts",
    evidence: [
      "serves TCGplayer Magic single-card transport through the active profile unit",
      "serves TCGplayer Magic sealed-product transport through the active profile unit",
      "TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY",
      "TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY",
    ],
  },
  {
    name: "Catalog duplicate prevention",
    file: "bounded-contexts/catalog/features/source-observations/api/runtime-promotion.test.ts",
    evidence: [
      "refreshing an existing Catalog Item linked to the same TCGplayer Product ID",
      "future provider observations through the same TCGplayer Product ID reference",
      "blocks promotion when external Catalog Item references match multiple Catalog Items",
      "blocks promotion when deterministic card evidence matches multiple Catalog Items",
    ],
  },
  {
    name: "Catalog admin review coverage",
    file: "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-page.test.tsx",
    evidence: ["renders Source Observation evidence rows", "Provider payload withheld", "Preview promotion"],
  },
  {
    name: "Inventory SKU and Product ID resolution",
    file: "bounded-contexts/inventory/features/import-batches/api/runtime.test.ts",
    evidence: [
      "resolves mapped TCGplayer rows and rejects unmapped external references",
      "tries ordered external reference candidates before sending rows to review",
      "resolves TCGplayer Product ID-only rows only when selected options are inferable",
    ],
  },
  {
    name: "Inventory replay projection",
    file: "bounded-contexts/inventory/features/inventory-items/integrations/catalog/projection.test.ts",
    evidence: ["external-product-reference-linked", "external-catalog-item-reference-linked"],
  },
  {
    name: "Pricing signal boundary",
    file: "bounded-contexts/pricing/features/price-signals/api/runtime.test.ts",
    evidence: [
      "resolves SKU references to Catalog Product keys before recording Pricing evidence",
      "keeps unresolved SKU signals out of price facts",
      "missing-price",
      "stale",
      "upserts replayed observations by deterministic signal id",
    ],
  },
  {
    name: "Pricing Catalog projection",
    file: "bounded-contexts/pricing/features/price-signals/integrations/catalog/projection.test.ts",
    evidence: ["external-product-reference-linked", "external-product-reference-unlinked"],
  },
];

describe("TCGplayer integration hardening coverage", () => {
  for (const scenario of scenarioFiles) {
    it(`keeps fixture-backed coverage for ${scenario.name}`, () => {
      const content = readFileSync(scenario.file, "utf8");

      for (const evidence of scenario.evidence) {
        expect(content, `${scenario.file} should include ${evidence}`).toContain(evidence);
      }
    });
  }

  it("keeps TCGplayer tests fixture-backed instead of live-provider backed", () => {
    for (const scenario of scenarioFiles) {
      const content = readFileSync(scenario.file, "utf8");

      expect(content, `${scenario.file} must not call live TCGplayer through fetch`).not.toMatch(
        /fetch\(\s*["'`]https:\/\/[^"'`]*tcgplayer\.com/i,
      );
    }
  });
});
