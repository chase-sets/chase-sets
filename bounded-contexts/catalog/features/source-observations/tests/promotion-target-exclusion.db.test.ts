import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase, drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { module as catalogModule } from "../../../index";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import { seedCatalogDatabase } from "../../../support/authoring-support/seed";
import { seedContext as context } from "../../../support/seed-support/context";
import type { CatalogItemId } from "../../../ids";
import fixture from "../api/__fixtures__/tcgdex/normal.json";
import { tcgdexPokemonCardSourceObservationMappingContract } from "../api/tcgdex-executable-mapping-contract";
import { normalizeCatalogProviderSourceObservation } from "../api/promotion/provider-source-observation-normalizer";
import {
  loadCatalogItemPromotionProfile,
  previewCatalogItemPromotionPlan,
  requireCatalogPromotionProfileVersion,
  requireCatalogItemPromotionObservation,
} from "../api/source-observation-promotion-execution";
import { resolvePromotionReferenceHierarchy } from "../api/source-observation-promotion-reference-hierarchy";
import { sourceObservationTargetId } from "../api/promotion/promotion-target-identity";
import {
  locatePromotionReferenceStreams,
  requirePromotionTargetIndexes,
} from "../api/promotion/promotion-target-indexes";
import {
  createPostgresPromotionTargetExclusion,
  type PromotionTargetAuthority,
} from "../api/promotion/promotion-target-exclusion";
import { promotionTargetBindingStream, type PromotionTargetKey } from "../api/promotion/promotion-target-identity";
import { trackPromotionProfileAuthority } from "../api/promotion/promotion-profile-authority";
import { createCatalogProviderIntegrationProfileVersionStore } from "../api/providers/provider-integration-profile-store";
import { foldPromotionTargetItem } from "../api/promotion/promotion-target-discovery";
import { promotionCurrentItem } from "../api/promotion/source-observation-target-exclusion";
import { decideSourceObservation, initialSourceObservationState, type SourceObservationEvent } from "../domain/domain";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for promotion target exclusion DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("promotion target exclusion through real Catalog services", () => {
  let pool: PgTransactionalPool;
  let services: CatalogServices;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "promotion_target_exclusion");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
    await seedCatalogDatabase(pool, undefined, { enabledDataProfiles: ["catalog-integration-bootstrap"] });
    services = createCatalogServices(pool);
  });
  afterAll(async () => closeMultiContextTestPools({ catalog: pool }));

  async function record(id: string, reference = "product:493958", overrides: Partial<typeof fixture> = {}) {
    const mapped = normalizeCatalogProviderSourceObservation({
      contract: tcgdexPokemonCardSourceObservationMappingContract,
      payload: {
        ...fixture,
        ...overrides,
        observationId: id,
        externalKey: id,
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: reference }],
      },
      observedAt: "2026-10-10T00:00:00.000Z",
    });
    expect(mapped.diagnostics).toEqual([]);
    if (!mapped.observation) throw new Error("Executable mapper did not produce an observation");
    await services.sourceObservations.commandHandler({
      streamId: `catalog.source-observation-${id}`,
      command: { type: "RecordSourceObservation", ...mapped.observation },
      context,
    });
    await drainLocalProjectionHandlerSets("catalog", pool, services.sourceObservations.projectors);
    return mapped.observation;
  }

  async function retainedPlan(id: string) {
    const observation = await record(id);
    const normalized = requireCatalogItemPromotionObservation(observation.normalized, observation.providerKey);
    const profile = await requireCatalogPromotionProfileVersion(
      services.providerIntegrationProfiles,
      observation.providerKey,
      normalized,
    );
    const deps = {
      db: pool,
      eventStore: createPostgresEventStore({ pool }),
      checkpointStore: createPostgresProjectionStore({ db: pool }),
    };
    await resolvePromotionReferenceHierarchy({
      deps,
      referenceData: services.referenceData,
      profile: profile.profile,
      normalized,
      context,
    });
    await drainLocalProjectionHandlerSets("catalog", pool, services.referenceData.projectors);
    const targetId = sourceObservationTargetId(id) as CatalogItemId;
    const planned = await previewCatalogItemPromotionPlan({
      deps,
      catalogItemId: targetId,
      mode: "create",
      normalized,
      providerKey: observation.providerKey,
      externalKey: observation.externalKey,
      providerProfile: profile.profile,
      providerProfileVersion: profile,
      catalogMapping: await loadCatalogItemPromotionProfile(deps, profile.profile),
      promoteAsDraft: false,
    });
    if (planned.status !== "planned") throw new Error(JSON.stringify(planned.diagnostics));
    return { targetId, plan: planned.plan, observation, normalized, profile, deps };
  }

  async function itemCreations() {
    return (
      await pool.query<{ stream_id: string }>(
        "SELECT stream_id FROM event_store_events WHERE event_type = 'catalog.catalog-item.created' ORDER BY stream_id",
      )
    ).rows;
  }

  function boundary() {
    return createPostgresPromotionTargetExclusion({ pool, eventStore: createPostgresEventStore({ pool }) });
  }

  function acquire(
    targetId: string,
    keys: readonly PromotionTargetKey[],
    validateAuthority: PromotionTargetAuthority = async () => undefined,
  ) {
    return boundary().acquire({
      keys,
      additionalTargetIds: [targetId],
      context,
      validateAuthority,
      selectTarget: async () => targetId,
    });
  }

  it("fences a restarted shared-port consumer and keeps disjoint reference levels independent", async () => {
    const key = { level: "item", providerKey: "synthetic", externalKey: "restart" } as const;
    const first = await acquire("cat_candidate_restart", [key]);
    const restarted = await acquire("cat_candidate_restart", [key]);
    const entry = { streamId: "catalog.item-cat_candidate_restart", expectedVersion: 0, events: [], context } as const;
    await expect(first.append(entry)).rejects.toThrow();
    await expect(restarted.append(entry)).resolves.toEqual([]);
    await expect(acquire("cat_candidate_fork", [key])).rejects.toThrow("promotion-target-bound-elsewhere");
    await expect(acquire("cat_candidate_product", [{ ...key, level: "product" }])).resolves.toMatchObject({
      targetId: "cat_candidate_product",
    });
  });

  it("guards negative and material evidence atomically, including a key added by closure", async () => {
    await record("closure-A");
    const key = { level: "item", providerKey: "tcgplayer", externalKey: "product:493958" } as const;
    const session = await acquire("cat_candidate_closure", [key]);
    expect(session.evidence.sources.has("closure-A")).toBe(true);
    const store = createPostgresEventStore({ pool });
    const member = { level: "member", observationId: "closure-A" } as const;
    const binding = promotionTargetBindingStream(member);
    const history = await readCompleteStream(store, { streamId: binding });
    const payload = history.at(-1)!.payload;
    await store.appendToStream({
      streamId: binding,
      expectedVersion: history.length,
      context,
      events: [
        {
          eventType: "catalog.promotion-target.bound",
          payload: {
            ...payload,
            generation: Number(payload.generation) + 1,
            operationId: "synthetic-competing-writer",
          },
        },
      ],
    });
    await expect(
      session.append({
        streamId: "catalog.item-cat_candidate_closure",
        expectedVersion: 0,
        context,
        events: [{ eventType: "catalog.catalog-item.created", payload: { itemId: "cat_candidate_closure" } }],
      }),
    ).rejects.toThrow();
    expect(await readCompleteStream(store, { streamId: "catalog.item-cat_candidate_closure" })).toEqual([]);
  });

  it("allows same-profile disjoint SHARE holders without a global promotion mutex", async () => {
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    const validate: PromotionTargetAuthority = async (client) => {
      await client.query(
        "SELECT profile_key FROM catalog_provider_integration_profile_versions ORDER BY profile_key LIMIT 1",
      );
      arrived += 1;
      if (arrived === 2) release();
      await both;
    };
    const results = await Promise.all(
      ["left", "right"].map((id) =>
        acquire(`cat_candidate_${id}`, [{ level: "item", providerKey: "synthetic", externalKey: id }], validate),
      ),
    );
    expect(results.map((result) => result.targetId)).toEqual(["cat_candidate_left", "cat_candidate_right"]);
  });

  it("acquires overlapping reversed key sets without forking or lock-order inversion", async () => {
    const keys = ["one", "two"].map((externalKey) => ({
      level: "item" as const,
      providerKey: "synthetic",
      externalKey,
    }));
    const results = await Promise.allSettled([
      acquire("cat_candidate_one", keys),
      acquire("cat_candidate_two", [...keys].reverse()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const store = createPostgresEventStore({ pool });
    const targets = await Promise.all(
      keys.map(
        async (key) =>
          (await readCompleteStream(store, { streamId: promotionTargetBindingStream(key) })).at(-1)!.payload.targetId,
      ),
    );
    expect(new Set(targets).size).toBe(1);
  });

  it("reads page 501 and the late deterministic owner without an item-reference shortcut", async () => {
    const retained = await retainedPlan("page-500");
    for (const command of retained.plan.commands.slice(0, 13))
      await services.items.commandHandler({ streamId: `catalog.item-${retained.targetId}`, command, context });
    const codec = createPassthroughDomainEventCodec<SourceObservationEvent>();
    const store = createPostgresEventStore({ pool });
    await store.appendToStreams!(
      Array.from({ length: 500 }, (_, index) => {
        const id = `page-${String(index).padStart(3, "0")}`;
        const mapped = normalizeCatalogProviderSourceObservation({
          contract: tcgdexPokemonCardSourceObservationMappingContract,
          payload: { ...fixture, observationId: id, externalKey: id },
          observedAt: "2026-10-10T00:00:00.000Z",
        });
        if (!mapped.observation) throw new Error("Executable page fixture did not map");
        return {
          streamId: `catalog.source-observation-${id}`,
          expectedVersion: 0,
          context,
          events: decideSourceObservation(initialSourceObservationState, {
            type: "RecordSourceObservation",
            ...mapped.observation,
          }).map(codec.encode),
        };
      }),
    );
    const key = { level: "item", providerKey: "tcgplayer", externalKey: "product:493958" } as const;
    expect(await locatePromotionReferenceStreams(pool, key)).toHaveLength(501);
    await expect(
      boundary().acquire({
        keys: [key],
        additionalTargetIds: [],
        context,
        validateAuthority: async () => undefined,
        selectTarget: async (evidence) => {
          expect(evidence.sources.size).toBe(501);
          expect(evidence.items.get(retained.targetId)?.id).toBe(retained.targetId);
          throw new Error("synthetic-late-prefix-located");
        },
      }),
    ).rejects.toThrow("synthetic-late-prefix-located");
    expect(await itemCreations()).toHaveLength(1);
  });

  it.each(["edit", "revoke", "selection"])(
    "reads canonical profile %s after obtaining the write barrier",
    async (mutation) => {
      const observation = await record(`profile-${mutation}`);
      const normalized = requireCatalogItemPromotionObservation(observation.normalized, observation.providerKey);
      const selected = await requireCatalogPromotionProfileVersion(
        services.providerIntegrationProfiles,
        observation.providerKey,
        normalized,
      );
      const authority = trackPromotionProfileAuthority(services.providerIntegrationProfiles, selected, (reader) =>
        requireCatalogPromotionProfileVersion(reader, observation.providerKey, normalized),
      );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("LOCK TABLE catalog_provider_integration_profile_versions IN ROW EXCLUSIVE MODE");
        const canonical = createCatalogProviderIntegrationProfileVersionStore(client);
        if (mutation === "edit")
          await canonical.upsertProfileVersion({
            ...selected,
            profile: {
              ...selected.profile,
              catalogFieldMapping: {
                ...selected.profile.catalogFieldMapping,
                blueprintKey: "synthetic-changed-blueprint",
              },
            },
          });
        else if (mutation === "selection")
          await canonical.upsertProfileVersion({ ...selected, profileVersion: "synthetic-new-active-version" });
        else await canonical.upsertProfileVersion({ ...selected, active: false, lifecycle: "deprecated" });
        const pending = acquire(
          `cat_candidate_${mutation}`,
          [{ level: "item", providerKey: "synthetic", externalKey: mutation }],
          authority.validate,
        );
        const refused = expect(pending).rejects.toThrow();
        await client.query("COMMIT");
        await refused;
        expect(
          await readCompleteStream(createPostgresEventStore({ pool }), {
            streamId: `catalog.item-cat_candidate_${mutation}`,
          }),
        ).toEqual([]);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    },
  );

  it.each(["A", "B"])(
    "independent runtimes preserve one target under frozen item projections, %s first",
    async (first) => {
      await record("A");
      await record("B");
      const other = createCatalogServices(pool);
      const winner = await services.sourceObservations.promoteObservation({ observationId: first, context });
      const reused = await other.sourceObservations.promoteObservation({
        observationId: first === "A" ? "B" : "A",
        context,
      });
      expect(reused.catalogItemId).toBe(winner.catalogItemId);
      expect(await itemCreations()).toHaveLength(1);
    },
  );

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])(
    "retained mapper-derived create boundary %s never creates a second target",
    async (boundary) => {
      const retained = await retainedPlan("retained-A");
      expect(retained.plan.commands).toHaveLength(14);
      expect(retained.plan.commands[13].type).toBe("LinkExternalCatalogItemReference");
      for (const command of retained.plan.commands.slice(0, boundary))
        await services.items.commandHandler({ streamId: `catalog.item-${retained.targetId}`, command, context });
      await record("incoming-B");
      const locator = await locatePromotionReferenceStreams(pool, {
        level: "item",
        providerKey: "tcgplayer",
        externalKey: "product:493958",
      });
      expect(locator).toContain("catalog.source-observation-retained-A");
      if (boundary === 13) expect(locator).not.toContain(`catalog.item-${retained.targetId}`);
      const attempt = services.sourceObservations.promoteObservation({ observationId: "incoming-B", context });
      if (boundary > 0 && boundary < retained.plan.commands.length) {
        await expect(attempt).rejects.toThrow("promotion-target-retained-prefix");
        await expect(
          services.sourceObservations.promoteObservation({ observationId: "retained-A", context }),
        ).resolves.toMatchObject({ catalogItemId: retained.targetId });
      } else {
        const result = await attempt;
        if (boundary > 0) expect(result.catalogItemId).toBe(retained.targetId);
        await expect(
          createCatalogServices(pool).sourceObservations.promoteObservation({ observationId: "retained-A", context }),
        ).resolves.toMatchObject({ catalogItemId: result.catalogItemId });
      }
      expect(await itemCreations()).toHaveLength(1);
    },
  );

  it.each([0, 1, 2, 3, 4, 5].flatMap((boundary) => ["live", "frozen"].map((projection) => ({ boundary, projection }))))(
    "unlocated refresh $boundary on X resumes against the $projection duplicate policy",
    async ({ boundary, projection }) => {
      const retained = await retainedPlan("refresh-A");
      const x = "cat_synthetic_field_match" as CatalogItemId;
      // Executable create plan without either late reference command: X is a
      // field match, not evidence of an A application or an R owner.
      for (const command of retained.plan.commands.slice(0, -2)) {
        await services.items.commandHandler({
          streamId: `catalog.item-${x}`,
          command: command.type === "CreateCatalogItem" ? { ...command, itemId: x } : command,
          context,
        });
      }
      await drainLocalProjectionHandlerSets("catalog", pool, services.items.projectors);
      const store = createPostgresEventStore({ pool });
      const state = foldPromotionTargetItem(x, await readCompleteStream(store, { streamId: `catalog.item-${x}` }));
      const refresh = await previewCatalogItemPromotionPlan({
        deps: retained.deps,
        catalogItemId: x,
        mode: "refresh",
        normalized: retained.normalized,
        providerKey: retained.observation.providerKey,
        externalKey: retained.observation.externalKey,
        providerProfile: retained.profile.profile,
        providerProfileVersion: retained.profile,
        catalogMapping: await loadCatalogItemPromotionProfile(retained.deps, retained.profile.profile),
        currentItem: promotionCurrentItem(state),
        promoteAsDraft: false,
      });
      if (refresh.status !== "planned") throw new Error(JSON.stringify(refresh.diagnostics));
      expect(refresh.plan.commands.slice(0, 5).some((command) => command.type.startsWith("LinkExternal"))).toBe(false);
      for (const command of refresh.plan.commands.slice(0, boundary))
        await services.items.commandHandler({ streamId: `catalog.item-${x}`, command, context });
      await record("refresh-B", "product:493958", {
        card: { ...fixture.card, localId: "002", name: "Synthetic different card" },
      });
      const winner = await createCatalogServices(pool).sourceObservations.promoteObservation({
        observationId: "refresh-B",
        context,
      });
      expect(winner.catalogItemId).not.toBe(x);
      const beforeX = await readCompleteStream(store, { streamId: `catalog.item-${x}` });
      if (projection === "live") await drainLocalProjectionHandlerSets("catalog", pool, services.items.projectors);
      const resumed = createCatalogServices(pool).sourceObservations.promoteObservation({
        observationId: "refresh-A",
        context,
      });
      if (projection === "live") await expect(resumed).resolves.toMatchObject({ catalogItemId: winner.catalogItemId });
      else await expect(resumed).rejects.toThrow("promotion-target-bound-elsewhere");
      expect(await readCompleteStream(store, { streamId: `catalog.item-${x}` })).toEqual(beforeX);
      const owners = await locatePromotionReferenceStreams(pool, {
        level: "item",
        providerKey: "tcgplayer",
        externalKey: "product:493958",
      });
      expect(owners.filter((stream) => stream.startsWith("catalog.item-"))).toEqual([
        `catalog.item-${winner.catalogItemId}`,
      ]);
      expect(await itemCreations()).toHaveLength(2);
    },
  );

  it("allocates once for a legacy-only shared-port member set", async () => {
    await record("legacy-A");
    await record("legacy-B");
    const keys = [
      { level: "member", observationId: "legacy-A" },
      { level: "member", observationId: "legacy-B" },
    ] as const;
    const session = await acquire("cat_candidate_legacy", keys);
    expect(session.evidence.keys.has(JSON.stringify(["item", "tcgplayer", "product:493958"]))).toBe(true);
    await expect(acquire("cat_candidate_other", [...keys].reverse())).rejects.toThrow(
      "promotion-target-bound-elsewhere",
    );
    await session.append({
      streamId: "catalog.item-cat_candidate_legacy",
      expectedVersion: 0,
      context,
      events: [
        {
          eventType: "catalog.catalog-item.created",
          payload: {
            itemId: "cat_candidate_legacy",
            languageCode: "en",
            title: { defaultLocale: "en", values: { en: "Synthetic candidate" } },
            subtitle: null,
            description: null,
          },
        },
      ],
    });
    expect(await itemCreations()).toHaveLength(1);
  });

  it("refuses missing indexes without item effects", async () => {
    await record("missing-index");
    await pool.query("DROP INDEX catalog_promotion_source_references_idx");
    await expect(requirePromotionTargetIndexes(pool)).rejects.toThrow("promotion-target-index-unavailable");
    await expect(
      services.sourceObservations.promoteObservation({ observationId: "missing-index", context }),
    ).rejects.toThrow("promotion-target-index-unavailable");
    expect(await itemCreations()).toHaveLength(0);
  });

  it("refuses an identity-poisoned retained stream instead of treating it as absence", async () => {
    const retained = await retainedPlan("poisoned-A");
    const store = createPostgresEventStore({ pool });
    await store.appendToStream({
      streamId: `catalog.item-${retained.targetId}`,
      expectedVersion: 0,
      context,
      events: [
        {
          eventType: "catalog.catalog-item.created",
          payload: {
            itemId: "different-identity",
            languageCode: "en",
            title: { defaultLocale: "en", values: { en: "Synthetic poison" } },
          },
        },
      ],
    });
    await record("poisoned-B");
    await expect(
      services.sourceObservations.promoteObservation({ observationId: "poisoned-B", context }),
    ).rejects.toThrow("promotion-target-conflicting-item-identity");
    expect(
      await readCompleteStream(store, { streamId: `catalog.item-${sourceObservationTargetId("poisoned-B")}` }),
    ).toEqual([]);
  });
});
