import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { describe, it } = process.env.VITEST ? await import("vitest") : await import("node:test");
if (!process.env.VITEST) await import("tsx/esm");

const {
  CATALOG_PRODUCTION_SIGNOFF_DOCUMENT,
  CATALOG_PROVIDER_SYNC_RUNBOOK,
  catalogProductDomainSignoffTitles,
  catalogProviderProfileVersionRequiresSignoffCoverage,
  evaluateCatalogProductionSignoffCoverage,
  listCatalogProductionSignoffRequiredDomains,
  listCatalogProductionSignoffRequiredUnits,
} = await import("./catalog-integration-production-signoff-coverage.ts");
const { catalogProviderIntegrationProfileVersions, catalogProviderProfileVersionProductDomain } =
  await import("../../bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.ts");

const repoRoot = resolve(import.meta.dirname, "../..");
const signoffDocument = readFileSync(resolve(repoRoot, CATALOG_PRODUCTION_SIGNOFF_DOCUMENT), "utf8");
const runbookDocument = readFileSync(resolve(repoRoot, CATALOG_PROVIDER_SYNC_RUNBOOK), "utf8");

describe("Catalog production signoff coverage", () => {
  it("covers every active production-capable provider unit with signoff and runbook sections", () => {
    assert.deepEqual(evaluateCatalogProductionSignoffCoverage({ signoffDocument, runbookDocument }), []);
  });

  it("requires every active production product domain from the registry", () => {
    const domains = listCatalogProductionSignoffRequiredDomains();
    for (const domain of ["pokemon", "yugioh", "mtg", "one-piece", "lorcana"]) {
      assert.ok(domains.includes(domain));
    }
  });

  it("makes Pokemon and Yu-Gi-Oh provider roles, controls, and UAT explicit", () => {
    for (const marker of [
      "## Pokemon",
      "TCGdex",
      "## Yu-Gi-Oh!",
      "YGOPRODeck",
      "YGOJSON",
      "#2126",
      "#2111",
      "CATALOG_INTEGRATION_YUGIOH_PRODUCTION_SIGNOFF_REFERENCE",
      "CATALOG_INTEGRATION_POKEMON_PRODUCTION_SIGNOFF_REFERENCE",
    ])
      assert.ok(signoffDocument.includes(marker), marker);
    for (const marker of ["## Pokemon", "## Yu-Gi-Oh!", "ygoprodeck", "ygojson", "tcgdex"]) {
      assert.ok(runbookDocument.includes(marker), marker);
    }
  });

  it("excludes validation-only, comparison-only, test, gated, deprecated, and retired units", () => {
    const requiredKeys = new Set(
      listCatalogProductionSignoffRequiredUnits().map((version) => `${version.providerKey}:${version.profileKey}`),
    );
    const gatedTestUnit = catalogProviderIntegrationProfileVersions.find(
      (version) => version.lifecycle === "test" || !version.active,
    );
    assert.ok(gatedTestUnit);
    assert.equal(catalogProviderProfileVersionRequiresSignoffCoverage(gatedTestUnit), false);
    assert.equal(requiredKeys.has(`${gatedTestUnit.providerKey}:${gatedTestUnit.profileKey}`), false);
  });

  it("keeps shared TCGplayer and Scrydex controls unit-scoped across product domains", () => {
    const sharedProviderDomains = new Map();
    for (const version of listCatalogProductionSignoffRequiredUnits()) {
      const providerKey = version.providerKey.trim().toLowerCase();
      if (providerKey !== "tcgplayer" && providerKey !== "scrydex") continue;
      const domains = sharedProviderDomains.get(providerKey) ?? new Set();
      domains.add(catalogProviderProfileVersionProductDomain(version));
      sharedProviderDomains.set(providerKey, domains);
    }
    assert.ok((sharedProviderDomains.get("tcgplayer")?.size ?? 0) > 1);
    assert.ok((sharedProviderDomains.get("scrydex")?.size ?? 0) > 1);
  });

  it("maps every required product domain to a signoff title", () => {
    for (const domain of listCatalogProductionSignoffRequiredDomains())
      assert.ok(catalogProductDomainSignoffTitles[domain]);
  });

  it("flags an active production-capable domain that loses signoff coverage", () => {
    const strippedSignoff = signoffDocument
      .replace("## Pokemon\n", "## Removed Pokemon\n")
      .replace("[Pokemon](#pokemon)", "[Removed](#removed)");
    const diagnostics = evaluateCatalogProductionSignoffCoverage({ signoffDocument: strippedSignoff, runbookDocument });
    assert.ok(diagnostics.some((diagnostic) => diagnostic.productDomain === "pokemon"));
    assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "missing-signoff-section"));
  });
});
