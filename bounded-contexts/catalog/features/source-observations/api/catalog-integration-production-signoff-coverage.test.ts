import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CATALOG_PRODUCTION_SIGNOFF_DOCUMENT,
  CATALOG_PROVIDER_SYNC_RUNBOOK,
  catalogProductDomainSignoffTitles,
  catalogProviderProfileVersionRequiresSignoffCoverage,
  evaluateCatalogProductionSignoffCoverage,
  listCatalogProductionSignoffRequiredDomains,
  listCatalogProductionSignoffRequiredUnits,
} from "./catalog-integration-production-signoff-coverage";
import {
  catalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionProductDomain,
} from "./provider-integration-profiles";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../..");
const signoffDocument = readFileSync(resolve(repoRoot, CATALOG_PRODUCTION_SIGNOFF_DOCUMENT), "utf8");
const runbookDocument = readFileSync(resolve(repoRoot, CATALOG_PROVIDER_SYNC_RUNBOOK), "utf8");

describe("Catalog production signoff coverage", () => {
  it("covers every active production-capable provider unit with signoff and runbook sections", () => {
    const diagnostics = evaluateCatalogProductionSignoffCoverage({ signoffDocument, runbookDocument });
    expect(diagnostics).toEqual([]);
  });

  it("requires Pokemon and Yu-Gi-Oh production signoff coverage from the active registry", () => {
    const domains = listCatalogProductionSignoffRequiredDomains();
    expect(domains).toContain("pokemon");
    expect(domains).toContain("yugioh");
    expect(domains).toContain("mtg");
    expect(domains).toContain("one-piece");
    expect(domains).toContain("lorcana");
  });

  it("makes Pokemon and Yu-Gi-Oh provider roles, asset rules, rollout controls, and UAT explicit", () => {
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
    ]) {
      expect(signoffDocument).toContain(marker);
    }
    for (const marker of ["## Pokemon", "## Yu-Gi-Oh!", "ygoprodeck", "ygojson", "tcgdex"]) {
      expect(runbookDocument).toContain(marker);
    }
  });

  it("excludes validation-only, comparison-only, test, gated, deprecated, and retired units from required coverage", () => {
    const requiredKeys = new Set(
      listCatalogProductionSignoffRequiredUnits().map((version) => `${version.providerKey}:${version.profileKey}`),
    );
    const gatedTestUnit = catalogProviderIntegrationProfileVersions.find(
      (version) => version.lifecycle === "test" || !version.active,
    );
    expect(gatedTestUnit).toBeDefined();
    if (gatedTestUnit) {
      expect(catalogProviderProfileVersionRequiresSignoffCoverage(gatedTestUnit)).toBe(false);
      expect(requiredKeys.has(`${gatedTestUnit.providerKey}:${gatedTestUnit.profileKey}`)).toBe(false);
    }
  });

  it("keeps shared TCGplayer and Scrydex controls unit-scoped across product domains", () => {
    const sharedProviderDomains = new Map<string, Set<string>>();
    for (const version of listCatalogProductionSignoffRequiredUnits()) {
      const providerKey = version.providerKey.trim().toLowerCase();
      if (providerKey !== "tcgplayer" && providerKey !== "scrydex") {
        continue;
      }
      const domains = sharedProviderDomains.get(providerKey) ?? new Set<string>();
      domains.add(catalogProviderProfileVersionProductDomain(version));
      sharedProviderDomains.set(providerKey, domains);
    }
    expect(sharedProviderDomains.get("tcgplayer")?.size ?? 0).toBeGreaterThan(1);
    expect(sharedProviderDomains.get("scrydex")?.size ?? 0).toBeGreaterThan(1);
  });

  it("maps every required product domain to a signoff title", () => {
    for (const domain of listCatalogProductionSignoffRequiredDomains()) {
      expect(catalogProductDomainSignoffTitles[domain]).toBeTruthy();
    }
  });

  it("flags an active production-capable domain that has no signoff section", () => {
    const strippedSignoff = signoffDocument
      .replace("## Pokemon\n", "## Removed Pokemon\n")
      .replace("[Pokemon](#pokemon)", "[Removed](#removed)");
    const diagnostics = evaluateCatalogProductionSignoffCoverage({
      signoffDocument: strippedSignoff,
      runbookDocument,
    });
    expect(diagnostics.some((diagnostic) => diagnostic.productDomain === "pokemon")).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.code === "missing-signoff-section")).toBe(true);
  });
});
