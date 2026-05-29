import { describe, expect, it } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonValue } from "@chase-sets/primitives/json";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import type { ReferenceRecordCommand, ReferenceTypeCommand } from "../../reference-data/domain/domain";
import type { SourceObservationNormalized } from "../domain/domain";
import { createSourceObservationRuntime, ensurePokemonReferenceHierarchy } from "./runtime";

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

describe("source observation runtime", () => {
  it("preloads and reuses TCGdex reference records by provider attributes", async () => {
    const harness = createReferencePreloadHarness();

    const firstExpansionReferenceId = await ensurePokemonReferenceHierarchy({
      deps: harness.deps,
      referenceData: harness.referenceData,
      normalized: pokemonObservation({
        expansionName: "Ascended Heroes",
        seriesName: "Mega Evolution",
      }),
      context,
    });
    const translatedExpansionReferenceId = await ensurePokemonReferenceHierarchy({
      deps: harness.deps,
      referenceData: harness.referenceData,
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

    await expect(
      services.promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).rejects.toThrow("Catalog asset storage is required to promote TCGDex image assets.");
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

  it("reapplies promoted observations by refreshing the linked Catalog Item without creating a replacement", async () => {
    const harness = createChangedObservationRefreshHarness({ status: "promoted" });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
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
    expect(harness.appendedSourceEvents).toEqual([]);
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

  it("processes persisted bulk review jobs in bounded resumable worker turns", async () => {
    const harness = createBulkReviewJobHarness(30);
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    await expect(
      services.processNextBulkReviewJob({
        claimOwnerId: "worker-1",
        claimTtlMs: 120_000,
      }),
    ).resolves.toBe(1);

    expect(harness.job.status).toBe("queued");
    expect(harness.job.progress).toMatchObject({
      phase: "processing",
      completed: 25,
      total: 30,
    });
    expect(harness.job.result?.outcomes).toHaveLength(25);
    expect(harness.appendedEvents).toHaveLength(25);

    await expect(
      services.processNextBulkReviewJob({
        claimOwnerId: "worker-2",
        claimTtlMs: 120_000,
      }),
    ).resolves.toBe(1);

    expect(harness.job.status).toBe("completed");
    expect(harness.job.progress).toMatchObject({
      phase: "completed",
      completed: 30,
      total: 30,
    });
    expect(harness.job.result).toMatchObject({
      requested: 30,
      rejected: 30,
      skipped: 0,
      failed: 0,
    });
    expect(harness.job.result?.outcomes).toHaveLength(30);
    expect(harness.appendedEvents).toHaveLength(30);
  });

  it("reuses an active provider integration job with the same actor action and scope", async () => {
    const harness = createIntegrationJobDedupeHarness({
      existingJob: integrationJobRow({
        jobId: "job_existing",
        action: "import",
        scope: { provider: "tcgdex", language: "en" },
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

  it("does not reuse active provider integration jobs from a different account context", async () => {
    const harness = createIntegrationJobDedupeHarness({
      existingJob: integrationJobRow({
        jobId: "job_other_account",
        action: "import",
        scope: { provider: "tcgdex", language: "en" },
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
}): SourceObservationNormalized {
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

function createIntegrationJobDedupeHarness(input: { existingJob?: Record<string, unknown> } = {}) {
  const insertedJobs: Record<string, unknown>[] = [];
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
            rowCount: input.existingJob ? 1 : 0,
            rows: (input.existingJob ? [input.existingJob] : []) as T[],
          };
        }

        if (sql.includes("INSERT INTO catalog_source_observation_integration_durable_jobs")) {
          const payload = JSON.parse(String(values[2])) as Record<string, unknown>;
          const row = integrationJobRow({
            jobId: String(values[0]),
            action: String(values[1]),
            scope: payload.scope as Record<string, unknown>,
            eventContext: JSON.parse(String(values[4])) as EventStoreContext,
            progress: JSON.parse(String(values[3])) as Record<string, unknown>,
          });
          insertedJobs.push(row);
          return { rowCount: 1, rows: [row] as T[] };
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
          sql.includes("FROM catalog_source_observation_integration_durable_jobs") &&
          sql.includes("WHERE job_id = $1")
        ) {
          const row = insertedJobs.find((job) => job.job_id === values[0]);
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
  eventContext: EventStoreContext;
  progress?: Record<string, unknown>;
}) {
  return {
    job_id: input.jobId,
    job_kind: input.action,
    payload: {
      action: input.action,
      scope: input.scope,
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

function createIntegrationJobClaimHandoffHarness() {
  const appendedSourceEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  let renewAttempts = 0;
  const job = {
    job_id: "job_import_base1",
    job_kind: "import",
    payload: {
      action: "import",
      scope: {
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
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
          return { rowCount: 0, rows: [] as T[] };
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
    normalized?: SourceObservationNormalized;
    expansionAttributes?: Readonly<Record<string, JsonValue>>;
    status?: string;
    promotedCatalogItemId?: string | null;
    reusableCatalogItemId?: string | null;
    partialCatalogItemId?: string | null;
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
    provider_key: "tcgdex",
    external_key: "me02.5-136:reverse-holo",
    source_url: "https://api.tcgdex.net/v2/en/cards/me02.5-136",
    language_code: "en",
    source_record_hash: "new-hash",
    source_updated_at: "2026-05-20T00:00:00.000Z",
    observed_at: "2026-05-20T00:00:00.000Z",
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
      normalized,
      sourcePayload: observationRow.source_payload,
    }),
    ...(observationStatus === "observed"
      ? []
      : [
          storedEvent(2, streamId, "catalog.source-observation.promoted", {
            catalogItemId: observationRow.promoted_catalog_item_id ?? "cat_existing",
            promotedAt: "2026-05-19T00:00:00.000Z",
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

        if (sql.includes("FROM catalog_items AS item")) {
          const row = input.partialCatalogItemId ? { catalog_item_id: input.partialCatalogItemId } : null;
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
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

function createBulkReviewJobHarness(count: number) {
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
  const appendedEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
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
