import { describe, expect, it, vi } from "vitest";
import { previewCatalogSyncProviderParticipation } from "./catalog-sync-scope-planner";
import { catalogProviderIntegrationProfileVersions } from "../provider-integration-profiles";
import {
  createTcgplayerProviderAdapter,
  TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "../provider-adapters/tcgplayer";
import { ProviderAdapterRegistry } from "../provider-adapters/registry";

describe("Pokemon sealed-product integration", () => {
  it.each([
    {
      name: "explicitly selected",
      providerParticipation: {
        selectedUnitKeys: [TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY],
      },
    },
    { name: "default participation", providerParticipation: null },
  ])("never enrols the server-unplannable TCGplayer sealed unit under $name", async ({ providerParticipation }) => {
    const profileVersion = catalogProviderIntegrationProfileVersions.find(
      (candidate) => candidate.providerKey === "tcgplayer" && candidate.profileKey === "pokemon-sealed-product-sku",
    );
    if (!profileVersion) {
      throw new Error("Missing the active TCGplayer Pokemon sealed-product profile.");
    }
    expect(profileVersion).toMatchObject({
      active: true,
      profile: { capabilities: expect.arrayContaining(["source-observation-import", "catalog-item-promotion"]) },
    });
    const adapter = createTcgplayerProviderAdapter({ loadProfileVersions: async () => [profileVersion] });
    const calls = (
      ["planImport", "listOptions", "fetchPayloads", "getCredentialReadiness", "getTransportDiagnostics"] as const
    ).map((method) => [method, vi.spyOn(adapter, method)] as const);

    const scopeRecordId = "scope_pokemon_scarlet_violet";
    const preview = await previewCatalogSyncProviderParticipation({
      scope: {
        scopeVersion: "catalog-sync-scope-v2",
        productDomain: "pokemon",
        productForm: "sealed-product",
        languageCode: "en",
        reference: { kind: "expansion", scopeRecordId },
        providerParticipation,
      },
      acceptedScopeMappings: [
        {
          scopeRecordId,
          providerKey: "tcgplayer",
          unitKey: TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
          productLineId: "3",
          seriesId: "sv",
          setId: "10001",
          setName: "Scarlet & Violet",
          mappingId: "mapping_tcgplayer_sealed",
          mappingVersion: "2026-07-01T00:00:00.000Z",
          reviewStatus: "accepted",
        },
      ],
      providerProfileVersions: [profileVersion],
      providerAdapterRegistry: new ProviderAdapterRegistry([adapter]),
      includeOperationalGates: true,
    });

    expect(preview.units).toEqual([]);
    expect(preview.blockers).toEqual([]);
    for (const [method, spy] of calls) {
      expect(spy, method).not.toHaveBeenCalled();
    }
  });
});
