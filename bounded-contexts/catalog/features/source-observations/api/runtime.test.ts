import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonValue } from "@chase-sets/primitives/json";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import type { ReferenceRecordCommand, ReferenceTypeCommand } from "../../reference-data/domain/domain";
import type { SourceObservationNormalized, SourceObservationPokemonCardNormalized } from "../domain/domain";
import { createSourceObservationRuntime, ensurePokemonReferenceHierarchy } from "./runtime";
import {
  catalogProviderIntegrationProfileVersions,
  tcgdexPokemonTcgProviderProfile,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import type {
  TcgplayerAutomationCatalogClient,
  TcgplayerAutomationProductDetail,
} from "./tcgplayer-automation-catalog-client";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

type ReferenceTypeRow = {
  reference_type_id: string;
  key: string;
};

type ReferenceRecordRow = {
  reference_record_id: string;
  type_key: string;
  key: string;
  attributes: Readonly<Record<string, JsonValue>>;
};

function createActiveTcgplayerProfileVersions(): {
  listProfileVersions: (
    providerKey?: string | null,
  ) => Promise<readonly CatalogProviderIntegrationProfileVersionRecord[]>;
  getActiveProfileVersion: (providerKey: string) => Promise<CatalogProviderIntegrationProfileVersionRecord | null>;
} {
  const versions = catalogProviderIntegrationProfileVersions.map((version) =>
    version.providerKey === "tcgplayer"
      ? {
          ...version,
          lifecycle: "active" as const,
          active: true,
          profile: {
            ...version.profile,
            status: "active" as const,
          },
        }
      : version,
  );
  return {
    listProfileVersions: async (providerKey?: string | null) => {
      const normalizedProviderKey = providerKey?.trim().toLowerCase() ?? "";
      return normalizedProviderKey
        ? versions.filter((version) => version.providerKey === normalizedProviderKey)
        : versions;
    },
    getActiveProfileVersion: async (providerKey: string) => {
      const normalizedProviderKey = providerKey.trim().toLowerCase();
      return (
        versions.find(
          (version) =>
            version.providerKey === normalizedProviderKey && version.active && version.lifecycle === "active",
        ) ?? null
      );
    },
  };
}

function createMutableProfileVersionReader(initialVersions: readonly CatalogProviderIntegrationProfileVersionRecord[]) {
  let versions = [...initialVersions];
  return {
    listProfileVersions: async (providerKey?: string | null) => {
      const normalizedProviderKey = providerKey?.trim().toLowerCase() ?? "";
      return normalizedProviderKey
        ? versions.filter((version) => version.providerKey === normalizedProviderKey)
        : versions;
    },
    getActiveProfileVersion: async (providerKey: string) => {
      const normalizedProviderKey = providerKey.trim().toLowerCase();
      return (
        versions.find(
          (version) =>
            version.providerKey === normalizedProviderKey && version.active && version.lifecycle === "active",
        ) ?? null
      );
    },
    activate: (providerKey: string, profileVersion: string) => {
      const normalizedProviderKey = providerKey.trim().toLowerCase();
      versions = versions.map((version) => {
        if (version.providerKey !== normalizedProviderKey) {
          return version;
        }
        const active = version.profileVersion === profileVersion;
        return {
          ...version,
          lifecycle: active ? ("active" as const) : ("deprecated" as const),
          active,
          executableMappingContract: version.executableMappingContract
            ? {
                ...version.executableMappingContract,
                lifecycle: active ? ("active" as const) : ("deprecated" as const),
              }
            : undefined,
        };
      });
    },
  };
}

function tcgdexProfileVersion(input: {
  profileVersion: string;
  lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"];
  active: boolean;
  displayName: string;
}): CatalogProviderIntegrationProfileVersionRecord {
  const base = currentTcgdexProfileVersion();
  return {
    ...base,
    profileVersion: input.profileVersion,
    lifecycle: input.lifecycle,
    active: input.active,
    profile: {
      ...base.profile,
      displayName: input.displayName,
    },
    executableMappingContract: base.executableMappingContract
      ? {
          ...base.executableMappingContract,
          profileVersion: input.profileVersion,
          lifecycle: input.lifecycle,
        }
      : undefined,
  };
}

function providerProfileVersionForProvider(
  providerKey: string,
  profileKey: string,
  profileVersion: string,
): CatalogProviderIntegrationProfileVersionRecord {
  const base = currentTcgdexProfileVersion();

  return {
    ...base,
    providerKey,
    profileKey,
    profileVersion,
    lifecycle: "active",
    active: true,
    profile: {
      ...base.profile,
      providerKey,
      displayName: `${providerKey} Pokemon profile`,
    },
    executableMappingContract: base.executableMappingContract
      ? {
          ...base.executableMappingContract,
          providerKey,
          profileKey,
          profileVersion,
          lifecycle: "active",
        }
      : undefined,
  };
}

function tcgdexProfileSnapshot(profileVersion: string): Record<string, unknown> {
  return {
    providerKey: "tcgdex",
    profileKey: "pokemon-tcg",
    profileVersion,
    lifecycle: "active",
    connectorKind: "tcgdex-json",
    connectorSourceVersion: null,
    sourceMappingFingerprint: `fingerprint:${profileVersion}`,
  };
}

function currentTcgdexProfileVersion(): CatalogProviderIntegrationProfileVersionRecord {
  const version = catalogProviderIntegrationProfileVersions.find((candidate) => candidate.providerKey === "tcgdex");
  if (!version) {
    throw new Error("Expected seeded TCGdex profile version.");
  }
  return version;
}

describe("source observation runtime", () => {
  it("preloads and reuses TCGdex reference records by provider attributes", async () => {
    const harness = createReferencePreloadHarness();

    const firstExpansionReferenceId = await ensurePokemonReferenceHierarchy({
      deps: harness.deps,
      referenceData: harness.referenceData,
      profile: tcgdexPokemonTcgProviderProfile,
      normalized: pokemonObservation({
        expansionName: "Ascended Heroes",
        seriesName: "Mega Evolution",
      }),
      context,
    });
    const translatedExpansionReferenceId = await ensurePokemonReferenceHierarchy({
      deps: harness.deps,
      referenceData: harness.referenceData,
      profile: tcgdexPokemonTcgProviderProfile,
      normalized: pokemonObservation({
        expansionName: "Heros Ascendidos",
        seriesName: "Mega Evolucion",
      }),
      context,
    });

    expect(translatedExpansionReferenceId).toBe(firstExpansionReferenceId);
    expect(harness.referenceRecordsByProviderAttribute("series", "tcgdex-series-id", "me")).toHaveLength(1);
    expect(harness.referenceRecordsByProviderAttribute("expansion", "tcgdex-set-id", "me02.5")).toHaveLength(1);
    expect(
      harness.referenceRecordCreateCommands.filter(
        (command) => command.typeKey === "series" && command.attributes?.["tcgdex-series-id"] === "me",
      ),
    ).toHaveLength(1);
    expect(
      harness.referenceRecordCreateCommands.filter(
        (command) => command.typeKey === "expansion" && command.attributes?.["tcgdex-set-id"] === "me02.5",
      ),
    ).toHaveLength(1);
    expect(harness.projectorRuns()).toBe(0);
  });

  it("promotes changed observations by refreshing the linked Catalog Item", async () => {
    const harness = createChangedObservationRefreshHarness();
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result).toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_existing",
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
    ]);
    expect(harness.itemCommands).not.toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({ type: "CreateCatalogItem" }),
      }),
    );
    expect(harness.itemCommands[0]?.command).toMatchObject({
      type: "ReviseCatalogItemMetadata",
      title: {
        values: {
          en: "Furret",
        },
      },
      subtitle: {
        values: {
          en: "",
        },
      },
    });
    expect(harness.itemCommands).toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "LinkExternalProductReference",
          providerKey: "tcgdex",
          externalKey: "en:me02.5-136:reverse-holo",
        }),
      }),
    );
    expect(harness.appendedSourceEvents).toContainEqual(
      expect.objectContaining({
        eventType: "catalog.source-observation.promoted",
        payload: expect.objectContaining({
          catalogItemId: "cat_existing",
        }),
      }),
    );
    expect(harness.projectorRuns()).toBe(0);
  });

  it("promotes observed observations by refreshing an existing Catalog Item linked to the same source", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "observed",
      promotedCatalogItemId: null,
      reusableCatalogItemId: "cat_existing_source",
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result).toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_existing_source",
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
    ]);
    expect(harness.itemCommands).not.toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({ type: "CreateCatalogItem" }),
      }),
    );
    expect(harness.appendedSourceEvents).toContainEqual(
      expect.objectContaining({
        eventType: "catalog.source-observation.promoted",
        payload: expect.objectContaining({
          catalogItemId: "cat_existing_source",
        }),
      }),
    );
  });

  it("promotes observed observations by refreshing an existing Catalog Item linked to the same TCGplayer Product ID", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "observed",
      promotedCatalogItemId: null,
      reusableExternalCatalogItemIds: ["cat_existing_tcgplayer_product"],
      normalized: {
        ...pokemonObservation({
          expansionName: "Prismatic Evolutions",
          seriesName: "Scarlet & Violet",
        }),
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:610001" }],
      },
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result).toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_existing_tcgplayer_product",
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
      "LinkExternalCatalogItemReference",
    ]);
    expect(harness.itemCommands).not.toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({ type: "CreateCatalogItem" }),
      }),
    );
    expect(harness.itemCommands).toContainEqual(
      expect.objectContaining({
        streamId: "catalog.item-cat_existing_tcgplayer_product",
        command: expect.objectContaining({
          type: "LinkExternalCatalogItemReference",
          providerKey: "tcgplayer",
          externalKey: "product:610001",
        }),
      }),
    );
  });

  it("blocks future provider observations through the same TCGplayer Product ID reference instead of using another provider's compatible profile", async () => {
    const harness = createChangedObservationRefreshHarness({
      providerKey: "scryfall",
      status: "observed",
      promotedCatalogItemId: null,
      reusableExternalCatalogItemIds: ["cat_existing_scryfall_tcgplayer"],
      normalized: {
        ...pokemonObservation({
          expansionName: "Prismatic Evolutions",
          seriesName: "Scarlet & Violet",
        }),
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:610001" }],
      },
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await expect(
      services.promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).rejects.toThrow("Provider 'scryfall' does not support Catalog Item promotion.");
    expect(harness.itemCommands).toEqual([]);
  });

  it("blocks promotion when external Catalog Item references match multiple Catalog Items", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "observed",
      promotedCatalogItemId: null,
      reusableExternalCatalogItemIds: ["cat_existing_a", "cat_existing_b"],
      normalized: {
        ...pokemonObservation({
          expansionName: "Prismatic Evolutions",
          seriesName: "Scarlet & Violet",
        }),
        externalCatalogItemReferences: [
          { providerKey: "tcgplayer", externalKey: "product:610001" },
          { providerKey: "cardmarket", externalKey: "product:700001" },
        ],
      },
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await expect(
      services.promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).rejects.toThrow("Multiple Catalog Items match this Source Observation's external catalog item references.");
    expect(harness.itemCommands).toEqual([]);
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("promotes observed observations by refreshing one deterministic Catalog Item match", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "observed",
      promotedCatalogItemId: null,
      deterministicCatalogItemIds: ["cat_existing_deterministic"],
      normalized: pokemonObservation({
        expansionName: "Prismatic Evolutions",
        seriesName: "Scarlet & Violet",
        cardNumber: "131",
        name: "Eevee ex",
        cardVariantLabel: "Standard Set Foil",
        cardVariantKey: "holofoil",
      }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result).toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_existing_deterministic",
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
    ]);
    expect(harness.itemCommands).not.toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({ type: "CreateCatalogItem" }),
      }),
    );
  });

  it("blocks promotion when deterministic card evidence matches multiple Catalog Items", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "observed",
      promotedCatalogItemId: null,
      deterministicCatalogItemIds: ["cat_existing_a", "cat_existing_b"],
      normalized: pokemonObservation({
        expansionName: "Prismatic Evolutions",
        seriesName: "Scarlet & Violet",
        cardNumber: "131",
        name: "Eevee ex",
        cardVariantLabel: "Standard Set Foil",
        cardVariantKey: "holofoil",
      }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await expect(
      services.promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).rejects.toThrow("Multiple Catalog Items match this Source Observation's deterministic card evidence.");
    expect(harness.itemCommands).toEqual([]);
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("fails image-backed promotion before writing partial Catalog Item commands when asset storage is unavailable", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "observed",
      promotedCatalogItemId: null,
      normalized: {
        ...pokemonObservation({
          expansionName: "Mega Evolution",
          seriesName: "Mega Evolution",
        }),
        imageBaseUrl: "https://assets.tcgdex.example/me01-001",
      },
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);
    const initialItemCommandCount = harness.itemCommands.length;

    await expect(
      services.promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).rejects.toThrow("Catalog asset storage is required to promote source observation image assets.");
    expect(harness.itemCommands).toEqual([]);
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("reuses a partially promoted TCGdex draft Catalog Item when retrying an observed Source Observation", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "observed",
      promotedCatalogItemId: null,
      partialCatalogItemId: "cat_partial",
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result).toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_partial",
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
    ]);
    expect(harness.itemCommands).not.toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({ type: "CreateCatalogItem" }),
      }),
    );
    expect(harness.appendedSourceEvents).toContainEqual(
      expect.objectContaining({
        eventType: "catalog.source-observation.promoted",
        payload: expect.objectContaining({
          catalogItemId: "cat_partial",
        }),
      }),
    );
  });

  it("repromotes promoted observations by resyncing the linked Catalog Item", async () => {
    const harness = createChangedObservationRefreshHarness({ status: "promoted" });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result).toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_existing",
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
    ]);
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("treats a single promotion retry as successful when the observation was already promoted concurrently", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "changed",
      promotedCatalogItemId: "cat_existing",
      promotionCommandAlreadyApplied: { catalogItemId: "cat_existing" },
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);
    const initialItemCommandCount = harness.itemCommands.length;

    await expect(
      services.promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).resolves.toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_existing",
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toContain("ReviseCatalogItemMetadata");
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("treats a single promotion retry as successful when the observation is already promoted before processing", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "promoted",
      promotedCatalogItemId: "cat_existing",
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await expect(
      services.promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).resolves.toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_existing",
    });
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("treats a promotion retry as successful when the observation was already promoted concurrently", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "changed",
      promotedCatalogItemId: "cat_existing",
      promotionCommandAlreadyApplied: { catalogItemId: "cat_existing" },
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservations({
      observationIds: ["obs_changed"],
      context,
    });

    expect(result).toMatchObject({
      requested: 1,
      promoted: 1,
      skipped: 0,
      failed: 0,
      outcomes: [
        {
          observationId: "obs_changed",
          status: "promoted",
          catalogItemId: "cat_existing",
          reason: null,
        },
      ],
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toContain("ReviseCatalogItemMetadata");
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("treats a bulk promotion retry as successful when the observation is already promoted before processing", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "promoted",
      promotedCatalogItemId: "cat_existing",
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);
    const result = await services.promoteObservations({
      observationIds: ["obs_changed"],
      context,
    });

    expect(result).toMatchObject({
      requested: 1,
      promoted: 1,
      skipped: 0,
      failed: 0,
      outcomes: [
        {
          observationId: "obs_changed",
          status: "promoted",
          catalogItemId: "cat_existing",
          reason: null,
        },
      ],
    });
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("reapplies promoted observations by refreshing the linked Catalog Item without creating a replacement", async () => {
    const harness = createChangedObservationRefreshHarness({ status: "promoted" });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "original-source-profile",
    });

    expect(result).toMatchObject({
      requested: 1,
      reapplied: 1,
      skipped: 0,
      failed: 0,
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
    ]);
    expect(harness.itemCommands).not.toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({ type: "CreateCatalogItem" }),
      }),
    );
    expect(harness.appendedSourceEvents).toEqual([
      expect.objectContaining({
        eventType: "catalog.source-observation.promotion-plan-recorded",
        payload: expect.objectContaining({
          catalogItemId: "cat_existing",
          promotionProfileKey: "pokemon-tcg",
          promotionProfileVersion: "2026.06.03",
          promotionPlanFingerprint: expect.any(String),
        }),
      }),
    ]);
  });

  it("fails original-profile reapply for promoted observations with retired legacy profile metadata", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "promoted",
      sourceProfileVersion: "legacy",
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "original-source-profile",
    });

    expect(result).toMatchObject({
      requested: 1,
      reapplied: 0,
      skipped: 0,
      failed: 1,
      outcomes: [
        {
          observationId: "obs_changed",
          status: "failed",
          reason:
            "Source Observation obs_changed is missing original source profile version and cannot be reapplied with original-source-profile mode.",
        },
      ],
    });
    expect(harness.itemCommands).toEqual([]);
  });

  it("links TCGplayer product ids as Catalog Item references during promotion", async () => {
    const harness = createChangedObservationRefreshHarness({
      normalized: {
        ...pokemonObservation({
          expansionName: "Scarlet & Violet",
          seriesName: "Scarlet & Violet",
          name: "Sprigatito",
        }),
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:490001" }],
      },
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(harness.itemCommands).toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "LinkExternalCatalogItemReference",
          providerKey: "tcgplayer",
          externalKey: "product:490001",
        }),
      }),
    );
  });

  it("fails reapply for promoted observations missing their linked Catalog Item", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "promoted",
      promotedCatalogItemId: null,
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "original-source-profile",
    });

    expect(result).toMatchObject({
      requested: 1,
      reapplied: 0,
      failed: 1,
      outcomes: [
        {
          observationId: "obs_changed",
          status: "failed",
          reason: "Promoted source observation is missing its Catalog Item.",
        },
      ],
    });
    expect(harness.itemCommands).toEqual([]);
  });

  it("keeps promoted metadata as fallback when templates own display card numbering", async () => {
    const harness = createChangedObservationRefreshHarness({
      expansionAttributes: {
        "printed-card-count": 102,
      },
      normalized: pokemonObservation({
        cardNumber: "43",
        expansionCardCount: 110,
        expansionName: "Base Set",
        name: "Abra",
        rarity: "Common",
        seriesName: "Base",
      }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(harness.itemCommands[0]?.command).toMatchObject({
      type: "ReviseCatalogItemMetadata",
      title: {
        values: {
          en: "Abra",
        },
      },
      subtitle: {
        values: {
          en: "",
        },
      },
    });
  });

  it("does not special-case promo metadata when templates own display subtitles", async () => {
    const harness = createChangedObservationRefreshHarness({
      expansionAttributes: {
        "printed-card-count": null,
      },
      normalized: pokemonObservation({
        cardNumber: "SM01",
        expansionCardCount: 200,
        expansionName: "Sun & Moon Promos",
        name: "Rowlet",
        rarity: "Promo",
        seriesName: "Sun & Moon",
        cardVariantKey: "standard",
        cardVariantLabel: "Standard Set",
        cardVariantSourceKey: "normal",
        parallelSet: false,
      }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(harness.itemCommands[0]?.command).toMatchObject({
      type: "ReviseCatalogItemMetadata",
      title: {
        values: {
          en: "Rowlet",
        },
      },
      subtitle: {
        values: {
          en: "",
        },
      },
    });
  });

  it("uses the source name as fallback metadata without hard-coded card-number formatting", async () => {
    const harness = createChangedObservationRefreshHarness({
      normalized: pokemonObservation({
        cardNumber: "XY01",
        expansionCardCount: null,
        expansionName: "XY Promos",
        name: "Pikachu",
        rarity: "Promo",
        seriesName: "XY",
        cardVariantKey: "standard",
        cardVariantLabel: "Standard Set",
        cardVariantSourceKey: "normal",
        parallelSet: false,
      }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(harness.itemCommands[0]?.command).toMatchObject({
      type: "ReviseCatalogItemMetadata",
      title: {
        values: {
          en: "Pikachu",
        },
      },
      subtitle: {
        values: {
          en: "",
        },
      },
    });
  });

  it("processes persisted bulk review jobs through durable work-unit turns", async () => {
    const harness = createBulkReviewJobHarness(30);
    const recordBulkReviewWorkUnit = vi.fn();
    const services = createSourceObservationRuntime(
      {
        ...harness.deps,
        sourceObservationTelemetry: {
          recordBulkReviewWorkUnit,
        },
      } as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    await expect(
      services.processNextBulkReviewJob({
        claimOwnerId: "worker-1",
        claimTtlMs: 120_000,
      }),
    ).resolves.toBe(1);

    expect(harness.job.status).toBe("running");
    expect(harness.job.progress).toMatchObject({
      phase: "processing",
      completed: 1,
      total: 30,
    });
    expect(harness.job.result?.outcomes).toHaveLength(1);
    expect(harness.appendedEvents).toHaveLength(1);

    await expect(
      services.processNextBulkReviewJob({
        claimOwnerId: "worker-2",
        claimTtlMs: 120_000,
      }),
    ).resolves.toBe(1);

    expect(harness.job.status).toBe("running");
    expect(harness.job.progress).toMatchObject({
      phase: "processing",
      completed: 2,
      total: 30,
    });
    expect(harness.job.result).toMatchObject({
      requested: 30,
      rejected: 2,
      skipped: 0,
      failed: 0,
    });
    expect(harness.job.result?.outcomes).toHaveLength(2);
    expect(harness.appendedEvents).toHaveLength(2);
    expect(recordBulkReviewWorkUnit).toHaveBeenCalledTimes(2);
    expect(recordBulkReviewWorkUnit.mock.calls).toEqual([
      [{ jobKind: "reject", result: "completed" }],
      [{ jobKind: "reject", result: "completed" }],
    ]);
  });

  it("reconciles terminal bulk review jobs whose stale parent total is no longer reachable", async () => {
    const harness = createBulkReviewJobHarness(2, {
      status: "running",
      progressTotal: 5,
      carriedOutcomes: [
        { observationId: "obs_carried_1", status: "rejected" },
        { observationId: "obs_carried_2", status: "rejected" },
      ],
      terminalWorkUnits: true,
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    await expect(
      services.processNextBulkReviewJob({
        claimOwnerId: "worker-reconcile",
        claimTtlMs: 120_000,
      }),
    ).resolves.toBe(1);

    expect(harness.job.status).toBe("completed");
    expect(harness.job.progress).toMatchObject({
      phase: "completed",
      completed: 4,
      total: 4,
    });
    expect(harness.job.result).toMatchObject({
      requested: 4,
      rejected: 4,
      skipped: 0,
      failed: 0,
    });
    expect(harness.job.result?.outcomes).toHaveLength(4);
    expect(harness.appendedEvents).toEqual([]);
  });

  it("snapshots selected reapply work units from each observation provider instead of the default provider", async () => {
    const insertedWorkUnits: Array<Readonly<{ unitId: string; payload: Record<string, unknown> }>> = [];
    const altdexProfile = providerProfileVersionForProvider("altdex", "altdex-pokemon-tcg", "2026.06.10");
    const altdexObservation = sourceObservationDetailRow({
      observation_id: "obs_altdex",
      provider_key: "altdex",
      external_key: "product:610001",
      source_url: "https://altdex.example/products/610001",
      source_profile_key: "altdex-pokemon-tcg",
      source_profile_version: "2026.06.10",
      source_mapping_fingerprint: "altdex-fingerprint",
      status: "promoted",
      promoted_catalog_item_id: "cat_altdex",
    });
    const deps = {
      db: {
        query: async <T>(sql: string, values: readonly unknown[] = []) => {
          if (sql.includes("FROM catalog_source_observations") && sql.includes("WHERE observation_id = $1")) {
            return { rowCount: 1, rows: [altdexObservation] as T[] };
          }

          if (sql.includes("INSERT INTO catalog_source_observation_bulk_review_jobs")) {
            const payload = JSON.parse(String(values[2])) as Record<string, unknown>;
            return {
              rowCount: 1,
              rows: [
                {
                  job_id: values[0],
                  job_kind: values[1],
                  payload,
                  event_context: JSON.parse(String(values[4])),
                  status: "queued",
                  progress: JSON.parse(String(values[3])),
                  result: null,
                  error_message: null,
                  claim_owner_id: null,
                  claimed_until: null,
                  created_at: "2026-05-28T00:00:00.000Z",
                  started_at: null,
                  completed_at: null,
                  updated_at: "2026-05-28T00:00:00.000Z",
                },
              ] as T[],
            };
          }

          if (sql.includes("INSERT INTO catalog_source_observation_bulk_review_work_units")) {
            const units = JSON.parse(String(values[1])) as Array<{
              unit_id: string;
              payload: Record<string, unknown>;
            }>;
            insertedWorkUnits.push(...units.map((unit) => ({ unitId: unit.unit_id, payload: unit.payload })));
            return { rowCount: units.length, rows: [] as T[] };
          }

          if (sql.includes("INSERT INTO catalog_source_observation_bulk_review_job_events")) {
            return { rowCount: 1, rows: [{ sequence: 1 }] as T[] };
          }

          if (sql.includes("SELECT pg_notify")) {
            return { rowCount: 1, rows: [] as T[] };
          }

          return { rowCount: 0, rows: [] as T[] };
        },
      },
      eventStore: {
        readStream: async () => [],
        appendToStream: async () => [],
        readAll: async () => [],
      },
      checkpointStore: {
        loadCheckpoint: async () => "0",
        saveCheckpoint: async () => undefined,
      },
    } as unknown as CatalogRuntimeDeps;
    const services = createSourceObservationRuntime(
      deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      createMutableProfileVersionReader([currentTcgdexProfileVersion(), altdexProfile]),
    );

    await services.enqueueBulkReviewJob({
      action: "reapply",
      observationIds: ["obs_altdex"],
      context,
    });

    expect(insertedWorkUnits).toHaveLength(1);
    expect(insertedWorkUnits[0]?.payload).toMatchObject({
      observationId: "obs_altdex",
      reapplyProfileMode: "current-active-profile",
      profileSnapshot: {
        providerKey: "altdex",
        profileKey: "altdex-pokemon-tcg",
      },
    });
  });

  it("reuses an active provider integration job with the same actor action and scope", async () => {
    const harness = createIntegrationJobDedupeHarness({
      existingJob: integrationJobRow({
        jobId: "job_existing",
        action: "import",
        scope: { provider: "tcgdex", language: "en" },
        profileSnapshot: tcgdexProfileSnapshot("2026.06.03"),
        eventContext: context,
      }),
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.enqueueIntegrationJob({
      action: "import",
      scope: { provider: "tcgdex", language: "en", seriesId: undefined, setId: undefined },
      context,
    });

    expect(job.jobId).toBe("job_existing");
    expect(harness.insertedJobs).toEqual([]);
    expect(harness.activeLookupValues[0]).toEqual(["import"]);
  });

  it("rejects production import jobs for inactive provider profile versions before enqueue", async () => {
    const harness = createIntegrationJobDedupeHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    await expect(
      services.enqueueIntegrationJob({
        action: "import",
        scope: { provider: "tcgplayer", productLineId: "3", setName: "Prismatic Evolutions" },
        context,
      }),
    ).rejects.toThrow("Provider 'tcgplayer' does not support background import.");
    expect(harness.insertedJobs).toEqual([]);
  });

  it("does not reuse active provider integration jobs from a different account context", async () => {
    const harness = createIntegrationJobDedupeHarness({
      existingJob: integrationJobRow({
        jobId: "job_other_account",
        action: "import",
        scope: { provider: "tcgdex", language: "en" },
        profileSnapshot: tcgdexProfileSnapshot("2026.06.03"),
        eventContext: {
          ...context,
          audit: {
            ...context.audit,
            forAccountId: "acc_other" as never,
          },
        },
      }),
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.enqueueIntegrationJob({
      action: "import",
      scope: { provider: "tcgdex", language: "en", seriesId: undefined, setId: undefined },
      context,
    });

    expect(job.jobId).not.toBe("job_other_account");
    expect(job.profileSnapshot).toMatchObject({
      providerKey: "tcgdex",
      profileKey: "pokemon-tcg",
      profileVersion: "2026.06.03",
      lifecycle: "active",
      connectorKind: "tcgdex-json",
      connectorSourceVersion: null,
    });
    expect(job.consistency.workUnitClaimPolicy).toBe("leased-job-turns");
    expect(job.profileSnapshot?.sourceMappingFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.insertedJobs).toHaveLength(1);
  });

  it("records a durable status event when enqueueing a provider integration job", async () => {
    const harness = createIntegrationJobDedupeHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.enqueueIntegrationJob({
      action: "import",
      scope: { provider: "tcgdex", language: "en", setId: "base1" },
      context,
    });

    expect(harness.jobEvents).toEqual([
      {
        jobKind: "integration",
        jobId: job.jobId,
        snapshot: expect.objectContaining({
          jobId: job.jobId,
          action: "import",
          status: "queued",
        }),
      },
    ]);
  });

  it("snapshots reapply profile mode on integration jobs and work units", async () => {
    const harness = createIntegrationJobDedupeHarness({
      reapplyObservationIds: ["obs_promoted_1", "obs_promoted_2"],
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.enqueueIntegrationJob({
      action: "reapply",
      scope: { provider: "tcgdex", language: "en", setId: "base1" },
      context,
    });

    expect(job).toMatchObject({
      action: "reapply",
      reapplyProfileMode: "current-active-profile",
      profileSnapshot: {
        providerKey: "tcgdex",
        profileVersion: "2026.06.03",
        connectorKind: "tcgdex-json",
        connectorSourceVersion: null,
      },
      operatorStatus: "queued",
      consistency: {
        duplicateSubmissionPolicy: "reuse-active-job",
        profileSnapshotPolicy: "snapshotted-at-enqueue",
        retryResumePolicy: "skip-completed-outcomes",
        partialFailurePolicy: "mixed-outcomes",
        workUnitClaimPolicy: "leased-work-units",
      },
      progress: {
        total: 2,
      },
    });
    expect(harness.insertedWorkUnits.map((unit) => unit.payload)).toEqual([
      expect.objectContaining({
        observationId: "obs_promoted_1",
        reapplyProfileMode: "current-active-profile",
        profileSnapshot: expect.objectContaining({
          providerKey: "tcgdex",
          profileVersion: "2026.06.03",
        }),
      }),
      expect.objectContaining({
        observationId: "obs_promoted_2",
        reapplyProfileMode: "current-active-profile",
        profileSnapshot: expect.objectContaining({
          providerKey: "tcgdex",
          profileVersion: "2026.06.03",
        }),
      }),
    ]);
  });

  it("lists active provider connector options for Catalog integration discovery", async () => {
    const services = createSourceObservationRuntime(
      { db: {} } as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const providers = await services.listIntegrationOptions({
      providerKey: "tcgdex",
      queryKind: "providers",
    });

    expect(providers).toEqual([
      expect.objectContaining({
        providerKey: "tcgdex",
        value: "tcgdex",
        label: "TCGdex",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "tcgdex-json",
        }),
      }),
    ]);
  });

  it("uses newly activated persisted profile versions for subsequent option queries", async () => {
    const profileVersions = createMutableProfileVersionReader([
      currentTcgdexProfileVersion(),
      tcgdexProfileVersion({
        profileVersion: "2026.06.04",
        lifecycle: "test",
        active: false,
        displayName: "TCGdex Candidate",
      }),
    ]);
    const services = createSourceObservationRuntime(
      { db: {} } as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      profileVersions,
    );

    await expect(
      services.listIntegrationOptions({
        providerKey: "tcgdex",
        queryKind: "providers",
      }),
    ).resolves.toEqual([expect.objectContaining({ providerKey: "tcgdex", label: "TCGdex" })]);

    profileVersions.activate("tcgdex", "2026.06.04");

    await expect(
      services.listIntegrationOptions({
        providerKey: "tcgdex",
        queryKind: "providers",
      }),
    ).resolves.toEqual([expect.objectContaining({ providerKey: "tcgdex", label: "TCGdex Candidate" })]);
  });

  it("does not run option queries against inactive provider profile versions", async () => {
    const services = createSourceObservationRuntime(
      { db: {} } as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    await expect(
      services.listIntegrationOptions({
        providerKey: "tcgplayer",
        queryKind: "languages",
      }),
    ).rejects.toThrow("Unsupported Catalog integration provider: tcgplayer.");
  });

  it("lists TCGplayer product-line and set-name options through the automation client", async () => {
    const harness = createTcgplayerImportHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      createActiveTcgplayerProfileVersions(),
    );

    const productLines = await services.listIntegrationOptions({
      providerKey: "tcgplayer",
      queryKind: "product-lines",
    });
    const setNames = await services.listIntegrationOptions({
      providerKey: "tcgplayer",
      queryKind: "set-names",
      parentValue: "3",
    });

    expect(productLines).toEqual([
      expect.objectContaining({
        providerKey: "tcgplayer",
        queryKind: "product-lines",
        value: "3",
        label: "Pokemon",
        metadata: expect.objectContaining({
          productLineId: 3,
          productLineUrlName: "pokemon",
        }),
      }),
    ]);
    expect(setNames).toEqual([
      expect.objectContaining({
        providerKey: "tcgplayer",
        queryKind: "set-names",
        value: "Prismatic Evolutions",
        label: "Prismatic Evolutions",
        parentValue: "3",
        metadata: expect.objectContaining({
          productLineId: 3,
          setNameId: 7001,
          cleanSetName: "Prismatic Evolutions",
        }),
      }),
    ]);
  });

  it("imports TCGplayer set scopes as provider-product source observations", async () => {
    const harness = createTcgplayerImportHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      createActiveTcgplayerProfileVersions(),
    );

    const result = await services.importTcgplayerScope({
      scope: { provider: "tcgplayer", productLineId: "3", setName: "Prismatic Evolutions" },
      context,
    });

    expect(result).toMatchObject({
      requested: 1,
      imported: 1,
      observed: 2,
      failed: 0,
      outcomes: [
        expect.objectContaining({
          providerKey: "tcgplayer",
          expansionId: "set:3:Prismatic Evolutions",
          status: "imported",
          observed: 2,
        }),
      ],
    });
    expect(harness.appendedSourceEvents).toHaveLength(2);
    expect(harness.appendedSourceEvents[0]).toMatchObject({
      eventType: "catalog.source-observation.recorded",
      payload: expect.objectContaining({
        observationId: "tcgplayer_en_product_610001",
        providerKey: "tcgplayer",
        externalKey: "product:610001",
        normalized: expect.objectContaining({
          kind: "provider-product",
          mergeIdentity: expect.objectContaining({
            productLineName: "Pokemon",
            setName: "Prismatic Evolutions",
            collectorNumber: "131",
          }),
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:610001" }],
          externalProductReferences: [],
          skuReferences: [
            expect.objectContaining({
              providerKey: "tcgplayer",
              externalKey: "sku:987654",
              reviewEvidence: expect.objectContaining({
                condition: "Near Mint",
                printing: "Normal",
                language: "English",
                productForm: "single",
              }),
            }),
          ],
        }),
      }),
    });
  });

  it("records fetched TCGplayer products while reporting product detail failures", async () => {
    const harness = createTcgplayerImportHarness({ failProductIds: new Set([610002]) });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      createActiveTcgplayerProfileVersions(),
    );

    const result = await services.importTcgplayerScope({
      scope: { provider: "tcgplayer", productLineId: "3", setName: "Prismatic Evolutions" },
      context,
    });

    expect(result).toMatchObject({
      requested: 1,
      imported: 0,
      observed: 1,
      failed: 1,
      outcomes: [
        expect.objectContaining({
          status: "failed",
          observed: 1,
          reason: "Imported 1 TCGplayer product details before Product 610002 unavailable.",
        }),
      ],
    });
    expect(harness.appendedSourceEvents).toHaveLength(1);
    expect(harness.appendedSourceEvents[0]?.payload).toMatchObject({
      observationId: "tcgplayer_en_product_610001",
      externalKey: "product:610001",
    });
  });

  it("retries provider integration jobs by preserving successful outcomes and pruning failed outcomes", async () => {
    const harness = createIntegrationJobDedupeHarness({
      existingJob: {
        ...integrationJobRow({
          jobId: "job_retry",
          action: "import",
          scope: { provider: "tcgdex", language: "en", seriesId: "base" },
          profileSnapshot: tcgdexProfileSnapshot("2026.06.03"),
          eventContext: context,
        }),
        status: "completed",
        progress: {
          phase: "completed",
          completed: 2,
          total: 2,
          currentName: null,
          status: "failed",
        },
        result: {
          requested: 2,
          imported: 1,
          observed: 102,
          reapplied: 0,
          skipped: 0,
          failed: 1,
          outcomes: [
            {
              providerKey: "tcgdex",
              languageCode: "en",
              expansionId: "base1",
              status: "imported",
              observed: 102,
              reapplied: 0,
              reason: null,
            },
            {
              providerKey: "tcgdex",
              languageCode: "en",
              expansionId: "base2",
              status: "failed",
              observed: 0,
              reapplied: 0,
              reason: "Provider timeout.",
            },
          ],
        },
        completed_at: "2026-05-28T00:00:05.000Z",
      },
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.retryIntegrationJob({ jobId: "job_retry", context });

    expect(job).toMatchObject({
      jobId: "job_retry",
      status: "queued",
      progress: {
        phase: "queued",
        completed: 1,
        total: 2,
      },
      result: {
        requested: 2,
        imported: 1,
        failed: 0,
      },
    });
    expect(job.result?.outcomes).toEqual([expect.objectContaining({ expansionId: "base1", status: "imported" })]);
    expect(harness.jobEvents[harness.jobEvents.length - 1]?.snapshot).toMatchObject({
      jobId: "job_retry",
      status: "queued",
    });
  });

  it("cancels provider integration jobs as operator-cancelled failed durable jobs", async () => {
    const harness = createIntegrationJobDedupeHarness({
      existingJob: {
        ...integrationJobRow({
          jobId: "job_cancel",
          action: "import",
          scope: { provider: "tcgdex", language: "en", seriesId: "base" },
          profileSnapshot: tcgdexProfileSnapshot("2026.06.03"),
          eventContext: context,
          progress: {
            phase: "processing",
            completed: 1,
            total: 2,
            currentName: "Base Set",
            status: "imported",
          },
        }),
        status: "running",
        claim_owner_id: "worker-1",
        claimed_until: "2026-05-28T00:10:00.000Z",
      },
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.cancelIntegrationJob({ jobId: "job_cancel", context });

    expect(job).toMatchObject({
      jobId: "job_cancel",
      status: "failed",
      operatorStatus: "cancelled",
      progress: {
        phase: "failed",
        completed: 1,
        total: 2,
      },
      errorMessage: "Operator cancelled provider import job.",
    });
  });

  it("processes queued TCGplayer imports through the durable integration worker", async () => {
    const tcgplayerHarness = createTcgplayerImportHarness();
    const harness = createIntegrationJobClaimHandoffHarness({
      scope: { provider: "tcgplayer", productLineId: "3", setName: "Prismatic Evolutions" },
      renewSucceeds: true,
      tcgplayerAutomationCatalogClient: tcgplayerHarness.client,
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      harness.referenceData,
      createActiveTcgplayerProfileVersions(),
    );

    await expect(
      services.processNextIntegrationJob({
        claimOwnerId: "worker-1",
        claimTtlMs: 120_000,
      }),
    ).resolves.toBe(1);

    expect(harness.job.status).toBe("completed");
    expect(harness.job.progress).toMatchObject({
      phase: "completed",
      completed: 1,
      total: 1,
    });
    expect(harness.job.result).toMatchObject({
      requested: 1,
      imported: 1,
      observed: 2,
      failed: 0,
    });
    expect(harness.appendedSourceEvents).toHaveLength(2);
  });

  it("processes queued imports with the snapshotted profile version after a newer version is activated", async () => {
    const harness = createIntegrationJobClaimHandoffHarness({
      profileSnapshot: tcgdexProfileSnapshot("2026.06.03"),
      renewSucceeds: true,
    });
    const profileVersions = createMutableProfileVersionReader([
      tcgdexProfileVersion({
        profileVersion: "2026.06.03",
        lifecycle: "deprecated",
        active: false,
        displayName: "TCGdex",
      }),
      tcgdexProfileVersion({
        profileVersion: "2026.06.04",
        lifecycle: "active",
        active: true,
        displayName: "TCGdex Candidate",
      }),
    ]);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      const body =
        fetchCount === 1
          ? {
              id: "base1",
              name: "Base Set",
              serie: { id: "base", name: "Base" },
              cardCount: { official: 102, total: 102 },
              cards: [{ id: "base1-1", localId: "1", name: "Abra" }],
            }
          : {
              id: "base1-1",
              localId: "1",
              name: "Abra",
              category: "Pokemon",
              rarity: "Common",
              set: { id: "base1", name: "Base Set" },
              variants: { normal: true },
            };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      harness.referenceData,
      profileVersions,
    );

    try {
      await expect(
        services.processNextIntegrationJob({
          claimOwnerId: "worker-1",
          claimTtlMs: 120_000,
        }),
      ).resolves.toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(harness.job.status).toBe("completed");
    expect(harness.appendedSourceEvents[0]?.payload).toMatchObject({
      providerKey: "tcgdex",
      sourceProfileVersion: "2026.06.03",
    });
  });

  it("hands off provider integration imports when the durable claim is lost before recording observations", async () => {
    const harness = createIntegrationJobClaimHandoffHarness();
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      const body =
        fetchCount === 1
          ? {
              id: "base1",
              name: "Base Set",
              serie: { id: "base", name: "Base" },
              cardCount: { official: 102, total: 102 },
              cards: [{ id: "base1-1", localId: "1", name: "Abra" }],
            }
          : {
              id: "base1-1",
              localId: "1",
              name: "Abra",
              category: "Pokemon",
              rarity: "Common",
              set: { id: "base1", name: "Base Set" },
              variants: { normal: true },
            };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const services = createSourceObservationRuntime(harness.deps, {} as CatalogItemServices, harness.referenceData);

    try {
      await expect(
        services.processNextIntegrationJob({
          claimOwnerId: "worker-1",
          claimTtlMs: 120_000,
        }),
      ).resolves.toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(harness.job.status).toBe("running");
    expect(harness.job.result).toBeNull();
    expect(harness.job.error_message).toBeNull();
    expect(harness.appendedSourceEvents).toEqual([]);
    expect(harness.renewAttempts).toBe(1);
  });

  it("returns an empty active integration job list when request context is missing", async () => {
    const harness = createIntegrationJobDedupeHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    await expect(services.listActiveIntegrationJobs({ context: null })).resolves.toEqual([]);
    expect(harness.queryCount).toBe(0);
  });

  it("propagates credential readiness separately from semantic readiness", async () => {
    const harness = createIntegrationJobDedupeHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const readiness = await services.getCatalogIntegrationControlPlaneReadiness();
    const unitsByKey = Object.fromEntries(readiness.units.map((unit) => [unit.unitKey, unit]));

    expect(unitsByKey["reference-cards:pokemon:single-card:source-observation-proof"]).toMatchObject({
      semanticReadiness: "ready",
      credentialReadiness: "not-required",
      credentialReadinessState: "not-required",
    });
    expect(unitsByKey["tcgdex:pokemon:single-card:source-observation-import"]).toMatchObject({
      semanticReadiness: "ready",
      credentialReadiness: "not-required",
      credentialReadinessState: "not-required",
    });
    expect(unitsByKey["tcgplayer:pokemon:single-card:source-observation-import"]).toMatchObject({
      credentialReadiness: "blocked",
      credentialReadinessState: "missing",
      credentialDiagnosticCode: "credential-missing",
      transportReadiness: "blocked",
    });
  });
});

function pokemonObservation(input: {
  expansionName: string;
  seriesName: string;
  cardNumber?: string;
  expansionCardCount?: number | null;
  name?: string;
  rarity?: string | null;
  cardVariantKey?: string;
  cardVariantLabel?: string;
  cardVariantSourceKey?: string | null;
  parallelSet?: boolean;
}): SourceObservationPokemonCardNormalized {
  return {
    kind: "pokemon-card",
    tcg: "pokemon",
    languageCode: "en",
    name: input.name ?? "Furret",
    cardNumber: input.cardNumber ?? "136",
    setId: "me02.5",
    setName: input.expansionName,
    expansionId: "me02.5",
    expansionName: input.expansionName,
    expansionAbbreviation: "MEH",
    expansionCardCount: input.expansionCardCount === undefined ? 217 : input.expansionCardCount,
    expansionParallelSetCardCount: 78,
    seriesId: "me",
    seriesName: input.seriesName,
    rarity: input.rarity ?? "Uncommon",
    illustrator: "tetsuya koizumi",
    releaseDate: "2026-05-18",
    releaseYear: 2026,
    category: "Pokemon",
    imageBaseUrl: null,
    imageUrls: [],
    productAssetSet: null,
    parallelSet: input.parallelSet ?? true,
    cardVariantKey: input.cardVariantKey ?? "reverse-holo",
    cardVariantLabel: input.cardVariantLabel ?? "Parallel Set - Reverse Foil",
    cardVariantSourceKey: input.cardVariantSourceKey ?? "reverse",
    cardVariantIsPrimaryImage: false,
    imageDisclaimer:
      "TCGDex provides one image for this card number. This Catalog Item represents the Parallel Set - Reverse Foil variant, so the image may not show the exact foil or pattern.",
    variants: {},
  };
}

function sourceObservationDetailRow(overrides: Record<string, unknown> = {}) {
  const normalized = pokemonObservation({
    expansionName: "Base Set",
    seriesName: "Base",
    name: "Selected Observation",
  });

  return {
    observation_id: "obs_selected",
    provider_key: "tcgdex",
    external_key: "base1-1",
    source_url: "https://api.tcgdex.net/v2/en/cards/base1-1",
    language_code: "en",
    source_record_hash: "hash-selected",
    source_updated_at: "2026-05-20T00:00:00.000Z",
    observed_at: "2026-05-20T00:00:00.000Z",
    source_profile_key: "pokemon-tcg",
    source_profile_version: "2026.06.03",
    source_mapping_fingerprint: "fingerprint:2026.06.03",
    normalized,
    source_payload: { id: "base1-1" },
    status: "promoted",
    status_reason: null,
    promoted_catalog_item_id: "cat_selected",
    promoted_at: "2026-05-20T00:01:00.000Z",
    promotion_profile_key: "pokemon-tcg",
    promotion_profile_version: "2026.06.03",
    promotion_plan_fingerprint: "plan-fingerprint:2026.06.03",
    updated_at: "2026-05-20T00:01:00.000Z",
    ...overrides,
  };
}

function createTcgplayerImportHarness(input: { failProductIds?: ReadonlySet<number> } = {}) {
  const appendedSourceEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const productDetails = new Map<number, TcgplayerAutomationProductDetail>([
    [610001, tcgplayerProductDetail({ productId: 610001, productName: "Eevee ex", number: "131", sku: 987654 })],
    [610002, tcgplayerProductDetail({ productId: 610002, productName: "Umbreon ex", number: "161", sku: 987655 })],
  ]);
  const client: TcgplayerAutomationCatalogClient = {
    listProductLines: async () => [
      {
        productLineId: 3,
        productLineName: "Pokemon",
        productLineUrlName: "pokemon",
        isDirect: true,
      },
    ],
    listCatalogSetNames: async () => ({
      errors: [],
      results: [
        {
          setNameId: 7001,
          categoryId: 3,
          name: "Prismatic Evolutions",
          cleanSetName: "Prismatic Evolutions",
          urlName: "prismatic-evolutions",
          abbreviation: "PRE",
          releaseDate: "2025-01-17",
          isSupplemental: false,
          active: true,
        },
      ],
    }),
    searchProducts: async () => ({
      errors: [],
      results: [],
    }),
    listAllProducts: async () => [
      {
        productId: 610001,
        productName: "Eevee ex",
        productLineId: 3,
        productLineName: "Pokemon",
        productTypeName: "Cards",
        setId: 7001,
        setName: "Prismatic Evolutions",
        setUrlName: "prismatic-evolutions",
        rarityName: "Special Illustration Rare",
        sealed: false,
        productStatusId: 1,
        customAttributes: { number: "131", releaseDate: "2025-01-17", cardType: ["Pokemon"] },
      },
      {
        productId: 610002,
        productName: "Umbreon ex",
        productLineId: 3,
        productLineName: "Pokemon",
        productTypeName: "Cards",
        setId: 7001,
        setName: "Prismatic Evolutions",
        setUrlName: "prismatic-evolutions",
        rarityName: "Special Illustration Rare",
        sealed: false,
        productStatusId: 1,
        customAttributes: { number: "161", releaseDate: "2025-01-17", cardType: ["Pokemon"] },
      },
    ],
    getProductDetail: async ({ productId }) => {
      if (input.failProductIds?.has(productId)) {
        throw new Error(`Product ${productId} unavailable.`);
      }
      const detail = productDetails.get(productId);
      if (!detail) {
        throw new Error(`Product ${productId} not found.`);
      }
      return detail;
    },
  };
  const deps = {
    db: {
      query: async <T>() => ({ rowCount: 0, rows: [] as T[] }),
    },
    eventStore: {
      readStream: async () => [],
      appendToStream: async (eventInput: {
        streamId: string;
        events: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
      }) => {
        appendedSourceEvents.push(...eventInput.events);
        return eventInput.events.map((event, index) =>
          storedEvent(index + 1, eventInput.streamId, event.eventType, event.payload),
        );
      },
      readAll: async () => [],
    },
    checkpointStore: {
      loadCheckpoint: async () => "0",
      saveCheckpoint: async () => undefined,
    },
    tcgplayerAutomationCatalogClient: client,
  } as unknown as CatalogRuntimeDeps;

  return {
    deps,
    client,
    appendedSourceEvents,
  };
}

function tcgplayerProductDetail(input: {
  productId: number;
  productName: string;
  number: string;
  sku: number;
}): TcgplayerAutomationProductDetail {
  return {
    productTypeName: "Cards",
    rarityName: "Special Illustration Rare",
    sealed: false,
    productName: input.productName,
    setId: 7001,
    setCode: "PRE",
    productId: input.productId,
    setName: "Prismatic Evolutions",
    productLineId: 3,
    productStatusId: 1,
    productLineName: "Pokemon",
    customAttributes: {
      number: input.number,
      releaseDate: "2025-01-17",
      cardType: ["Pokemon"],
    },
    formattedAttributes: {
      Artist: "Catalog Artist",
    },
    skus: [
      {
        sku: input.sku,
        condition: "Near Mint",
        variant: "Normal",
        language: "English",
      },
    ],
    marketPrice: 12.34,
    lowestPrice: 10.01,
    lowestPriceWithShipping: 11.23,
    medianPrice: 12.5,
    listings: 25,
  };
}

function createIntegrationJobDedupeHarness(
  input: { existingJob?: Record<string, unknown>; reapplyObservationIds?: readonly string[] } = {},
) {
  let existingJob = input.existingJob ? { ...input.existingJob } : undefined;
  const insertedJobs: Record<string, unknown>[] = [];
  const insertedWorkUnits: Array<Readonly<{ unitId: string; unitKind: string; payload: Record<string, unknown> }>> = [];
  const jobEvents: Record<string, unknown>[] = [];
  let queryCount = 0;
  let activeLookupValues: readonly unknown[] = [];

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        queryCount += 1;

        if (
          sql.includes("FROM catalog_source_observation_integration_durable_jobs") &&
          sql.includes("status IN ('queued', 'running')")
        ) {
          activeLookupValues = values;
          return {
            rowCount: existingJob ? 1 : 0,
            rows: (existingJob ? [existingJob] : []) as T[],
          };
        }

        if (sql.includes("SELECT observation_id FROM catalog_source_observations")) {
          const rows = (input.reapplyObservationIds ?? []).map((observationId) => ({
            observation_id: observationId,
          }));
          return { rowCount: rows.length, rows: rows as T[] };
        }

        if (sql.includes("INSERT INTO catalog_source_observation_integration_durable_jobs")) {
          const payload = JSON.parse(String(values[2])) as Record<string, unknown>;
          const row = integrationJobRow({
            jobId: String(values[0]),
            action: String(values[1]),
            scope: payload.scope as Record<string, unknown>,
            profileSnapshot: payload.profileSnapshot as Record<string, unknown> | null,
            reapplyProfileMode: payload.reapplyProfileMode as string | null,
            eventContext: JSON.parse(String(values[4])) as EventStoreContext,
            progress: JSON.parse(String(values[3])) as Record<string, unknown>,
          });
          insertedJobs.push(row);
          return { rowCount: 1, rows: [row] as T[] };
        }

        if (sql.includes("INSERT INTO catalog_source_observation_integration_work_units")) {
          const units = JSON.parse(String(values[1])) as Array<{
            unit_id: string;
            unit_kind: string;
            payload: Record<string, unknown>;
          }>;
          insertedWorkUnits.push(
            ...units.map((unit) => ({
              unitId: unit.unit_id,
              unitKind: unit.unit_kind,
              payload: unit.payload,
            })),
          );
          return { rowCount: units.length, rows: [] as T[] };
        }

        if (sql.includes("INSERT INTO catalog_source_observation_integration_job_events")) {
          jobEvents.push({
            jobKind: "integration",
            jobId: values[0],
            snapshot: JSON.parse(String(values[1])) as Record<string, unknown>,
          });
          return { rowCount: 1, rows: [{ sequence: jobEvents.length }] as T[] };
        }

        if (sql.includes("SELECT pg_notify")) {
          return { rowCount: 1, rows: [] as T[] };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_integration_durable_jobs") &&
          sql.includes("completed_at = NULL") &&
          existingJob?.job_id === values[0]
        ) {
          const currentJob = existingJob!;
          existingJob = {
            ...currentJob,
            status: "queued",
            progress: JSON.parse(String(values[1])),
            result: values[2] == null ? currentJob.result : JSON.parse(String(values[2])),
            error_message: values[3] as string | null,
            claim_owner_id: null,
            claimed_until: null,
            completed_at: null,
            updated_at: "2026-05-28T00:00:10.000Z",
          };
          return { rowCount: 1, rows: [existingJob] as T[] };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_integration_durable_jobs") &&
          sql.includes("status = 'failed'") &&
          existingJob?.job_id === values[0]
        ) {
          const currentJob = existingJob!;
          existingJob = {
            ...currentJob,
            status: "failed",
            progress: JSON.parse(String(values[1])),
            error_message: String(values[2]),
            claim_owner_id: null,
            claimed_until: null,
            completed_at: "2026-05-28T00:00:10.000Z",
            updated_at: "2026-05-28T00:00:10.000Z",
          };
          return { rowCount: 1, rows: [existingJob] as T[] };
        }

        if (
          sql.includes("FROM catalog_source_observation_integration_durable_jobs") &&
          sql.includes("WHERE job_id = $1")
        ) {
          const row =
            existingJob?.job_id === values[0] ? existingJob : insertedJobs.find((job) => job.job_id === values[0]);
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
    eventStore: {
      readStream: async () => [],
      appendToStream: async () => [],
      readAll: async () => [],
    },
    checkpointStore: {
      loadCheckpoint: async () => "0",
      saveCheckpoint: async () => undefined,
    },
  } as unknown as CatalogRuntimeDeps;

  return {
    deps,
    insertedJobs,
    insertedWorkUnits,
    jobEvents,
    get activeLookupValues() {
      return activeLookupValues;
    },
    get queryCount() {
      return queryCount;
    },
  };
}

function integrationJobRow(input: {
  jobId: string;
  action: string;
  scope: Record<string, unknown>;
  profileSnapshot?: Record<string, unknown> | null;
  reapplyProfileMode?: string | null;
  eventContext: EventStoreContext;
  progress?: Record<string, unknown>;
}) {
  return {
    job_id: input.jobId,
    job_kind: input.action,
    payload: {
      action: input.action,
      scope: input.scope,
      profileSnapshot: input.profileSnapshot ?? null,
      reapplyProfileMode: input.reapplyProfileMode ?? null,
    },
    event_context: input.eventContext,
    status: "queued",
    progress:
      input.progress ??
      ({
        phase: "queued",
        completed: 0,
        total: 0,
        currentName: null,
        status: null,
      } as const),
    result: null,
    error_message: null,
    claim_owner_id: null,
    claimed_until: null,
    created_at: "2026-05-28T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    updated_at: "2026-05-28T00:00:00.000Z",
  };
}

function createIntegrationJobClaimHandoffHarness(
  input: {
    scope?: Record<string, unknown>;
    profileSnapshot?: Record<string, unknown> | null;
    renewSucceeds?: boolean;
    tcgplayerAutomationCatalogClient?: TcgplayerAutomationCatalogClient;
  } = {},
) {
  const appendedSourceEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  let renewAttempts = 0;
  const job = {
    job_id: "job_import_base1",
    job_kind: "import",
    payload: {
      action: "import",
      scope: input.scope ?? {
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
      profileSnapshot: input.profileSnapshot ?? null,
    },
    event_context: context,
    status: "queued",
    progress: {
      phase: "queued",
      completed: 0,
      total: 0,
      currentName: null,
      status: null,
    },
    result: null as null | Record<string, unknown>,
    error_message: null as string | null,
    claim_owner_id: null as string | null,
    claimed_until: null as string | null,
    created_at: "2026-05-20T00:00:00.000Z",
    started_at: null as string | null,
    completed_at: null as string | null,
    updated_at: "2026-05-20T00:00:00.000Z",
  };

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("UPDATE catalog_source_observation_integration_durable_jobs AS job")) {
          if (job.status !== "queued") {
            return { rowCount: 0, rows: [] as T[] };
          }
          job.status = "running";
          job.claim_owner_id = String(values[0]);
          job.claimed_until = "2026-05-20T00:02:00.000Z";
          job.started_at ??= "2026-05-20T00:00:00.000Z";
          return { rowCount: 1, rows: [job] as T[] };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_integration_durable_jobs") &&
          sql.includes("SET claimed_until") &&
          !sql.includes("RETURNING")
        ) {
          renewAttempts += 1;
          return { rowCount: input.renewSucceeds ? 1 : 0, rows: [] as T[] };
        }

        if (sql.includes("UPDATE catalog_source_observation_integration_durable_jobs")) {
          if (String(values[1]) !== job.claim_owner_id) {
            return { rowCount: 0, rows: [] as T[] };
          }
          if (sql.includes("status = 'completed'")) {
            job.status = "completed";
            job.progress = JSON.parse(String(values[2]));
            job.result = JSON.parse(String(values[3]));
            job.claim_owner_id = null;
            job.claimed_until = null;
            job.completed_at = "2026-05-20T00:00:00.000Z";
          } else if (sql.includes("status = 'failed'")) {
            job.status = "failed";
            job.progress = JSON.parse(String(values[2]));
            job.error_message = String(values[3]);
            job.claim_owner_id = null;
            job.claimed_until = null;
            job.completed_at = "2026-05-20T00:00:00.000Z";
          } else {
            job.progress = JSON.parse(String(values[2]));
            if (values[3] !== null && values[3] !== undefined) {
              job.result = JSON.parse(String(values[3]));
            }
            job.claimed_until = "2026-05-20T00:02:00.000Z";
          }
          return { rowCount: 1, rows: [job] as T[] };
        }

        if (sql.includes("INSERT INTO catalog_source_observation_integration_job_events")) {
          return { rowCount: 1, rows: [{ sequence: 1 }] as T[] };
        }

        if (sql.includes("SELECT pg_notify")) {
          return { rowCount: 1, rows: [] as T[] };
        }

        if (sql.includes("FROM catalog_reference_types")) {
          return { rowCount: 1, rows: [{ reference_type_id: String(values[0]) }] as T[] };
        }

        if (sql.includes("WHERE reference_record_id = $1")) {
          return { rowCount: 1, rows: [{ attributes: {} }] as T[] };
        }

        if (sql.includes("FROM catalog_reference_records")) {
          return { rowCount: 1, rows: [{ reference_record_id: `ref_${String(values[1] ?? "existing")}` }] as T[] };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
    eventStore: {
      readStream: async () => [],
      appendToStream: async (input: {
        events: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
      }) => {
        appendedSourceEvents.push(...input.events);
        return input.events.map((event, index) =>
          storedEvent(index + 1, "catalog.source-observation-obs_1", event.eventType, event.payload),
        );
      },
      readAll: async () => [],
    },
    checkpointStore: {
      loadCheckpoint: async () => "0",
      saveCheckpoint: async () => undefined,
    },
    tcgplayerAutomationCatalogClient: input.tcgplayerAutomationCatalogClient,
  } as unknown as CatalogRuntimeDeps;

  const referenceData = {
    referenceTypeCommandHandler: async () => ({ version: 1, state: {} }),
    referenceRecordCommandHandler: async () => ({ version: 1, state: {} }),
    projectors: [],
  } as unknown as ReferenceDataServices;

  return {
    deps,
    referenceData,
    job,
    appendedSourceEvents,
    get renewAttempts() {
      return renewAttempts;
    },
  };
}

function createReferencePreloadHarness() {
  const referenceTypes = new Map<string, ReferenceTypeRow>();
  const referenceRecords = new Map<string, ReferenceRecordRow>();
  const referenceRecordCreateCommands: Extract<ReferenceRecordCommand, { type: "CreateReferenceRecord" }>[] = [];
  let projectorRuns = 0;

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("FROM catalog_reference_types")) {
          const referenceTypeId = String(values[0]);
          const row = referenceTypes.get(referenceTypeId);
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        if (sql.includes("WHERE type_key = $1 AND key = $2")) {
          const typeKey = String(values[0]);
          const key = String(values[1]);
          const row = Array.from(referenceRecords.values()).find(
            (record) => record.type_key === typeKey && record.key === key,
          );
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        if (sql.includes("attributes ->> $2")) {
          const typeKey = String(values[0]);
          const attributeKey = String(values[1]);
          const attributeValue = String(values[2]);
          const row = Array.from(referenceRecords.values()).find(
            (record) => record.type_key === typeKey && record.attributes[attributeKey] === attributeValue,
          );
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
  } as unknown as CatalogRuntimeDeps;

  const referenceData = {
    referenceTypeCommandHandler: async (input: { command: ReferenceTypeCommand }) => {
      if (input.command.type === "CreateReferenceType") {
        referenceTypes.set(input.command.referenceTypeId, {
          reference_type_id: input.command.referenceTypeId,
          key: input.command.key,
        });
      }
    },
    referenceRecordCommandHandler: async (input: { command: ReferenceRecordCommand }) => {
      if (input.command.type === "CreateReferenceRecord") {
        referenceRecordCreateCommands.push(input.command);
        referenceRecords.set(input.command.referenceRecordId, {
          reference_record_id: input.command.referenceRecordId,
          type_key: input.command.typeKey,
          key: input.command.key,
          attributes: input.command.attributes ?? {},
        });
      }
    },
    projectors: [
      {
        runOnce: async () => {
          projectorRuns += 1;
          return { processed: 0 };
        },
      },
    ],
  } as unknown as ReferenceDataServices;

  return {
    deps,
    referenceData,
    referenceRecordCreateCommands,
    projectorRuns: () => projectorRuns,
    referenceRecordsByProviderAttribute(typeKey: string, attributeKey: string, attributeValue: string) {
      return Array.from(referenceRecords.values()).filter(
        (record) => record.type_key === typeKey && record.attributes[attributeKey] === attributeValue,
      );
    },
  };
}

function createChangedObservationRefreshHarness(
  input: {
    normalized?: SourceObservationPokemonCardNormalized;
    providerKey?: string;
    sourceProfileKey?: string;
    sourceProfileVersion?: string;
    sourceMappingFingerprint?: string;
    expansionAttributes?: Readonly<Record<string, JsonValue>>;
    status?: string;
    promotedCatalogItemId?: string | null;
    reusableCatalogItemId?: string | null;
    reusableExternalCatalogItemIds?: readonly string[];
    deterministicCatalogItemIds?: readonly string[];
    partialCatalogItemId?: string | null;
    promotionCommandAlreadyApplied?: { catalogItemId: string };
  } = {},
) {
  const itemCommands: Array<{ streamId: string; command: { type: string } & Record<string, unknown> }> = [];
  const appendedSourceEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  let itemProjectorRuns = 0;
  let referenceProjectorRuns = 0;
  const normalized =
    input.normalized ??
    pokemonObservation({
      expansionName: "Ascended Heroes Updated",
      seriesName: "Mega Evolution",
    });
  const observationRow = {
    observation_id: "obs_changed",
    provider_key: input.providerKey ?? "tcgdex",
    external_key: "me02.5-136:reverse-holo",
    source_url: "https://api.tcgdex.net/v2/en/cards/me02.5-136",
    language_code: "en",
    source_record_hash: "new-hash",
    source_updated_at: "2026-05-20T00:00:00.000Z",
    observed_at: "2026-05-20T00:00:00.000Z",
    source_profile_key: input.sourceProfileKey ?? "pokemon-tcg",
    source_profile_version: input.sourceProfileVersion ?? "2026.06.03",
    source_mapping_fingerprint: input.sourceMappingFingerprint ?? "fingerprint:2026.06.03",
    normalized,
    source_payload: { id: "me02.5-136" },
    status: input.status ?? "changed",
    status_reason: null,
    promoted_catalog_item_id: input.promotedCatalogItemId === undefined ? "cat_existing" : input.promotedCatalogItemId,
    promoted_at: "2026-05-19T00:00:00.000Z",
    updated_at: "2026-05-20T00:00:00.000Z",
  };
  const streamId = "catalog.source-observation-obs_changed";
  const observationStatus = input.status ?? "changed";
  const promotionCommandAlreadyApplied = input.promotionCommandAlreadyApplied;
  const sourceEvents = [
    storedEvent(1, streamId, "catalog.source-observation.recorded", {
      ...observationRow,
      observationId: observationRow.observation_id,
      providerKey: observationRow.provider_key,
      externalKey: observationRow.external_key,
      sourceUrl: observationRow.source_url,
      languageCode: observationRow.language_code,
      sourceRecordHash: observationStatus === "observed" ? observationRow.source_record_hash : "old-hash",
      sourceUpdatedAt: observationStatus === "observed" ? observationRow.source_updated_at : null,
      observedAt: observationStatus === "observed" ? observationRow.observed_at : "2026-05-19T00:00:00.000Z",
      sourceProfileKey: observationRow.source_profile_key,
      sourceProfileVersion: observationRow.source_profile_version,
      sourceMappingFingerprint: observationRow.source_mapping_fingerprint,
      normalized,
      sourcePayload: observationRow.source_payload,
    }),
    ...(observationStatus === "observed"
      ? []
      : [
          storedEvent(2, streamId, "catalog.source-observation.promoted", {
            catalogItemId: observationRow.promoted_catalog_item_id ?? "cat_existing",
            promotedAt: "2026-05-19T00:00:00.000Z",
            promotionProfileKey: observationRow.source_profile_key,
            promotionProfileVersion: observationRow.source_profile_version,
            promotionPlanFingerprint: "plan-fingerprint:2026.06.03",
          }),
        ]),
    ...(observationStatus === "changed"
      ? [
          storedEvent(3, streamId, "catalog.source-observation.changed", {
            observationId: observationRow.observation_id,
            providerKey: observationRow.provider_key,
            externalKey: observationRow.external_key,
            sourceUrl: observationRow.source_url,
            languageCode: observationRow.language_code,
            sourceRecordHash: observationRow.source_record_hash,
            sourceUpdatedAt: observationRow.source_updated_at,
            observedAt: observationRow.observed_at,
            sourceProfileKey: observationRow.source_profile_key,
            sourceProfileVersion: observationRow.source_profile_version,
            sourceMappingFingerprint: observationRow.source_mapping_fingerprint,
            normalized,
            sourcePayload: observationRow.source_payload,
          }),
        ]
      : []),
  ];

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("FROM catalog_source_observations")) {
          return {
            rowCount: 1,
            rows: [observationRow] as T[],
          };
        }

        if (sql.includes("FROM catalog_items AS item") && sql.includes("item.status NOT IN")) {
          return {
            rowCount: input.deterministicCatalogItemIds?.length ?? 0,
            rows: (input.deterministicCatalogItemIds ?? []).map((catalogItemId) => ({
              catalog_item_id: catalogItemId,
            })) as T[],
          };
        }

        if (sql.includes("FROM catalog_items AS item")) {
          const row = input.partialCatalogItemId ? { catalog_item_id: input.partialCatalogItemId } : null;
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        if (sql.includes("FROM catalog_external_catalog_item_references")) {
          return {
            rowCount: input.reusableExternalCatalogItemIds?.length ?? 0,
            rows: (input.reusableExternalCatalogItemIds ?? []).map((catalogItemId) => ({
              catalog_item_id: catalogItemId,
            })) as T[],
          };
        }

        if (sql.includes("FROM catalog_external_product_references")) {
          const row = input.reusableCatalogItemId ? { catalog_item_id: input.reusableCatalogItemId } : null;
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        if (sql.includes("FROM catalog_reference_types")) {
          return {
            rowCount: 1,
            rows: [{ reference_type_id: String(values[0]) }] as T[],
          };
        }

        if (sql.includes("WHERE reference_record_id = $1")) {
          return {
            rowCount: 1,
            rows: [{ attributes: input.expansionAttributes ?? {} }] as T[],
          };
        }

        if (sql.includes("FROM catalog_reference_records")) {
          return {
            rowCount: 1,
            rows: [{ reference_record_id: `ref_${String(values[1] ?? "existing")}` }] as T[],
          };
        }

        if (sql.includes("FROM catalog_blueprints")) {
          return { rowCount: 1, rows: [{ id: "bpr_pokemon" }] as T[] };
        }

        if (sql.includes("FROM catalog_categories")) {
          return { rowCount: 1, rows: [{ id: "cat_singles" }] as T[] };
        }

        if (sql.includes("FROM catalog_fields")) {
          return { rowCount: 1, rows: [{ id: `fld_${String(values[0])}` }] as T[] };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
    eventStore: {
      readStream: async () => sourceEvents,
      appendToStream: async (input: {
        events: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
      }) => {
        if (
          promotionCommandAlreadyApplied &&
          input.events.some((event) => event.eventType === "catalog.source-observation.promoted")
        ) {
          observationRow.status = "promoted";
          observationRow.promoted_catalog_item_id = promotionCommandAlreadyApplied.catalogItemId;
          throw new Error("Only observed or changed source observations can be promoted.");
        }
        appendedSourceEvents.push(...input.events);
        return input.events.map((event, index) => storedEvent(4 + index, streamId, event.eventType, event.payload));
      },
      readAll: async () => [],
    },
    checkpointStore: {
      loadCheckpoint: async () => "0",
      saveCheckpoint: async () => undefined,
    },
  } as unknown as CatalogRuntimeDeps;

  const items = {
    commandHandler: async (input: { streamId: string; command: { type: string } & Record<string, unknown> }) => {
      itemCommands.push(input);
      return { version: itemCommands.length, state: { status: "draft" } };
    },
    projectors: [
      {
        runOnce: async () => {
          itemProjectorRuns += 1;
          return { processed: 0, lastGlobalPosition: "0" };
        },
      },
    ],
  } as unknown as CatalogItemServices;

  const referenceData = {
    referenceTypeCommandHandler: async () => ({ version: 1, state: {} }),
    referenceRecordCommandHandler: async () => ({ version: 1, state: {} }),
    projectors: [
      {
        runOnce: async () => {
          referenceProjectorRuns += 1;
          return { processed: 0, lastGlobalPosition: "0" };
        },
      },
    ],
  } as unknown as ReferenceDataServices;

  return {
    deps,
    items,
    referenceData,
    itemCommands,
    appendedSourceEvents,
    projectorRuns: () => itemProjectorRuns + referenceProjectorRuns,
  };
}

function createBulkReviewJobHarness(
  count: number,
  options: {
    status?: "queued" | "running" | "completed" | "failed";
    progressTotal?: number;
    carriedOutcomes?: ReadonlyArray<{ observationId: string; status: "rejected"; reason?: string | null }>;
    terminalWorkUnits?: boolean;
  } = {},
) {
  const observationIds = Array.from({ length: count }, (_, index) => `obs_${index + 1}`);
  const observations = new Map(
    observationIds.map((observationId, index) => [
      observationId,
      {
        observation_id: observationId,
        provider_key: "tcgdex",
        external_key: `card-${index + 1}`,
        source_url: `https://api.tcgdex.net/v2/en/cards/card-${index + 1}`,
        language_code: "en",
        source_record_hash: `hash-${index + 1}`,
        source_updated_at: "2026-05-20T00:00:00.000Z",
        observed_at: "2026-05-20T00:00:00.000Z",
        source_profile_key: "pokemon-tcg",
        source_profile_version: "2026.06.03",
        source_mapping_fingerprint: "fingerprint:2026.06.03",
        normalized: pokemonObservation({
          expansionName: "Base Set",
          seriesName: "Base",
          name: `Card ${index + 1}`,
        }),
        source_payload: { id: `card-${index + 1}` },
        status: "observed",
        status_reason: null,
        promoted_catalog_item_id: null,
        promoted_at: null,
        updated_at: "2026-05-20T00:00:00.000Z",
      },
    ]),
  );
  const job = {
    job_id: "job_bulk_review",
    job_kind: "reject",
    payload: {
      action: "reject",
      selectionMode: "ids",
      observationIds,
      scope: {},
      reason: "Out of scope.",
    },
    event_context: context,
    status: options.status ?? "queued",
    progress: {
      phase: "queued",
      completed: 0,
      total: options.progressTotal ?? 0,
      currentName: null,
      status: null,
    },
    result: options.carriedOutcomes
      ? ({
          requested: options.progressTotal ?? options.carriedOutcomes.length,
          rejected: options.carriedOutcomes.length,
          skipped: 0,
          failed: 0,
          outcomes: options.carriedOutcomes,
        } as Record<string, unknown>)
      : (null as null | Record<string, unknown>),
    error_message: null as string | null,
    claim_owner_id: null as string | null,
    claimed_until: null as string | null,
    created_at: "2026-05-20T00:00:00.000Z",
    started_at: null as string | null,
    completed_at: null as string | null,
    updated_at: "2026-05-20T00:00:00.000Z",
  };
  const appendedEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const workUnits = new Map<
    string,
    {
      unit_id: string;
      unit_kind: string;
      state: "queued" | "running" | "completed" | "failed" | "skipped";
      payload: { observationId: string };
      result: Record<string, unknown> | null;
      error_message: string | null;
      claim_owner_id: string | null;
      claim_token: string | null;
      claimed_until: string | null;
      attempt_count: number;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    }
  >();
  if (options.terminalWorkUnits) {
    for (const observationId of observationIds) {
      workUnits.set(observationId, {
        unit_id: observationId,
        unit_kind: job.job_kind,
        state: "completed",
        payload: { observationId },
        result: {
          observationId,
          status: "rejected",
          reason: null,
        },
        error_message: null,
        claim_owner_id: null,
        claim_token: null,
        claimed_until: null,
        attempt_count: 1,
        created_at: "2026-05-20T00:00:00.000Z",
        updated_at: "2026-05-20T00:00:00.000Z",
        completed_at: "2026-05-20T00:00:00.000Z",
      });
    }
  } else {
    for (const observationId of observationIds) {
      workUnits.set(observationId, {
        unit_id: observationId,
        unit_kind: job.job_kind,
        state: "queued",
        payload: { observationId },
        result: null,
        error_message: null,
        claim_owner_id: null,
        claim_token: null,
        claimed_until: null,
        attempt_count: 0,
        created_at: "2026-05-20T00:00:00.000Z",
        updated_at: "2026-05-20T00:00:00.000Z",
        completed_at: null,
      });
    }
  }

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("INSERT INTO catalog_source_observation_bulk_review_work_units")) {
          const units = JSON.parse(String(values[1])) as Array<{
            unit_id: string;
            unit_kind: string;
            payload: { observationId: string };
          }>;
          let inserted = 0;
          for (const unit of units) {
            if (workUnits.has(unit.unit_id)) {
              continue;
            }
            inserted += 1;
            workUnits.set(unit.unit_id, {
              unit_id: unit.unit_id,
              unit_kind: unit.unit_kind,
              state: "queued",
              payload: unit.payload,
              result: null,
              error_message: null,
              claim_owner_id: null,
              claim_token: null,
              claimed_until: null,
              attempt_count: 0,
              created_at: "2026-05-20T00:00:00.000Z",
              updated_at: "2026-05-20T00:00:00.000Z",
              completed_at: null,
            });
          }
          return { rowCount: inserted, rows: [] as T[] };
        }

        if (sql.includes("WITH workflow_budget")) {
          const unit = [...workUnits.values()].find(
            (candidate) => candidate.state === "queued" || candidate.claimed_until === "expired",
          );
          if (!unit) {
            return { rowCount: 0, rows: [] as T[] };
          }
          unit.state = "running";
          unit.claim_owner_id = String(values[0]);
          unit.claim_token = String(values[1]);
          unit.claimed_until = "2026-05-20T00:02:00.000Z";
          unit.attempt_count += 1;
          job.status = "running";
          job.started_at ??= "2026-05-20T00:00:00.000Z";
          return { rowCount: 1, rows: [{ ...prefixedBulkJobRow(job), ...prefixedBulkWorkUnitRow(unit) }] as T[] };
        }

        if (
          sql.includes("SELECT job_id") &&
          sql.includes("FROM catalog_source_observation_bulk_review_jobs") &&
          sql.includes("FOR UPDATE")
        ) {
          return ["queued", "running"].includes(job.status)
            ? { rowCount: 1, rows: [{ job_id: job.job_id }] as T[] }
            : { rowCount: 0, rows: [] as T[] };
        }

        if (sql.includes("state NOT IN ('completed', 'failed', 'skipped')")) {
          return {
            rowCount: 1,
            rows: [
              {
                count: [...workUnits.values()].filter(
                  (unit) => unit.state !== "completed" && unit.state !== "failed" && unit.state !== "skipped",
                ).length,
              },
            ] as T[],
          };
        }

        if (sql.includes("WITH terminal_unit")) {
          const unit = workUnits.get(String(values[1]));
          if (!unit || unit.claim_owner_id !== String(values[2]) || unit.claim_token !== String(values[3])) {
            return { rowCount: 0, rows: [] as T[] };
          }
          unit.state = values[4] as typeof unit.state;
          unit.result = values[5] == null ? null : JSON.parse(String(values[5]));
          unit.error_message = values[6] == null ? null : String(values[6]);
          unit.claim_owner_id = null;
          unit.claim_token = null;
          unit.claimed_until = null;
          unit.completed_at = "2026-05-20T00:00:00.000Z";
          return { rowCount: 1, rows: [{ job_id: job.job_id }] as T[] };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_bulk_review_jobs AS job") &&
          sql.includes("CASE WHEN $4::boolean")
        ) {
          job.status = values[3] === true ? "completed" : "running";
          job.progress = JSON.parse(String(values[1]));
          job.result = values[2] == null ? job.result : JSON.parse(String(values[2]));
          job.completed_at = values[3] === true ? "2026-05-20T00:00:00.000Z" : job.completed_at;
          return { rowCount: 1, rows: [prefixedBulkJobRow(job)] as T[] };
        }

        if (
          sql.includes("FROM catalog_source_observation_bulk_review_work_units") &&
          sql.includes("count(*)::integer AS total")
        ) {
          const units = values[0]
            ? [...workUnits.values()].filter((unit) => unit.unit_id || job.job_id === values[0])
            : [...workUnits.values()];
          return { rowCount: 1, rows: [bulkWorkUnitSummaryRow(units)] as T[] };
        }

        if (
          sql.includes("FROM catalog_source_observation_bulk_review_work_units") &&
          sql.includes("ORDER BY created_at ASC, unit_id ASC")
        ) {
          return { rowCount: workUnits.size, rows: [...workUnits.values()] as T[] };
        }

        if (sql.includes("UPDATE catalog_source_observation_bulk_review_jobs AS job")) {
          if (job.status !== "queued") {
            return { rowCount: 0, rows: [] as T[] };
          }
          job.status = "running";
          job.claim_owner_id = String(values[0]);
          job.claimed_until = "2026-05-20T00:02:00.000Z";
          job.started_at ??= "2026-05-20T00:00:00.000Z";
          return { rowCount: 1, rows: [job] as T[] };
        }

        if (
          sql.includes("UPDATE catalog_source_observation_bulk_review_jobs") &&
          sql.includes("SET claimed_until") &&
          !sql.includes("RETURNING")
        ) {
          if (String(values[1]) !== job.claim_owner_id) {
            return { rowCount: 0, rows: [] as T[] };
          }
          job.claimed_until = "2026-05-20T00:02:00.000Z";
          return { rowCount: 1, rows: [] as T[] };
        }

        if (sql.includes("UPDATE catalog_source_observation_bulk_review_jobs")) {
          if (String(values[1]) !== job.claim_owner_id) {
            return { rowCount: 0, rows: [] as T[] };
          }
          if (sql.includes("status = 'queued'")) {
            job.status = "queued";
            job.progress = JSON.parse(String(values[2]));
            job.result = values[3] === null || values[3] === undefined ? job.result : JSON.parse(String(values[3]));
            job.claim_owner_id = null;
            job.claimed_until = null;
          } else if (sql.includes("status = 'completed'")) {
            job.status = "completed";
            job.progress = JSON.parse(String(values[2]));
            job.result = JSON.parse(String(values[3]));
            job.claim_owner_id = null;
            job.claimed_until = null;
            job.completed_at = "2026-05-20T00:00:00.000Z";
          } else if (sql.includes("status = 'failed'")) {
            job.status = "failed";
            job.progress = JSON.parse(String(values[2]));
            job.error_message = String(values[3]);
            job.claim_owner_id = null;
            job.claimed_until = null;
            job.completed_at = "2026-05-20T00:00:00.000Z";
          } else {
            job.progress = JSON.parse(String(values[2]));
            if (values[3] !== null && values[3] !== undefined) {
              job.result = JSON.parse(String(values[3]));
            }
            job.claimed_until = "2026-05-20T00:02:00.000Z";
          }
          return { rowCount: 1, rows: [job] as T[] };
        }

        if (sql.includes("INSERT INTO catalog_source_observation_bulk_review_job_events")) {
          return { rowCount: 1, rows: [{ sequence: 1 }] as T[] };
        }

        if (sql.includes("SELECT pg_notify")) {
          return { rowCount: 1, rows: [] as T[] };
        }

        if (sql.includes("FROM catalog_source_observation_bulk_review_jobs")) {
          return { rowCount: 1, rows: [job] as T[] };
        }

        if (sql.includes("FROM catalog_source_observations")) {
          const row = observations.get(String(values[0]));
          return { rowCount: row ? 1 : 0, rows: (row ? [row] : []) as T[] };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
    eventStore: {
      readStream: async (input: { streamId: string }) => {
        const observationId = input.streamId.replace("catalog.source-observation-", "");
        const row = observations.get(observationId);
        if (!row) {
          return [];
        }
        return [
          storedEvent(1, input.streamId, "catalog.source-observation.recorded", {
            observationId: row.observation_id,
            providerKey: row.provider_key,
            externalKey: row.external_key,
            sourceUrl: row.source_url,
            languageCode: row.language_code,
            sourceRecordHash: row.source_record_hash,
            sourceUpdatedAt: row.source_updated_at,
            observedAt: row.observed_at,
            sourceProfileKey: row.source_profile_key,
            sourceProfileVersion: row.source_profile_version,
            sourceMappingFingerprint: row.source_mapping_fingerprint,
            normalized: row.normalized,
            sourcePayload: row.source_payload,
          }),
        ];
      },
      appendToStream: async (input: {
        streamId: string;
        events: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
      }) => {
        const observationId = input.streamId.replace("catalog.source-observation-", "");
        const row = observations.get(observationId);
        if (row) {
          row.status = "rejected";
        }
        appendedEvents.push(...input.events);
        return input.events.map((event, index) =>
          storedEvent(2 + index, input.streamId, event.eventType, event.payload),
        );
      },
      readAll: async () => [],
    },
    checkpointStore: {
      loadCheckpoint: async () => "0",
      saveCheckpoint: async () => undefined,
    },
  } as unknown as CatalogRuntimeDeps;

  return {
    deps,
    job,
    appendedEvents,
  };
}

function prefixedBulkJobRow(job: Record<string, unknown>) {
  return {
    job_job_id: job.job_id,
    job_job_kind: job.job_kind,
    job_status: job.status,
    job_payload: job.payload,
    job_progress: job.progress,
    job_result: job.result,
    job_error_message: job.error_message,
    job_event_context: job.event_context,
    job_claim_owner_id: job.claim_owner_id,
    job_claimed_until: job.claimed_until,
    job_created_at: job.created_at,
    job_started_at: job.started_at,
    job_completed_at: job.completed_at,
    job_updated_at: job.updated_at,
  };
}

function prefixedBulkWorkUnitRow(unit: Record<string, unknown>) {
  return {
    unit_job_id: "job_bulk_review",
    unit_unit_id: unit.unit_id,
    unit_unit_kind: unit.unit_kind,
    unit_state: unit.state,
    unit_payload: unit.payload,
    unit_result: unit.result,
    unit_error_message: unit.error_message,
    unit_claim_owner_id: unit.claim_owner_id,
    unit_claim_token: unit.claim_token,
    unit_claimed_until: unit.claimed_until,
    unit_attempt_count: unit.attempt_count,
    unit_created_at: unit.created_at,
    unit_updated_at: unit.updated_at,
    unit_completed_at: unit.completed_at,
  };
}

function bulkWorkUnitSummaryRow(units: readonly { state: string; claimed_until: string | null }[]) {
  return {
    total: units.length,
    queued: units.filter((unit) => unit.state === "queued").length,
    running: units.filter((unit) => unit.state === "running").length,
    completed: units.filter((unit) => unit.state === "completed").length,
    failed: units.filter((unit) => unit.state === "failed").length,
    skipped: units.filter((unit) => unit.state === "skipped").length,
    active_claims: units.filter((unit) => unit.state === "running" && unit.claimed_until).length,
    expired_claims: 0,
  };
}

function storedEvent(streamVersion: number, streamId: string, eventType: string, payload: Record<string, unknown>) {
  return {
    eventId: `evt_${streamVersion}`,
    streamId,
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: context.tenantId,
    eventType,
    payload,
    metadata: {},
    occurredAt: "2026-05-20T00:00:00.000Z",
    recordedAt: "2026-05-20T00:00:00.000Z",
    performedByUserId: context.audit.performedByUserId,
    forAccountId: context.audit.forAccountId,
  };
}
