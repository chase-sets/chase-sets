import { describe, expect, it } from "vitest";
import { previewCatalogSyncProviderParticipation } from "./catalog-sync-scope-planner";
import { catalogProviderIntegrationProfileVersions } from "../provider-integration-profiles";
import {
  createTcgplayerProviderAdapter,
  TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "../provider-adapters/tcgplayer";
import { ProviderAdapterRegistry } from "../provider-adapters/registry";

describe("Pokemon sealed-product integration", () => {
  it("offers the TCGplayer sealed unit as an eligible Pokemon expansion participant", async () => {
    const profileVersion = catalogProviderIntegrationProfileVersions.find(
      (candidate) => candidate.providerKey === "tcgplayer" && candidate.profileKey === "pokemon-sealed-product-sku",
    );
    if (!profileVersion) {
      throw new Error("Missing the active TCGplayer Pokemon sealed-product profile.");
    }

    const scopeRecordId = "scope_pokemon_scarlet_violet";
    const preview = await previewCatalogSyncProviderParticipation({
      scope: {
        scopeVersion: "catalog-sync-scope-v2",
        productDomain: "pokemon",
        productForm: "sealed-product",
        languageCode: "en",
        reference: { kind: "expansion", scopeRecordId },
        providerParticipation: {
          selectedUnitKeys: [TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY],
        },
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
      providerAdapterRegistry: new ProviderAdapterRegistry([
        createTcgplayerProviderAdapter({ loadProfileVersions: async () => [profileVersion] }),
      ]),
    });

    expect(preview.status).toBe("ready");
    expect(preview.startAllowed).toBe(true);
    expect(preview.units).toEqual([
      expect.objectContaining({
        providerKey: "tcgplayer",
        unitKey: TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        profileKey: "pokemon-sealed-product-sku",
        role: "primary-source-observation",
        eligibility: "eligible",
        selected: true,
        childExecutionScope: expect.objectContaining({
          provider: "tcgplayer",
          ingestionUnitKey: TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
          productLineId: "3",
          setName: "Scarlet & Violet",
        }),
        blockers: [],
      }),
    ]);
  });
});
