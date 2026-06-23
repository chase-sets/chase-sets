import { describe, expect, it, vi } from "vitest";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import { createSourceObservationRuntime } from "./runtime";
import {
  context,
  createActiveTcgplayerProfileVersions,
  createIntegrationJobClaimHandoffHarness,
  createIntegrationJobDedupeHarness,
  createMutableProfileVersionReader,
  createTcgplayerImportHarness,
  currentTcgdexProfileVersion,
  integrationJobRow,
  tcgdexProfileSnapshot,
  tcgdexProfileVersion,
} from "./runtime-test-harness";

describe("source observation runtime: provider integration jobs", () => {
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

  it("rejects production import jobs for explicitly selected inactive provider profile versions before enqueue", async () => {
    const harness = createIntegrationJobDedupeHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    await expect(
      services.enqueueIntegrationJob({
        action: "import",
        scope: {
          provider: "tcgplayer",
          profileKey: "pokemon-tcg-automation-client",
          ingestionUnitKey: "tcgplayer:pokemon:single-card:source-observation-import",
          productLineId: "3",
          setName: "Prismatic Evolutions",
        },
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
      ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
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
        ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
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
          ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
        }),
      }),
      expect.objectContaining({
        observationId: "obs_promoted_2",
        reapplyProfileMode: "current-active-profile",
        profileSnapshot: expect.objectContaining({
          providerKey: "tcgdex",
          profileVersion: "2026.06.03",
          ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
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
        providerKey: "mtgjson",
        value: "mtgjson",
        label: "MTGJSON",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "mtgjson-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "scrydex",
        value: "scrydex",
        label: "Scrydex One Piece Cards",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "scrydex-one-piece-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "scrydex",
        value: "scrydex",
        label: "Scrydex One Piece Set Reference",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "scrydex-one-piece-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "scrydex",
        value: "scrydex",
        label: "Scrydex One Piece Sealed Products",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "scrydex-one-piece-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "scryfall",
        value: "scryfall",
        label: "Scryfall",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "scryfall-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "tcgdex",
        value: "tcgdex",
        label: "TCGdex",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "tcgdex-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "tcgplayer",
        value: "tcgplayer",
        label: "TCGplayer One Piece Single Cards",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "tcgplayer-automation-client",
        }),
      }),
      expect.objectContaining({
        providerKey: "tcgplayer",
        value: "tcgplayer",
        label: "TCGplayer Yu-Gi-Oh Single Cards",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "tcgplayer-automation-client",
        }),
      }),
      expect.objectContaining({
        providerKey: "tcgplayer",
        value: "tcgplayer",
        label: "TCGplayer Magic Single Cards",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "tcgplayer-automation-client",
        }),
      }),
      expect.objectContaining({
        providerKey: "tcgplayer",
        value: "tcgplayer",
        label: "TCGplayer Magic Sealed Products",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "tcgplayer-automation-client",
        }),
      }),
      expect.objectContaining({
        providerKey: "ygojson",
        value: "ygojson",
        label: "YGOJSON",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "ygojson-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "ygojson",
        value: "ygojson",
        label: "YGOJSON Sealed Products",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "ygojson-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "ygoprodeck",
        value: "ygoprodeck",
        label: "YGOPRODeck",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "ygoprodeck-json",
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
    ).rejects.toThrow("Unsupported Catalog integration query 'languages' for provider 'tcgplayer'.");
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

  it("lists TCGplayer One Piece product-line and set-name options through the selected production profile unit", async () => {
    const harness = createTcgplayerImportHarness({ productDomain: "one-piece" });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      createActiveTcgplayerProfileVersions({ profileKey: "one-piece-single-card-product-sku" }),
    );

    const productLines = await services.listIntegrationOptions({
      providerKey: "tcgplayer",
      profileKey: "one-piece-single-card-product-sku",
      ingestionUnitKey: "tcgplayer:one-piece:single-card:source-observation-import",
      queryKind: "product-lines",
    });
    const setNames = await services.listIntegrationOptions({
      providerKey: "tcgplayer",
      profileKey: "one-piece-single-card-product-sku",
      ingestionUnitKey: "tcgplayer:one-piece:single-card:source-observation-import",
      queryKind: "set-names",
      parentValue: "68",
    });

    expect(productLines).toEqual([
      expect.objectContaining({
        providerKey: "tcgplayer",
        queryKind: "product-lines",
        value: "68",
        label: "One Piece Card Game",
        metadata: expect.objectContaining({
          productLineId: 68,
          productLineUrlName: "one-piece-card-game",
        }),
      }),
    ]);
    expect(setNames).toEqual([
      expect.objectContaining({
        providerKey: "tcgplayer",
        queryKind: "set-names",
        value: "Romance Dawn",
        label: "Romance Dawn",
        parentValue: "68",
        metadata: expect.objectContaining({
          productLineId: 68,
          setNameId: 12001,
          cleanSetName: "Romance Dawn",
        }),
      }),
    ]);
  });

  it("lists MTGJSON set and card options through the public JSON adapter", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mtgjsonFetch() as typeof globalThis.fetch;
    const services = createSourceObservationRuntime(
      { db: {} } as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    try {
      const sets = await services.listIntegrationOptions({
        providerKey: "mtgjson",
        queryKind: "sets",
      });
      const cards = await services.listIntegrationOptions({
        providerKey: "mtgjson",
        queryKind: "cards",
        parentValue: "TSP",
      });

      expect(sets).toEqual([
        expect.objectContaining({
          providerKey: "mtgjson",
          queryKind: "sets",
          value: "TSP",
          label: "Time Spiral",
          metadata: expect.objectContaining({ totalSetSize: 301, mtgjsonVersion: "5.3.0+20260605" }),
        }),
      ]);
      expect(cards).toEqual([
        expect.objectContaining({
          providerKey: "mtgjson",
          queryKind: "cards",
          value: "13fd9d47-9aa7-5f7c-8f47-fury-sliver",
          label: "Fury Sliver #157",
          parentValue: "TSP",
          metadata: expect.objectContaining({
            collectorNumber: "157",
            scryfallId: "0000579f-7b35-4ed3-b44c-db2a538066fe",
          }),
        }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  it("imports TCGplayer Magic single-card set scopes through the selected production profile unit", async () => {
    const harness = createTcgplayerImportHarness({ productDomain: "mtg" });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      createActiveTcgplayerProfileVersions({ profileKey: "mtg-single-card-product-sku" }),
    );

    const result = await services.importTcgplayerScope({
      scope: {
        provider: "tcgplayer",
        profileKey: "mtg-single-card-product-sku",
        ingestionUnitKey: "tcgplayer:mtg:single-card:source-observation-import",
        productLineId: "1",
        setName: "Time Spiral",
      },
      context,
    });

    expect(result).toMatchObject({
      requested: 1,
      imported: 1,
      observed: 1,
      failed: 0,
      outcomes: [
        expect.objectContaining({
          providerKey: "tcgplayer",
          expansionId: "set:1:Time Spiral",
          status: "imported",
          observed: 1,
        }),
      ],
    });
    expect(harness.appendedSourceEvents).toHaveLength(1);
    expect(harness.appendedSourceEvents[0]).toMatchObject({
      eventType: "catalog.source-observation.recorded",
      payload: expect.objectContaining({
        observationId: "tcgplayer_en_product_14240",
        providerKey: "tcgplayer",
        externalKey: "product:14240",
        sourceProfileKey: "mtg-single-card-product-sku",
        sourceProfileVersion: "2026.06.19",
        normalized: expect.objectContaining({
          kind: "provider-product",
          tcg: "magic",
          providerProductName: "Fury Sliver",
          productLineName: "Magic",
          productCategoryName: "Cards",
          productForm: "single",
          mergeIdentity: expect.objectContaining({
            tcg: "magic",
            productLineName: "Magic",
            setName: "Time Spiral",
            collectorNumber: "157",
            productForm: "single",
          }),
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
          skuReferences: [
            expect.objectContaining({
              providerKey: "tcgplayer",
              externalKey: "sku:50014240",
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

  it("imports TCGplayer One Piece single-card set scopes through the selected production profile unit", async () => {
    const harness = createTcgplayerImportHarness({ productDomain: "one-piece" });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      createActiveTcgplayerProfileVersions({ profileKey: "one-piece-single-card-product-sku" }),
    );

    const result = await services.importTcgplayerScope({
      scope: {
        provider: "tcgplayer",
        profileKey: "one-piece-single-card-product-sku",
        ingestionUnitKey: "tcgplayer:one-piece:single-card:source-observation-import",
        productLineId: "68",
        setName: "Romance Dawn",
      },
      context,
    });

    expect(result).toMatchObject({
      requested: 1,
      imported: 1,
      observed: 1,
      failed: 0,
      outcomes: [
        expect.objectContaining({
          providerKey: "tcgplayer",
          expansionId: "set:68:Romance Dawn",
          status: "imported",
          observed: 1,
        }),
      ],
    });
    expect(harness.appendedSourceEvents).toHaveLength(1);
    expect(harness.appendedSourceEvents[0]).toMatchObject({
      eventType: "catalog.source-observation.recorded",
      payload: expect.objectContaining({
        observationId: "tcgplayer_en_product_987650",
        providerKey: "tcgplayer",
        externalKey: "product:987650",
        sourceProfileKey: "one-piece-single-card-product-sku",
        sourceProfileVersion: "2026.06.22",
        normalized: expect.objectContaining({
          kind: "provider-product",
          tcg: "one-piece",
          name: "Monkey.D.Luffy",
          providerProductName: "Monkey.D.Luffy",
          productLineName: "One Piece Card Game",
          productCategoryName: "Cards",
          productForm: "single",
          mergeIdentity: expect.objectContaining({
            tcg: "one piece card game",
            productLineName: "One Piece Card Game",
            setName: "Romance Dawn",
            collectorNumber: "OP01-001",
            productForm: "single",
          }),
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:987650" }],
          skuReferences: [
            expect.objectContaining({
              providerKey: "tcgplayer",
              externalKey: "sku:900987650",
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

  it("imports TCGplayer Magic sealed-product set scopes through the selected production profile unit", async () => {
    const harness = createTcgplayerImportHarness({ productDomain: "mtg" });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      createActiveTcgplayerProfileVersions({ profileKey: "mtg-sealed-product-sku" }),
    );

    const result = await services.importTcgplayerScope({
      scope: {
        provider: "tcgplayer",
        profileKey: "mtg-sealed-product-sku",
        ingestionUnitKey: "tcgplayer:mtg:sealed-product:source-observation-import",
        productLineId: "1",
        setName: "Time Spiral",
      },
      context,
    });

    expect(result).toMatchObject({
      requested: 1,
      imported: 1,
      observed: 1,
      failed: 0,
      outcomes: [
        expect.objectContaining({
          providerKey: "tcgplayer",
          expansionId: "set:1:Time Spiral",
          status: "imported",
          observed: 1,
        }),
      ],
    });
    expect(harness.appendedSourceEvents).toHaveLength(1);
    expect(harness.appendedSourceEvents[0]).toMatchObject({
      eventType: "catalog.source-observation.recorded",
      payload: expect.objectContaining({
        observationId: "tcgplayer_en_product_96601",
        providerKey: "tcgplayer",
        externalKey: "product:96601",
        sourceProfileKey: "mtg-sealed-product-sku",
        sourceProfileVersion: "2026.06.19",
        normalized: expect.objectContaining({
          kind: "magic-sealed-product",
          tcg: "magic",
          name: "Time Spiral Booster Pack",
          setCode: "TSP",
          setName: "Time Spiral",
          sealedProductForm: "booster-pack",
          packCount: 1,
          productLineName: "Magic: The Gathering",
          barcode: "0653569123456",
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:96601" }],
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

  it.each([
    {
      profileKey: "mtg-card-reference-data",
      ingestionUnitKey: "mtgjson:mtg:single-card:reference-data",
      observationId: "mtgjson_card_en_13fd9d47-9aa7-5f7c-8f47-fury-sliver",
      externalKey: "card:13fd9d47-9aa7-5f7c-8f47-fury-sliver",
      normalizedKind: "magic-card-print",
    },
    {
      profileKey: "mtg-set-reference-data",
      ingestionUnitKey: "mtgjson:mtg:set:reference-data",
      observationId: "mtgjson_set_en_TSP",
      externalKey: "set:TSP",
      normalizedKind: "magic-set-reference",
    },
  ])(
    "processes queued MTGJSON $profileKey imports through the durable integration worker",
    async ({ profileKey, ingestionUnitKey, observationId, externalKey, normalizedKind }) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mtgjsonFetch() as typeof globalThis.fetch;
      const harness = createIntegrationJobClaimHandoffHarness({
        scope: { provider: "mtgjson", profileKey, ingestionUnitKey, setId: "TSP" },
        renewSucceeds: true,
      });
      const services = createSourceObservationRuntime(harness.deps, {} as CatalogItemServices, harness.referenceData);

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
      expect(harness.job.result).toMatchObject({
        requested: 1,
        imported: 1,
        observed: 1,
        failed: 0,
      });
      expect(harness.appendedSourceEvents).toHaveLength(1);
      expect(harness.appendedSourceEvents[0]?.payload).toMatchObject({
        observationId,
        providerKey: "mtgjson",
        externalKey,
        sourceProfileKey: profileKey,
        sourceProfileVersion: "2026.06.19",
        normalized: expect.objectContaining({
          kind: normalizedKind,
          setCode: "TSP",
          setName: "Time Spiral",
        }),
      });
    },
  );

  it("lists Scrydex One Piece set options through the shared provider option interface", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.SCRYDEX_API_KEY;
    const originalTeamId = process.env.SCRYDEX_TEAM_ID;
    process.env.SCRYDEX_API_KEY = "test-key";
    process.env.SCRYDEX_TEAM_ID = "main";
    globalThis.fetch = scrydexOnePieceFetch() as typeof globalThis.fetch;
    const harness = createIntegrationJobDedupeHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    try {
      const options = await services.listIntegrationOptions({
        providerKey: "scrydex",
        profileKey: "one-piece-card-print-source-observation",
        ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
        queryKind: "sets",
        languageCode: "en",
      });

      expect(options).toEqual([
        expect.objectContaining({
          providerKey: "scrydex",
          queryKind: "sets",
          value: "op-01",
          label: "Romance Dawn",
          metadata: expect.objectContaining({
            expansionId: "op-01",
            code: "OP-01",
            total: 121,
          }),
        }),
      ]);
    } finally {
      restoreEnvValue("SCRYDEX_API_KEY", originalApiKey);
      restoreEnvValue("SCRYDEX_TEAM_ID", originalTeamId);
      globalThis.fetch = originalFetch;
    }
  });

  it("previews Scrydex One Piece set imports without fetching provider payloads", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.SCRYDEX_API_KEY;
    const originalTeamId = process.env.SCRYDEX_TEAM_ID;
    process.env.SCRYDEX_API_KEY = "test-key";
    process.env.SCRYDEX_TEAM_ID = "main";
    const fetch = vi.fn(scrydexOnePieceFetch());
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const harness = createIntegrationJobClaimHandoffHarness();
    const services = createSourceObservationRuntime(harness.deps, {} as CatalogItemServices, harness.referenceData);

    try {
      const preview = await services.previewIntegrationImport({
        scope: {
          provider: "scrydex",
          profileKey: "one-piece-card-print-source-observation",
          ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
          language: "en",
          setId: "op-01",
        },
        context,
      });

      expect(preview).toMatchObject({
        action: "import",
        providerKey: "scrydex",
        targetCount: 1,
        targets: [
          expect.objectContaining({
            targetId: "set:op-01",
            name: "op-01",
            languageCode: "en",
            scopeKey: "expansion-cards",
            planKey: "scrydex:one-piece:expansion:op-01:cards",
            estimatedPayloads: null,
            transportSteps: [
              "Fetch Scrydex One Piece expansion cards with max page size",
              "Sanitize card payloads",
              "Attach payload provenance",
            ],
            usageEstimate: expect.objectContaining({
              requestStrategy: "bulk-first",
              estimateState: "estimate-unavailable",
              estimatedRequestCount: null,
              usageCheckState: "not-configured",
              perRecordFallbackReason: null,
              selectedFields: expect.arrayContaining(["id", "name", "number", "expansion"]),
              pageSize: 250,
            }),
          }),
        ],
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(harness.appendedSourceEvents).toEqual([]);
    } finally {
      restoreEnvValue("SCRYDEX_API_KEY", originalApiKey);
      restoreEnvValue("SCRYDEX_TEAM_ID", originalTeamId);
      globalThis.fetch = originalFetch;
    }
  });

  it("processes queued Scrydex One Piece set imports through the durable integration worker", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.SCRYDEX_API_KEY;
    const originalTeamId = process.env.SCRYDEX_TEAM_ID;
    process.env.SCRYDEX_API_KEY = "test-key";
    process.env.SCRYDEX_TEAM_ID = "main";
    globalThis.fetch = scrydexOnePieceFetch() as typeof globalThis.fetch;
    const harness = createIntegrationJobClaimHandoffHarness({
      scope: {
        provider: "scrydex",
        profileKey: "one-piece-card-print-source-observation",
        ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
        language: "en",
        setId: "op-01",
      },
      renewSucceeds: true,
    });
    const services = createSourceObservationRuntime(harness.deps, {} as CatalogItemServices, harness.referenceData);

    try {
      await expect(
        services.processNextIntegrationJob({
          claimOwnerId: "worker-1",
          claimTtlMs: 120_000,
        }),
      ).resolves.toBe(1);
    } finally {
      restoreEnvValue("SCRYDEX_API_KEY", originalApiKey);
      restoreEnvValue("SCRYDEX_TEAM_ID", originalTeamId);
      globalThis.fetch = originalFetch;
    }

    expect(harness.job.status).toBe("completed");
    expect(harness.job.result).toMatchObject({
      requested: 1,
      imported: 1,
      observed: 1,
      failed: 0,
      outcomes: [
        expect.objectContaining({
          providerKey: "scrydex",
          expansionId: "set:op-01",
          providerUsageEvidence: expect.objectContaining({
            unitKey: "scrydex:one-piece:single-card:source-observation-import",
            requestStrategy: "bulk-first",
            estimateState: "estimate-unavailable",
            estimatedRequestCount: null,
            estimateReason: "Card page count is available only after the first Scrydex paged response.",
            actualRequestCount: 1,
            pageCount: 1,
            cacheHitCount: 0,
            cacheMissCount: 1,
            usageCheckState: "not-configured",
            bulkFirstConfirmed: true,
            perRecordFallbackReason: null,
            selectedFields: [
              "id",
              "name",
              "number",
              "printed_number",
              "rarity",
              "rarity_code",
              "type",
              "language",
              "language_code",
              "expansion",
            ],
            pageSize: 250,
          }),
        }),
      ],
    });
    expect(harness.appendedSourceEvents).toHaveLength(1);
    expect(harness.appendedSourceEvents[0]?.payload).toMatchObject({
      observationId: "scrydex_one_piece_card_en_op01-001",
      providerKey: "scrydex",
      externalKey: "card:op01-001",
      sourceProfileKey: "one-piece-card-print-source-observation",
      sourceProfileVersion: "2026.06.22",
      normalized: expect.objectContaining({
        kind: "one-piece-card-print",
        tcg: "one-piece",
        name: "Monkey.D.Luffy",
        cardNumber: "OP01-001",
        setId: "op-01",
        setName: "Romance Dawn",
      }),
    });
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
    expect(unitsByKey["mtgjson:mtg:single-card:reference-data"]).toMatchObject({
      semanticReadiness: "ready",
      credentialReadiness: "not-required",
      credentialReadinessState: "not-required",
      transportReadiness: "ready",
      dryRunStatus: "completed",
    });
    expect(unitsByKey["mtgjson:mtg:set:reference-data"]).toMatchObject({
      semanticReadiness: "ready",
      credentialReadiness: "not-required",
      credentialReadinessState: "not-required",
      transportReadiness: "ready",
      dryRunStatus: "completed",
    });
    expect(unitsByKey["scryfall:mtg:single-card:reference-data"]).toMatchObject({
      semanticReadiness: "ready",
      credentialReadiness: "not-required",
      credentialReadinessState: "not-required",
      transportReadiness: "ready",
      dryRunStatus: "completed",
    });
    expect(unitsByKey["scryfall:mtg:single-card:image-evidence"]).toMatchObject({
      semanticReadiness: "ready",
      credentialReadiness: "not-required",
      credentialReadinessState: "not-required",
      transportReadiness: "ready",
      dryRunStatus: "completed",
    });
    expect(unitsByKey["tcgplayer:mtg:single-card:source-observation-import"]).toMatchObject({
      semanticReadiness: "ready",
      fixtureValidationStatus: "ready",
      dryRunStatus: "completed",
      observationFacts: 1,
      credentialReadiness: "blocked",
      credentialReadinessState: "missing",
      credentialDiagnosticCode: "credential-missing",
      transportReadiness: "blocked",
    });
    expect(unitsByKey["tcgplayer:mtg:sealed-product:source-observation-import"]).toMatchObject({
      semanticReadiness: "ready",
      fixtureValidationStatus: "ready",
      dryRunStatus: "completed",
      observationFacts: 1,
      credentialReadiness: "blocked",
      credentialReadinessState: "missing",
      credentialDiagnosticCode: "credential-missing",
      transportReadiness: "blocked",
    });
    expect(unitsByKey["scrydex:one-piece:single-card:source-observation-import"]).toMatchObject({
      semanticReadiness: "ready",
      fixtureValidationStatus: "ready",
      dryRunStatus: "completed",
      observationFacts: 1,
      credentialReadiness: "blocked",
      credentialReadinessState: "missing",
      credentialDiagnosticCode: "credential-missing",
      transportReadiness: "blocked",
    });
    expect(unitsByKey["scrydex:one-piece:set:reference-data"]).toMatchObject({
      semanticReadiness: "ready",
      fixtureValidationStatus: "ready",
      dryRunStatus: "completed",
      observationFacts: 1,
      credentialReadiness: "blocked",
      credentialReadinessState: "missing",
      credentialDiagnosticCode: "credential-missing",
      transportReadiness: "blocked",
    });
    expect(unitsByKey["scrydex:one-piece:sealed-product:source-observation-import"]).toMatchObject({
      semanticReadiness: "ready",
      fixtureValidationStatus: "ready",
      dryRunStatus: "completed",
      observationFacts: 1,
      credentialReadiness: "blocked",
      credentialReadinessState: "missing",
      credentialDiagnosticCode: "credential-missing",
      transportReadiness: "blocked",
    });
  });
});

function mtgjsonFetch(): typeof globalThis.fetch {
  const responses: Record<string, unknown> = {
    "https://mtgjson.com/api/v5/SetList.json": {
      meta: { date: "2026-06-05", version: "5.3.0+20260605" },
      data: [
        {
          code: "TSP",
          name: "Time Spiral",
          releaseDate: "2006-10-06",
          totalSetSize: 301,
          type: "expansion",
        },
      ],
    },
    "https://mtgjson.com/api/v5/TSP.json": {
      meta: { date: "2026-06-05", version: "5.3.0+20260605" },
      data: {
        code: "TSP",
        name: "Time Spiral",
        releaseDate: "2006-10-06",
        totalSetSize: 301,
        type: "expansion",
        cards: [
          {
            uuid: "13fd9d47-9aa7-5f7c-8f47-fury-sliver",
            name: "Fury Sliver",
            number: "157",
            rarity: "uncommon",
            layout: "normal",
            identifiers: {
              scryfallId: "0000579f-7b35-4ed3-b44c-db2a538066fe",
              scryfallOracleId: "44623693-51d6-49ad-8cd7-140505caf02f",
            },
          },
        ],
      },
    },
  };

  return (async (input: RequestInfo | URL) => {
    const body = responses[String(input)];
    if (!body) {
      return new Response(null, { status: 404 });
    }

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function scrydexOnePieceFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/onepiece/v1/expansions/op-01/cards")) {
      return jsonResponse({
        data: [
          {
            id: "op01-001",
            name: "Monkey.D.Luffy",
            number: "001",
            printed_number: "OP01-001",
            rarity: "Leader",
            rarity_code: "L",
            type: "Leader",
            language_code: "en",
            expansion: {
              id: "op-01",
              name: "Romance Dawn",
              code: "OP-01",
              total: 121,
              release_date: "2022-12-02",
              language_code: "en",
            },
          },
        ],
        total_pages: 1,
      });
    }

    if (url.includes("/onepiece/v1/expansions")) {
      return jsonResponse({
        data: [
          {
            id: "op-01",
            name: "Romance Dawn",
            code: "OP-01",
            total: 121,
            release_date: "2022-12-02",
            language_code: "en",
          },
        ],
        total_pages: 1,
      });
    }

    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
