import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const runtimePath = "bounded-contexts/catalog/features/source-observations/api/runtime.ts";
const transportClientPaths = [
  "bounded-contexts/catalog/features/source-observations/api/tcgdex-client.ts",
  "bounded-contexts/catalog/features/source-observations/api/tcgplayer-automation-catalog-client.ts",
  "bounded-contexts/catalog/features/source-observations/api/tcgplayer-automation-client.ts",
];
const executableMappingImportPattern = new RegExp(
  String.raw`from ["']\.\/(tcgdex|tcgplayer|scrydex)-executable-mapping-contract["']`,
);

describe("Catalog provider mapping boundaries", () => {
  it("keeps Source Observation runtime independent from concrete provider profile constants", () => {
    const content = readFileSync(runtimePath, "utf8");

    expect(content).not.toContain("tcgdexPokemonTcgProviderProfile");
    expect(content).not.toContain("tcgplayerAutomationClientProviderProfile");
    expect(content).not.toContain("scrydexScryfallCardProviderProfile");
    expect(content).not.toMatch(executableMappingImportPattern);
  });

  it("keeps runtime import planning off concrete provider-key branches", () => {
    const content = readFileSync(runtimePath, "utf8");

    expect(content).not.toMatch(/providerProfile\.providerKey\s*(?:===|!==)\s*["'](?:tcgdex|tcgplayer)["']/);
    expect(content).not.toContain("processTcgplayerIntegrationImportJob");
    expect(content).not.toContain("previewTcgplayerIntegrationImportTargets");
    expect(content).not.toContain("previewTcgdexIntegrationImportTargets");
  });

  it("keeps transport clients from owning Source Observation mapping semantics", () => {
    for (const filePath of transportClientPaths) {
      const content = readFileSync(filePath, "utf8");

      expect(content, filePath).not.toMatch(/export function to[A-Z][A-Za-z0-9]+SourceObservation/);
      expect(content, filePath).not.toContain("requireCatalogProviderSourceObservation");
      expect(content, filePath).not.toContain("requireActiveCatalogProviderSourceObservationMappingContract");
      expect(content, filePath).not.toContain("tcgdexPokemonTcgProviderProfile");
      expect(content, filePath).not.toContain("tcgplayerAutomationClientProviderProfile");
      expect(content, filePath).not.toContain("scrydexScryfallCardProviderProfile");
    }
  });
});
