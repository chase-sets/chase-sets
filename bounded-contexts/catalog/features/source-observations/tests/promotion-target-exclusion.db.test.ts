import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  type PgQueryable,
  type PgPoolClient,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { module as catalogModule } from "../../../index";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import { seedCatalogDatabase } from "../../../support/authoring-support/seed";
import { seedContext as context } from "../../../support/seed-support/context";
import type { BlueprintId, CatalogItemId, DimensionId, OptionId } from "../../../ids";
import { evolveBlueprint, initialBlueprintState, type BlueprintEvent } from "../../blueprints/domain/domain";
import fixture from "../api/__fixtures__/tcgdex/normal.json";
import productFixture from "../api/__fixtures__/tcgplayer-pokemon-sealed-product/normal.json";
import { tcgplayerPokemonSealedProductSourceObservationMappingContract } from "../api/providers/tcgplayer/executable-mapping-contract";
import { tcgdexPokemonCardSourceObservationMappingContract } from "../api/tcgdex-executable-mapping-contract";
import { normalizeCatalogProviderSourceObservation } from "../api/promotion/provider-source-observation-normalizer";
import { normalizeProductAssetSet } from "../api/seeding/product-asset-normalization";
import {
  loadCatalogItemPromotionProfile,
  previewCatalogItemPromotionPlan,
  requireCatalogPromotionProfileVersion,
  requireCatalogItemPromotionObservation,
  requireSourceObservationMappingContract,
} from "../api/source-observation-promotion-execution";
import { resolvePromotionReferenceHierarchy } from "../api/source-observation-promotion-reference-hierarchy";
import { sourceObservationTargetId } from "../api/promotion/promotion-target-identity";
import {
  locatePromotionReferenceStreams,
  requirePromotionTargetIndexes,
} from "../api/promotion/promotion-reference-locator";
import {
  createPostgresPromotionTargetExclusion,
  type PromotionTargetAuthority,
} from "../api/promotion/promotion-target-exclusion";
import {
  promotionTargetBindingStream,
  retainedPromotionTargetBindingStream,
  type PromotionTargetKey,
} from "../api/promotion/promotion-target-identity";
import { trackPromotionProfileAuthority } from "../api/promotion/promotion-profile-authority";
import { createCatalogProviderIntegrationProfileVersionStore } from "../api/providers/provider-integration-profile-store";
import { resetCatalogIntegrationPreLaunchData } from "../api/governance/catalog-integration-data-migration-reset";
import {
  discoverPromotionTargets,
  locatedPromotionSourceTargets,
  foldPromotionTargetItem,
} from "../api/promotion/promotion-target-discovery";
import {
  resolveCatalogProviderDuplicatePrevention,
  type CatalogProviderDuplicatePreventionDb,
} from "../api/promotion/provider-duplicate-prevention-resolver";
import { promotionCurrentItem } from "../api/promotion/source-observation-target-exclusion";
import { guardPromotionMaterial } from "../api/promotion/promotion-material-guards";
import { decideSourceObservation, initialSourceObservationState, type SourceObservationEvent } from "../domain/domain";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  decideCatalogItem,
  evolveCatalogItem,
  initialCatalogItemState,
  type CatalogItemCommand,
  type CatalogItemEvent,
} from "../../catalog-items/domain/domain";

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

  async function persistedMappingContract() {
    const identity = tcgdexPokemonCardSourceObservationMappingContract;
    const version = await services.providerIntegrationProfiles.getProfileVersion(
      identity.providerKey,
      identity.profileVersion,
      { profileKey: identity.profileKey },
    );
    if (!version) throw new Error("Seeded executable mapping profile is missing");
    return requireSourceObservationMappingContract(version);
  }

  async function record(id: string, reference = "product:synthetic-493958", overrides: Partial<typeof fixture> = {}) {
    const mapped = normalizeCatalogProviderSourceObservation({
      contract: await persistedMappingContract(),
      payload: {
        ...fixture,
        ...overrides,
        observationId: id,
        externalKey: id,
        sourceUrl: `https://synthetic.invalid/source/${id}`,
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

  async function retainedPlan(id: string, reference?: string) {
    const observation = await record(id, reference);
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

  it("refreshes changed A at its original target and resolves overlapping B without another creation", async () => {
    await record("changed-A");
    const first = await services.sourceObservations.promoteObservation({ observationId: "changed-A", context });
    const store = createPostgresEventStore({ pool });
    const streamId = `catalog.item-${first.catalogItemId}`;
    const before = await readCompleteStream(store, { streamId });
    const changed = {
      card: { ...fixture.card, name: "Synthetic changed name" },
      catalogHashMaterial: { ...fixture.catalogHashMaterial, revision: "changed" },
    };
    await record("changed-A", undefined, changed);
    await expect(
      createCatalogServices(pool).sourceObservations.promoteObservation({ observationId: "changed-A", context }),
    ).resolves.toMatchObject({ catalogItemId: first.catalogItemId });
    const after = await readCompleteStream(store, { streamId });
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
    expect(await itemCreations()).toHaveLength(1);
    await record("changed-B", undefined, changed);
    await expect(
      createCatalogServices(pool).sourceObservations.promoteObservation({ observationId: "changed-B", context }),
    ).resolves.toMatchObject({ catalogItemId: first.catalogItemId });
    expect(await itemCreations()).toHaveLength(1);
  });

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

  it.each(["item", "product"] as const)(
    "reads retained raw %s bindings before any source or item effects",
    async (level) => {
      const store = createPostgresEventStore({ pool });
      const raw = { level, providerKey: " SyNtHeTiC ", externalKey: " MiXeD " };
      const canonical = { level, providerKey: "synthetic", externalKey: "mixed" };
      const streamId = retainedPromotionTargetBindingStream(raw);
      await store.appendToStream({
        streamId,
        expectedVersion: 0,
        context,
        events: [
          {
            eventType: "catalog.promotion-target.bound",
            payload: {
              version: 1,
              key: raw,
              targetId: "cat_candidate_retained",
              operationId: "synthetic-old-writer",
              generation: 1,
            },
          },
        ],
      });
      const retained = await readCompleteStream(store, { streamId });
      await expect(acquire("cat_candidate_fork", [raw])).rejects.toThrow("promotion-target-bound-elsewhere");
      const first = await acquire("cat_candidate_retained", [raw]);
      const second = await acquire("cat_candidate_retained", [raw]);
      await expect(
        first.append({ streamId: "catalog.item-cat_candidate_retained", expectedVersion: 0, context, events: [] }),
      ).rejects.toThrow();
      await expect(
        second.append({ streamId: "catalog.item-cat_candidate_retained", expectedVersion: 0, context, events: [] }),
      ).resolves.toEqual([]);
      expect(await readCompleteStream(store, { streamId })).toEqual(retained);
      expect(
        (await readCompleteStream(store, { streamId: promotionTargetBindingStream(canonical) })).map(
          (event) => event.payload.generation,
        ),
      ).toEqual([1, 2]);
      expect(await itemCreations()).toHaveLength(0);
    },
  );

  it("guards negative and material evidence atomically, including a key added by closure", async () => {
    await record("closure-A");
    const key = { level: "item", providerKey: "tcgplayer", externalKey: "product:synthetic-493958" } as const;
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

  it("rolls back an inserted item on a late negative guard without a wake", async () => {
    const channel = "catalog_promotion_rollback_test";
    const store = createPostgresEventStore({ pool, wakeNotifications: { enabled: true, channel } });
    const port = createPostgresPromotionTargetExclusion({ pool, eventStore: store });
    const targetId = "cat_candidate_rollback";
    const session = await port.acquire({
      keys: [{ level: "item", providerKey: "synthetic", externalKey: "rollback" }],
      additionalTargetIds: [targetId],
      context,
      validateAuthority: async () => undefined,
      selectTarget: async () => targetId,
    });
    const targetStream = `catalog.item-${targetId}`;
    // Acquisition commits an empty target guard row, not an item event. The
    // failed append must preserve that row and roll back newly inserted guards.
    const before = await pool.query("SELECT * FROM event_store_streams WHERE stream_id=$1", [targetStream]);
    expect(before.rows).toEqual([expect.objectContaining({ stream_id: targetStream, current_version: "0" })]);
    const newGuard = "catalog.item-cat_rollback_new_guard";
    expect((await pool.query("SELECT stream_id FROM event_store_streams WHERE stream_id=$1", [newGuard])).rows).toEqual(
      [],
    );
    session.guard(newGuard, 0);
    session.guard("catalog.source-observation-late-negative", 0);
    await record("late-negative");
    const listener = (await pool.connect()) as PgPoolClient & {
      on(event: "notification", handler: (message: { payload?: string }) => void): void;
    };
    const notifications: string[] = [];
    listener.on("notification", (message) => notifications.push(message.payload ?? ""));
    try {
      await listener.query(`LISTEN ${channel}`);
      const events = decideCatalogItem(initialCatalogItemState, {
        type: "CreateCatalogItem",
        itemId: targetId as CatalogItemId,
        languageCode: "en",
        title: { defaultLocale: "en", values: { en: "Synthetic rollback" } },
      });
      await expect(
        session.append({
          streamId: `catalog.item-${targetId}`,
          expectedVersion: 0,
          context,
          events: events.map(createPassthroughDomainEventCodec<CatalogItemEvent>().encode),
        }),
      ).rejects.toMatchObject({ code: "concurrency_conflict" });
      expect(await readCompleteStream(store, { streamId: `catalog.item-${targetId}` })).toEqual([]);
      expect((await pool.query("SELECT * FROM event_store_streams WHERE stream_id=$1", [targetStream])).rows).toEqual(
        before.rows,
      );
      expect(
        (await pool.query("SELECT stream_id FROM event_store_streams WHERE stream_id=$1", [newGuard])).rows,
      ).toEqual([]);
      await pool.query("SELECT pg_notify($1, $2)", [channel, "synthetic-delivery-barrier"]);
      const deadline = Date.now() + 30000;
      while (!notifications.includes("synthetic-delivery-barrier") && Date.now() < deadline)
        await listener.query("SELECT 1");
      expect(notifications).toEqual(["synthetic-delivery-barrier"]);
    } finally {
      await listener.query(`UNLISTEN ${channel}`);
      listener.release();
    }
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
    const contract = await persistedMappingContract();
    await store.appendToStreams!(
      Array.from({ length: 500 }, (_, index) => {
        const id = `page-${String(index).padStart(3, "0")}`;
        const mapped = normalizeCatalogProviderSourceObservation({
          contract,
          payload: {
            ...fixture,
            observationId: id,
            externalKey: id,
            sourceUrl: `https://synthetic.invalid/source/${id}`,
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:synthetic-493958" }],
          },
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
    const key = { level: "item", providerKey: "tcgplayer", externalKey: "product:synthetic-493958" } as const;
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

  it("explains the actual exact-key locator queries over unrelated retained rows", async () => {
    await record("access-unrelated", "product:unrelated");
    const queries: { sql: string; values?: readonly unknown[] }[] = [];
    const traced: PgQueryable = {
      query: async <T>(sql: string, values?: readonly unknown[]) => {
        queries.push({ sql, values });
        return pool.query<T>(sql, values);
      },
    };
    expect(
      await locatePromotionReferenceStreams(traced, {
        level: "item",
        providerKey: "synthetic-absent",
        externalKey: "absent",
      }),
    ).toEqual([]);
    expect(queries).toHaveLength(2);
    type PlanNode = { "Node Type": string; "Index Name"?: string; Plans?: PlanNode[] };
    const nodes = (plan: PlanNode): { node: string; index?: string }[] => [
      { node: plan["Node Type"], index: plan["Index Name"] },
      ...(plan.Plans ?? []).flatMap(nodes),
    ];
    for (const query of queries) {
      const explained = await pool.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
        `EXPLAIN (FORMAT JSON) ${query.sql}`,
        query.values,
      );
      const plan = explained.rows[0]["QUERY PLAN"][0].Plan;
      expect(plan["Node Type"]).toBeTruthy();
      // Tiny retained sets may legitimately choose a sequential scan. Preserve
      // the actual plan, not a forced enable_seqscan setting or invented PASS.
      console.info("promotion-reference-access-plan", JSON.stringify(nodes(plan)));
    }
  });

  it.each([
    "linked",
    "unlinked",
    "source-product-unlinked",
    "relinked",
    "inactive-pinned",
    "inactive-released",
  ] as const)("distinguishes real retained %s history before allocating", async (state) => {
    const retained = await retainedPlan("lifecycle-A");
    const owner = "cat_synthetic_lifecycle" as CatalogItemId;
    for (const command of retained.plan.commands.filter(
      (command) => state === "source-product-unlinked" || command.type !== "LinkExternalProductReference",
    )) {
      await services.items.commandHandler({
        streamId: `catalog.item-${owner}`,
        command: command.type === "CreateCatalogItem" ? { ...command, itemId: owner } : command,
        context,
      });
    }
    if (["unlinked", "source-product-unlinked", "relinked", "inactive-released"].includes(state))
      await services.items.commandHandler({
        streamId: `catalog.item-${owner}`,
        command: {
          type: "UnlinkExternalCatalogItemReference",
          providerKey: "TCGPLAYER",
          externalKey: " PRODUCT:SYNTHETIC-493958 ",
        },
        context,
      });
    if (state === "relinked")
      await services.items.commandHandler({
        streamId: `catalog.item-${owner}`,
        command: {
          type: "LinkExternalCatalogItemReference",
          providerKey: "tcgplayer",
          externalKey: "product:synthetic-493958",
        },
        context,
      });
    if (state === "source-product-unlinked")
      for (const command of retained.plan.commands) {
        if (command.type === "LinkExternalProductReference")
          await services.items.commandHandler({
            streamId: `catalog.item-${owner}`,
            context,
            command: {
              type: "UnlinkExternalProductReference",
              providerKey: command.providerKey,
              externalKey: command.externalKey,
            },
          });
      }
    if (state === "unlinked" || state === "source-product-unlinked")
      await services.items.commandHandler({
        streamId: `catalog.item-${owner}`,
        command: { type: "LinkExternalCatalogItemReference", providerKey: "synthetic", externalKey: "unrelated-r2" },
        context,
      });
    if (state.startsWith("inactive"))
      await services.items.commandHandler({
        streamId: `catalog.item-${owner}`,
        command: { type: "RemoveDraftCatalogItem" },
        context,
      });
    await record("lifecycle-B");
    const before = await readCompleteStream(createPostgresEventStore({ pool }), {
      streamId: `catalog.item-${owner}`,
    });
    const attempt = createCatalogServices(pool).sourceObservations.promoteObservation({
      observationId: "lifecycle-B",
      context,
    });
    if (state === "inactive-pinned") {
      await expect(attempt).rejects.toThrow("promotion-target-inactive");
      expect(await itemCreations()).toHaveLength(1);
    } else {
      const result = await attempt;
      if (state === "linked" || state === "relinked") expect(result.catalogItemId).toBe(owner);
      else expect(result.catalogItemId).not.toBe(owner);
    }
    if (state.startsWith("inactive") || state === "unlinked" || state === "source-product-unlinked")
      expect(
        await readCompleteStream(createPostgresEventStore({ pool }), { streamId: `catalog.item-${owner}` }),
      ).toEqual(before);
  });

  it("folds the decisive owner and negative unlink beyond page 500 and fences a later relink", async () => {
    const store = createPostgresEventStore({ pool });
    const codec = createPassthroughDomainEventCodec<CatalogItemEvent>();
    const key = { level: "item", providerKey: "synthetic", externalKey: "page-unlink" } as const;
    await store.appendToStreams!(
      Array.from({ length: 501 }, (_, index) => {
        const itemId = `cat_page_unlink_${String(index).padStart(3, "0")}` as CatalogItemId;
        const commands: CatalogItemCommand[] = [
          {
            type: "CreateCatalogItem",
            itemId,
            languageCode: "en",
            title: { defaultLocale: "en", values: { en: "Synthetic page owner" } },
          },
          { type: "LinkExternalCatalogItemReference", providerKey: "SyNtHeTiC", externalKey: "PAGE-UNLINK" },
          ...(index < 500
            ? [
                {
                  type: "UnlinkExternalCatalogItemReference" as const,
                  providerKey: key.providerKey,
                  externalKey: key.externalKey,
                },
              ]
            : []),
        ];
        let state = initialCatalogItemState;
        const events = commands.flatMap((command) => {
          const events = decideCatalogItem(state, command);
          state = events.reduce(evolveCatalogItem, state);
          return events.map(codec.encode);
        });
        return { streamId: `catalog.item-${itemId}`, expectedVersion: 0, context, events };
      }),
    );
    expect(await locatePromotionReferenceStreams(pool, key)).toHaveLength(501);
    await expect(acquire("cat_candidate_after_unlink", [key])).rejects.toThrow("promotion-target-bound-elsewhere");
    const late = "catalog.item-cat_page_unlink_500";
    await services.items.commandHandler({
      streamId: late,
      command: {
        type: "UnlinkExternalCatalogItemReference",
        providerKey: key.providerKey,
        externalKey: key.externalKey,
      },
      context,
    });
    const session = await acquire("cat_candidate_after_unlink", [key]);
    expect(session.evidence.items.get("cat_page_unlink_500")?.externalCatalogItemReferences).toEqual([]);
    await services.items.commandHandler({
      streamId: late,
      command: { type: "LinkExternalCatalogItemReference", providerKey: key.providerKey, externalKey: key.externalKey },
      context,
    });
    await expect(
      session.append({ streamId: "catalog.item-cat_candidate_after_unlink", expectedVersion: 0, context, events: [] }),
    ).rejects.toThrow();
    expect(await readCompleteStream(store, { streamId: "catalog.item-cat_candidate_after_unlink" })).toEqual([]);
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
      const canonical = createCatalogProviderIntegrationProfileVersionStore(pool);
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
      await expect(pending).rejects.toThrow();
      expect(
        await readCompleteStream(createPostgresEventStore({ pool }), {
          streamId: `catalog.item-cat_candidate_${mutation}`,
        }),
      ).toEqual([]);
    },
  );

  it("holds the profile write barrier through guarded append and releases it at commit", async () => {
    await acquire(
      "cat_candidate_profile_barrier",
      [{ level: "item", providerKey: "synthetic", externalKey: "profile-barrier" }],
      async () => {
        const writer = await pool.connect();
        try {
          await writer.query("BEGIN");
          await expect(
            writer.query("LOCK TABLE catalog_provider_integration_profile_versions IN ROW EXCLUSIVE MODE NOWAIT"),
          ).rejects.toMatchObject({ code: "55P03" });
        } finally {
          await writer.query("ROLLBACK");
          writer.release();
        }
      },
    );
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await expect(
        writer.query("LOCK TABLE catalog_provider_integration_profile_versions IN ROW EXCLUSIVE MODE NOWAIT"),
      ).resolves.toBeDefined();
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
  });

  it.each(["seed", "authoring", "reset"].flatMap((writer) => [false, true].map((rollback) => ({ writer, rollback }))))(
    "$writer waits for the real promotion SHARE fence, rollback=$rollback",
    async ({ writer, rollback }) => {
      const profiles = createCatalogProviderIntegrationProfileVersionStore(pool);
      const selected = (await profiles.listProfileVersions("tcgdex"))[0];
      let mutation: Promise<unknown> | undefined;
      let settled = false;
      const operation = acquire(
        "cat_candidate_barrier",
        [{ level: "item", providerKey: "synthetic", externalKey: "barrier" }],
        async (client) => {
          expect(
            (await client.query<{ transaction_isolation: string }>("SHOW transaction_isolation")).rows[0]
              .transaction_isolation,
          ).toBe("read committed");
          mutation =
            writer === "seed"
              ? profiles.seedProfileVersions([selected])
              : writer === "authoring"
                ? profiles.upsertProfileVersion(selected)
                : resetCatalogIntegrationPreLaunchData(pool, { rebuildSeedProfiles: false });
          void mutation.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          const deadline = Date.now() + 30000;
          let blocked = false;
          while (Date.now() < deadline) {
            const locks = await pool.query<{ granted: boolean }>(
              "SELECT granted FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND relation='catalog_provider_integration_profile_versions'::regclass AND mode='RowExclusiveLock' AND NOT granted",
            );
            if (locks.rows.length) {
              blocked = true;
              break;
            }
            if (settled) break;
          }
          expect(blocked).toBe(true);
          expect(settled).toBe(false);
          if (rollback) throw new Error("synthetic-profile-rollback");
        },
      );
      try {
        if (rollback) await expect(operation).rejects.toThrow("synthetic-profile-rollback");
        else await expect(operation).resolves.toMatchObject({ targetId: "cat_candidate_barrier" });
      } finally {
        await mutation;
      }
      expect(settled).toBe(true);
      if (rollback)
        expect(
          await readCompleteStream(createPostgresEventStore({ pool }), {
            streamId: promotionTargetBindingStream({ level: "item", providerKey: "synthetic", externalKey: "barrier" }),
          }),
        ).toEqual([]);
    },
  );

  it.each(["old-worker", "missing-method", "function-drift"])(
    "refuses activation for %s and preserves retained readers",
    async (skew) => {
      await record("activation-source");
      const eventStore = createPostgresEventStore({ pool });
      const before = await readCompleteStream(eventStore, { streamId: "catalog.source-observation-activation-source" });
      if (skew === "function-drift")
        await pool.query("ALTER FUNCTION catalog_promotion_reference_text_v1(text) VOLATILE");
      const oldStore =
        skew === "missing-method"
          ? new Proxy(eventStore, {
              get(target, key) {
                return key === "appendToStreamsInTransaction" ? undefined : Reflect.get(target, key, target);
              },
            })
          : eventStore;
      const port = createPostgresPromotionTargetExclusion({
        pool,
        eventStore: oldStore,
        writerProtocol: skew === "old-worker" ? "promotion-target/v1" : "promotion-target/v2",
      });
      await expect(
        port.acquire({
          keys: [{ level: "member", observationId: "activation-source" }],
          additionalTargetIds: ["cat_candidate_activation"],
          context,
          validateAuthority: async () => undefined,
          selectTarget: async () => "cat_candidate_activation",
        }),
      ).rejects.toThrow(
        skew === "old-worker"
          ? "promotion-target-writer-protocol-incompatible"
          : skew === "missing-method"
            ? "promotion-target-transaction-append-unavailable"
            : "promotion-target-access-paths-unavailable",
      );
      expect(
        await readCompleteStream(eventStore, { streamId: "catalog.source-observation-activation-source" }),
      ).toEqual(before);
      expect(await itemCreations()).toHaveLength(0);
    },
  );

  it.each(["A", "B"])(
    "independent runtimes preserve one target under frozen item projections, %s first",
    async (first) => {
      await record("A", "PRODUCT:SYNTHETIC-493958");
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

  it.each(["source", "shared-port"] as const)(
    "real Source Observation and shared-port consumers converge with %s first and frozen item projections",
    async (first) => {
      const retained = await retainedPlan("cross-source");
      const candidate = await record("cross-candidate");
      const normalized = requireCatalogItemPromotionObservation(candidate.normalized, candidate.providerKey);
      const mapping = await loadCatalogItemPromotionProfile(retained.deps, retained.profile.profile);
      const before = (await pool.query("SELECT catalog_item_id FROM catalog_items ORDER BY catalog_item_id")).rows;
      const source = () =>
        createCatalogServices(pool).sourceObservations.promoteObservation({ observationId: "cross-source", context });
      const shared = async () => {
        const authority = trackPromotionProfileAuthority(
          services.providerIntegrationProfiles,
          retained.profile,
          (reader) => requireCatalogPromotionProfileVersion(reader, candidate.providerKey, normalized),
        );
        const session = await boundary().acquire({
          keys: [{ level: "member", observationId: "cross-candidate" }],
          additionalTargetIds: ["cat_candidate_cross"],
          context,
          validateAuthority: authority.validate,
          selectTarget: async (evidence) => {
            const owners = [
              ...new Set([...evidence.bindings.values()].flatMap((binding) => (binding ? [binding.targetId] : []))),
            ];
            if (owners.length > 1) throw new Error("synthetic-ambiguous-owner");
            return owners[0] ?? "cat_candidate_cross";
          },
        });
        await guardPromotionMaterial({
          deps: retained.deps,
          session,
          profile: retained.profile.profile,
          mapping,
          normalized,
        });
        const item = session.evidence.items.get(session.targetId)!;
        const plan = await previewCatalogItemPromotionPlan({
          deps: retained.deps,
          catalogItemId: session.targetId as CatalogItemId,
          mode: item.id ? "refresh" : "create",
          currentItem: promotionCurrentItem(item),
          normalized,
          providerKey: candidate.providerKey,
          externalKey: candidate.externalKey,
          providerProfile: retained.profile.profile,
          providerProfileVersion: retained.profile,
          catalogMapping: mapping,
          promoteAsDraft: false,
        });
        if (plan.status !== "planned") throw new Error(JSON.stringify(plan.diagnostics));
        const completed = await session.preparePlan(plan.plan);
        for (const command of plan.plan.commands.slice(completed))
          await session.commandHandler({ streamId: `catalog.item-${session.targetId}`, command, context });
        return { catalogItemId: session.targetId };
      };
      const winner = await (first === "source" ? source() : shared());
      const reused = await (first === "source" ? shared() : source());
      expect(reused.catalogItemId).toBe(winner.catalogItemId);
      expect(await itemCreations()).toHaveLength(1);
      expect((await pool.query("SELECT catalog_item_id FROM catalog_items ORDER BY catalog_item_id")).rows).toEqual(
        before,
      );
    },
  );

  it.each(["A", "B"].flatMap((first) => [false, true].map((conflict) => ({ first, conflict }))))(
    "promotable mapper Product Options, $first first, conflict=$conflict, with normally published draft blueprint",
    async ({ first, conflict }) => {
      const identity = tcgplayerPokemonSealedProductSourceObservationMappingContract;
      const seeded = await services.providerIntegrationProfiles.getProfileVersion(
        identity.providerKey,
        identity.profileVersion,
        { profileKey: identity.profileKey },
      );
      if (!seeded) throw new Error("Missing sealed-product profile");
      const store = createPostgresEventStore({ pool });
      const blueprint = (
        await readCompleteStream(store, {
          streamId: `catalog.blueprint-${catalogSeedIds.blueprints.pokemonSealedProduct}`,
        })
      )
        .map(createPassthroughDomainEventCodec<BlueprintEvent>().decode)
        .reduce(evolveBlueprint, initialBlueprintState);
      const blueprintId = "bpr_synthetic_promotion_options" as BlueprintId;
      const blueprintKey = "synthetic-promotion-options";
      const dimensionId = catalogSeedIds.dimensions.condition.dimensionId as DimensionId;
      const optionId = catalogSeedIds.dimensions.condition.optionIds.nearMint as OptionId;
      const otherOptionId = catalogSeedIds.dimensions.condition.optionIds.good as OptionId;
      const streamId = `catalog.blueprint-${blueprintId}`;
      await services.blueprints.commandHandler({
        streamId,
        context,
        command: {
          type: "CreateBlueprint",
          blueprintId,
          key: blueprintKey,
          name: { defaultLocale: "en", values: { en: "Synthetic Options fixture" } },
        },
      });
      for (const componentId of blueprint.componentIds)
        await services.blueprints.commandHandler({
          streamId,
          context,
          command: { type: "AttachComponentToBlueprint", componentId },
        });
      await services.blueprints.commandHandler({
        streamId,
        context,
        command: { type: "SetBlueprintFields", fieldRules: blueprint.fieldRules },
      });
      await services.blueprints.commandHandler({
        streamId,
        context,
        command: {
          type: "SetBlueprintDimensions",
          dimensionRules: [
            ...blueprint.dimensionRules.filter((rule) => rule.dimensionId !== dimensionId),
            { dimensionId, required: false, allowedOptionIds: [optionId, otherOptionId] },
          ],
        },
      });
      await services.blueprints.commandHandler({
        streamId,
        context,
        command: {
          type: "SetBlueprintProductResolutionRules",
          canonicalDimensionOrder: [...blueprint.canonicalDimensionOrder, dimensionId],
        },
      });
      await services.blueprints.commandHandler({ streamId, context, command: { type: "PublishBlueprint" } });
      await drainLocalProjectionHandlerSets("catalog", pool, services.blueprints.projectors);
      const profiles = createCatalogProviderIntegrationProfileVersionStore(pool);
      const profileVersion = "synthetic-options-v1";
      await profiles.upsertProfileVersion({
        ...seeded,
        profileVersion,
        lifecycle: "draft",
        active: false,
        profile: { ...seeded.profile, catalogFieldMapping: { ...seeded.profile.catalogFieldMapping, blueprintKey } },
        executableMappingContract: {
          ...requireSourceObservationMappingContract(seeded),
          profileVersion,
          lifecycle: "draft",
        },
      });
      const profile = await profiles.activateProfileVersion(seeded.providerKey, profileVersion, {
        profileKey: seeded.profileKey,
      });
      for (const member of ["A", "B"]) {
        const externalKey = member === "A" ? "synthetic-800001" : "synthetic-800002";
        const selectedOptions = [{ dimensionId, optionId: conflict && member !== first ? otherOptionId : optionId }];
        const mapped = normalizeCatalogProviderSourceObservation({
          contract: requireSourceObservationMappingContract(profile),
          payload: {
            ...productFixture,
            observationId: `options-${member}`,
            externalKey,
            sourceUrl: `https://synthetic.invalid/options/${member}`,
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: `product:${externalKey}` }],
            externalProductReferences: [
              { providerKey: "tcgplayer", externalKey: "sku:synthetic-shared", selectedOptions },
            ],
          },
          observedAt: "2026-10-11T00:00:00.000Z",
        });
        expect(mapped.diagnostics).toEqual([]);
        if (!mapped.observation) throw new Error("Promotable Options fixture did not map");
        expect(
          requireCatalogItemPromotionObservation(mapped.observation.normalized, mapped.observation.providerKey)
            .externalProductReferences,
        ).toEqual([{ providerKey: "tcgplayer", externalKey: "sku:synthetic-shared", selectedOptions }]);
        await services.sourceObservations.commandHandler({
          streamId: `catalog.source-observation-options-${member}`,
          context,
          command: { type: "RecordSourceObservation", ...mapped.observation },
        });
      }
      await drainLocalProjectionHandlerSets("catalog", pool, services.sourceObservations.projectors);
      const winner = await services.sourceObservations.promoteObservation({
        observationId: `options-${first}`,
        context,
        promoteAsDraft: true,
      });
      const before = await readCompleteStream(store, { streamId: `catalog.item-${winner.catalogItemId}` });
      const incoming = createCatalogServices(pool).sourceObservations.promoteObservation({
        observationId: `options-${first === "A" ? "B" : "A"}`,
        context,
        promoteAsDraft: true,
      });
      if (conflict) {
        await expect(incoming).rejects.toThrow("promotion-target-product-options-conflict");
        expect(await readCompleteStream(store, { streamId: `catalog.item-${winner.catalogItemId}` })).toEqual(before);
      } else await expect(incoming).resolves.toMatchObject({ catalogItemId: winner.catalogItemId });
      expect(await itemCreations()).toHaveLength(1);
    },
  );

  it.each(["asset", "multiple-profiles", "explicit-draft"] as const)(
    "reconstructs retained %s plans before reusing their target",
    async (scenario) => {
      const retained = await retainedPlan("reconstruction-A");
      const productAssetSet =
        scenario === "asset"
          ? await normalizeProductAssetSet({
              sourceBody: new Uint8Array(
                Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAGCAYAAADkOT91AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGMQCVjwHxkz0EIAAHp5MEltiCNbAAAAAElFTkSuQmCC",
                  "base64",
                ),
              ),
              sourceContentType: "image/png",
              sourceProviderKey: "tcgdex",
              sourceUrl: "https://synthetic.invalid/image.png",
              storageBaseKey: `synthetic/${retained.targetId}`,
              generatedAt: retained.observation.observedAt,
              assetStorage: { putObject: async ({ key }) => ({ key, publicUrl: `https://synthetic.invalid/${key}` }) },
            })
          : null;
      const result = await previewCatalogItemPromotionPlan({
        deps: retained.deps,
        catalogItemId: retained.targetId,
        mode: "create",
        normalized: retained.normalized,
        providerKey: retained.observation.providerKey,
        externalKey: retained.observation.externalKey,
        providerProfile: retained.profile.profile,
        providerProfileVersion: retained.profile,
        catalogMapping: await loadCatalogItemPromotionProfile(retained.deps, retained.profile.profile),
        productAssetSet,
        promoteAsDraft: scenario === "explicit-draft",
      });
      if (result.status !== "planned") throw new Error(JSON.stringify(result.diagnostics));
      for (const command of result.plan.commands)
        await services.items.commandHandler({ streamId: `catalog.item-${retained.targetId}`, command, context });
      await services.sourceObservations.commandHandler({
        streamId: "catalog.source-observation-reconstruction-A",
        context,
        command: {
          type: "PromoteSourceObservation",
          catalogItemId: retained.targetId,
          promotedAt: "2026-10-11T00:00:00.000Z",
          promotionProfileKey: retained.profile.profileKey,
          promotionProfileVersion: retained.profile.profileVersion,
          promotionPlanFingerprint: result.plan.planFingerprint,
        },
      });
      if (scenario === "multiple-profiles") {
        const profiles = createCatalogProviderIntegrationProfileVersionStore(pool);
        const profileVersion = "synthetic-next-version";
        await profiles.upsertProfileVersion({
          ...retained.profile,
          profileVersion,
          active: false,
          lifecycle: "draft",
          executableMappingContract: {
            ...requireSourceObservationMappingContract(retained.profile),
            profileVersion,
            lifecycle: "draft",
          },
        });
        await profiles.activateProfileVersion(retained.profile.providerKey, profileVersion, {
          profileKey: retained.profile.profileKey,
        });
      }
      await record("reconstruction-B");
      const store = createPostgresEventStore({ pool });
      const prefix = await readCompleteStream(store, { streamId: `catalog.item-${retained.targetId}` });
      await expect(
        createCatalogServices(pool).sourceObservations.promoteObservation({
          observationId: "reconstruction-B",
          context,
        }),
      ).resolves.toMatchObject({ catalogItemId: retained.targetId });
      expect(
        (await readCompleteStream(store, { streamId: `catalog.item-${retained.targetId}` })).slice(0, prefix.length),
      ).toEqual(prefix);
      expect(await itemCreations()).toHaveLength(1);
    },
  );

  it.each(Array.from({ length: 14 }, (_, index) => index + 1))(
    "resumes a real guarded promotion after command commit %s, including effects before marker",
    async (commandNumber) => {
      const retained = await retainedPlan("crash-A");
      expect(retained.plan.commands).toHaveLength(14);
      const connect = pool.connect.bind(pool);
      let commits = 0;
      let interrupted = false;
      const spy = vi.spyOn(pool, "connect").mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === "function") return Reflect.apply(connect, pool, args);
        return connect().then((client) => {
          let promotion = false;
          const originalQuery = client.query.bind(client);
          let query: typeof client.query = async <Row = Record<string, unknown>>(
            sql: string,
            values?: readonly unknown[],
          ) => {
            if (sql === "LOCK TABLE catalog_provider_integration_profile_versions IN SHARE MODE") promotion = true;
            const result = await originalQuery<Row>(sql, values);
            // Acquire and preparePlan bind first; each following COMMIT is one
            // atomic command, including commands whose domain result is empty.
            if (sql === "COMMIT" && promotion && ++commits === commandNumber + 2) {
              interrupted = true;
              throw new Error("synthetic-after-command-commit");
            }
            return result;
          };
          return new Proxy(client, {
            get(target, key) {
              if (key === "query") return query;
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
            // Projection transactions temporarily wrap query. Keep that wrapper
            // visible without mutating the pooled client's underlying method.
            set(target, key, value) {
              if (key === "query") {
                query = value;
                return true;
              }
              return Reflect.set(target, key, value, target);
            },
          });
        });
      });
      try {
        await expect(
          services.sourceObservations.promoteObservation({ observationId: "crash-A", context }),
        ).rejects.toThrow("synthetic-after-command-commit");
      } finally {
        spy.mockRestore();
      }
      expect(interrupted).toBe(true);
      const store = createPostgresEventStore({ pool });
      const prefix = await readCompleteStream(store, { streamId: `catalog.item-${retained.targetId}` });
      await expect(
        createCatalogServices(pool).sourceObservations.promoteObservation({ observationId: "crash-A", context }),
      ).resolves.toMatchObject({ catalogItemId: retained.targetId });
      const resumed = await readCompleteStream(store, { streamId: `catalog.item-${retained.targetId}` });
      expect(resumed.slice(0, prefix.length)).toEqual(prefix);
      expect(resumed.filter((event) => event.eventType === "catalog.catalog-item.created")).toHaveLength(1);
      expect(await itemCreations()).toHaveLength(1);
    },
  );

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])(
    "retained mapper-derived create boundary %s never creates a second target",
    async (boundary) => {
      const retained = await retainedPlan("retained-A", boundary >= 13 ? "PRODUCT:SYNTHETIC-493958" : undefined);
      expect(retained.plan.commands).toHaveLength(14);
      expect(retained.plan.commands[13].type).toBe("LinkExternalCatalogItemReference");
      for (const command of retained.plan.commands.slice(0, boundary))
        await services.items.commandHandler({ streamId: `catalog.item-${retained.targetId}`, command, context });
      await record("incoming-B");
      const locator = await locatePromotionReferenceStreams(pool, {
        level: "item",
        providerKey: "tcgplayer",
        externalKey: "product:synthetic-493958",
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

  it.each(
    ([0, 1, 2, 3, 4, 5, "source-link"] as const).flatMap((boundary) =>
      ["live", "frozen"].map((projection) => ({ boundary, projection })),
    ),
  )("legacy refresh $boundary on X respects the $projection duplicate policy", async ({ boundary, projection }) => {
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
    const selection = async () => {
      const trace: { sql: string; values?: readonly unknown[]; rows: unknown[] }[] = [];
      const db: CatalogProviderDuplicatePreventionDb = {
        async query<T>(sql: string, values?: readonly unknown[]) {
          const result = await pool.query<T>(sql, values);
          trace.push({ sql, values, rows: result.rows });
          return result;
        },
      };
      const result = await resolveCatalogProviderDuplicatePrevention({
        db,
        profile: retained.profile.profile,
        providerKey: retained.observation.providerKey,
        externalKey: retained.observation.externalKey,
        normalized: retained.normalized,
        catalog: await loadCatalogItemPromotionProfile(retained.deps, retained.profile.profile),
      });
      console.info("promotion-selector-precondition", JSON.stringify({ boundary, projection, result, trace }));
      return { result, trace };
    };
    const beforeSelection = await selection();
    expect(beforeSelection.result).toMatchObject({
      status: "matched",
      catalogItemId: x,
      ruleKey: "pokemon-card-partial-draft-retry",
    });
    const fieldQuery = beforeSelection.trace.find((entry) => entry.sql.includes("item.field_values @>"));
    expect(fieldQuery).toBeDefined();
    const fieldParameters = [...fieldQuery!.sql.matchAll(/item\.field_values @> \$(\d+)::jsonb/g)];
    expect(fieldParameters.length).toBeGreaterThan(0);
    for (const [, parameter] of fieldParameters) {
      const operand = fieldQuery!.values![Number(parameter) - 1];
      const parsed = JSON.parse(String(operand));
      expect(Array.isArray(parsed)).toBe(true);
      const control = await pool.query<{ object_match: boolean; array_match: boolean }>(
        "SELECT field_values @> $2::jsonb AS object_match, field_values @> $3::jsonb AS array_match FROM catalog_items WHERE catalog_item_id=$1",
        [x, JSON.stringify(parsed[0]), String(operand)],
      );
      expect(control.rows).toEqual([{ object_match: false, array_match: true }]);
    }
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
    const commandCount =
      boundary === "source-link"
        ? refresh.plan.commands.findIndex((command) => command.type === "LinkExternalProductReference") + 1
        : boundary;
    for (const command of refresh.plan.commands.slice(0, commandCount))
      await services.items.commandHandler({ streamId: `catalog.item-${x}`, command, context });
    await record("refresh-B", "product:synthetic-493958", {
      card: { ...fixture.card, localId: "002", name: "Synthetic different card" },
    });
    const checkpoints = async () =>
      (
        await pool.query(
          "SELECT projector_name, last_global_position::text FROM event_projection_checkpoints ORDER BY projector_name",
        )
      ).rows;
    const frozenCheckpoints = await checkpoints();
    const projectedX = (
      await pool.query("SELECT catalog_item_id, field_values FROM catalog_items WHERE catalog_item_id=$1", [x])
    ).rows;
    expect(projectedX).toHaveLength(1);
    if (boundary === "source-link") {
      const key = { level: "product", providerKey: "tcgdex", externalKey: "en:refresh-a" } as const;
      expect(await locatePromotionReferenceStreams(pool, key)).toContain(`catalog.item-${x}`);
      const evidence = await discoverPromotionTargets({
        eventStore: store,
        keys: [key],
        additionalTargetIds: [],
        locate: (reference) => locatePromotionReferenceStreams(pool, reference),
      });
      expect(locatedPromotionSourceTargets(evidence, evidence.sources.get("refresh-A")!)).toContain(x);
    }
    const incoming = createCatalogServices(pool).sourceObservations.promoteObservation({
      observationId: "refresh-B",
      context,
    });
    if (boundary === "source-link") {
      const before = await readCompleteStream(store, { streamId: `catalog.item-${x}` });
      await expect(incoming).rejects.toThrow("promotion-target-retained-history-conflict");
      expect(await readCompleteStream(store, { streamId: `catalog.item-${x}` })).toEqual(before);
      expect(await itemCreations()).toHaveLength(1);
      return;
    }
    const winner = await incoming;
    expect(await checkpoints()).toEqual(frozenCheckpoints);
    expect(
      (await pool.query("SELECT catalog_item_id, field_values FROM catalog_items WHERE catalog_item_id=$1", [x])).rows,
    ).toEqual(projectedX);
    expect((await selection()).result).toMatchObject({ status: "matched", catalogItemId: x });
    expect(winner.catalogItemId).not.toBe(x);
    const beforeX = await readCompleteStream(store, { streamId: `catalog.item-${x}` });
    if (projection === "live") await drainLocalProjectionHandlerSets("catalog", pool, services.items.projectors);
    expect((await selection()).result).toMatchObject({
      status: "matched",
      catalogItemId: projection === "live" ? winner.catalogItemId : x,
    });
    console.info(
      "promotion-checkpoint-precondition",
      JSON.stringify({ boundary, projection, frozenCheckpoints, current: await checkpoints() }),
    );
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
      externalKey: "product:synthetic-493958",
    });
    expect(owners.filter((stream) => stream.startsWith("catalog.item-"))).toEqual([
      `catalog.item-${winner.catalogItemId}`,
    ]);
    expect(await itemCreations()).toHaveLength(2);
  });

  it("allocates once for a legacy-only shared-port member set", async () => {
    await record("legacy-A");
    await record("legacy-B");
    const keys = [
      { level: "member", observationId: "legacy-A" },
      { level: "member", observationId: "legacy-B" },
    ] as const;
    const session = await acquire("cat_candidate_legacy", keys);
    expect(session.evidence.keys.has(JSON.stringify(["item", "tcgplayer", "product:synthetic-493958"]))).toBe(true);
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

  it.each([13, 14])("shared-port consumers cannot bypass retained application boundary %s", async (boundary) => {
    const retained = await retainedPlan("shared-port-retained-A");
    for (const command of retained.plan.commands.slice(0, boundary))
      await services.items.commandHandler({ streamId: `catalog.item-${retained.targetId}`, command, context });
    await record("shared-port-incoming-B");
    await expect(
      acquire("cat_candidate_attempted_fork", [{ level: "member", observationId: "shared-port-incoming-B" }]),
    ).rejects.toThrow("promotion-target-bound-elsewhere");
    expect(await itemCreations()).toHaveLength(1);
  });

  it("refuses missing indexes without item effects", async () => {
    await record("missing-index");
    await pool.query("DROP INDEX catalog_promotion_source_reference_pairs_v1_idx");
    await expect(requirePromotionTargetIndexes(pool)).rejects.toThrow("promotion-target-access-paths-unavailable");
    await expect(
      services.sourceObservations.promoteObservation({ observationId: "missing-index", context }),
    ).rejects.toThrow("promotion-target-access-paths-unavailable");
    expect(await itemCreations()).toHaveLength(0);
  });

  it.each(["observed", "deferred", "rejected"] as const)(
    "retains both reference revisions after an unattempted source is %s",
    async (status) => {
      await record("history-A", "product:old");
      await record("history-A", "product:new", {
        catalogHashMaterial: { ...fixture.catalogHashMaterial, name: "Synthetic revised hash material" },
      });
      if (status !== "observed")
        await services.sourceObservations.commandHandler({
          streamId: "catalog.source-observation-history-A",
          command:
            status === "rejected"
              ? { type: "RejectSourceObservation", reason: "Synthetic retained history" }
              : {
                  type: "DeferSourceObservation",
                  reason: "Synthetic retained history",
                  deferredAt: "2026-10-10T00:00:00.000Z",
                },
          context,
        });
      await record("history-B", "product:old");
      const winner = await services.sourceObservations.promoteObservation({ observationId: "history-B", context });
      if (!winner.catalogItemId) throw new Error("Expected an item promotion");
      const session = await acquire(winner.catalogItemId, [{ level: "member", observationId: "history-B" }]);
      expect(session.evidence.keys.has(JSON.stringify(["item", "tcgplayer", "product:new"]))).toBe(true);
      expect(
        session.evidence.sources
          .get("history-A")!
          .revisions.some((revision) =>
            revision.normalized?.externalCatalogItemReferences?.some(
              (reference) => reference.externalKey === "product:old",
            ),
          ),
      ).toBe(true);
      expect(await itemCreations()).toHaveLength(1);
    },
  );

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

  it.each(["terminal-fingerprint", "older-profile"] as const)(
    "does not let a matching revision hide %s poison",
    async (poison) => {
      const retained = await retainedPlan("evidence-A");
      const store = createPostgresEventStore({ pool });
      for (const command of retained.plan.commands)
        await services.items.commandHandler({ streamId: `catalog.item-${retained.targetId}`, command, context });
      if (poison === "terminal-fingerprint") {
        await services.sourceObservations.commandHandler({
          streamId: "catalog.source-observation-evidence-A",
          context,
          command: {
            type: "PromoteSourceObservation",
            catalogItemId: retained.targetId,
            promotedAt: "2026-10-10T00:00:00.000Z",
            promotionProfileKey: retained.profile.profileKey,
            promotionProfileVersion: retained.profile.profileVersion,
            promotionPlanFingerprint: "f".repeat(64),
          },
        });
      } else {
        const streamId = "catalog.source-observation-evidence-A";
        const history = await readCompleteStream(store, { streamId });
        const recorded = history[0];
        await store.appendToStream({
          streamId,
          expectedVersion: history.length,
          context,
          events: [
            {
              eventType: recorded.eventType,
              payload: { ...recorded.payload, sourceMappingFingerprint: "f".repeat(64) },
            },
            { eventType: recorded.eventType, payload: recorded.payload },
          ],
        });
      }
      await record("evidence-B");
      const before = await readCompleteStream(store, { streamId: `catalog.item-${retained.targetId}` });
      await expect(
        services.sourceObservations.promoteObservation({ observationId: "evidence-B", context }),
      ).rejects.toThrow(
        poison === "terminal-fingerprint"
          ? "promotion-target-retained-fingerprint-conflict"
          : "promotion-target-source-fingerprint-conflict",
      );
      expect(await readCompleteStream(store, { streamId: `catalog.item-${retained.targetId}` })).toEqual(before);
      expect(await itemCreations()).toHaveLength(1);
    },
  );

  it("refuses a reachable source header with incomplete payload chunks", async () => {
    const mapped = normalizeCatalogProviderSourceObservation({
      contract: await persistedMappingContract(),
      payload: {
        ...fixture,
        observationId: "chunk-A",
        externalKey: "chunk-A",
        sourceUrl: "https://synthetic.invalid/source/chunk-A",
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:synthetic-493958" }],
        sourcePayload: { ...fixture.sourcePayload, syntheticLargeEvidence: "x".repeat(500000) },
      },
      observedAt: "2026-10-10T00:00:00.000Z",
    });
    if (!mapped.observation) throw new Error("Chunk fixture did not map");
    const events = decideSourceObservation(initialSourceObservationState, {
      type: "RecordSourceObservation",
      ...mapped.observation,
    });
    expect(events.length).toBeGreaterThan(1);
    await createPostgresEventStore({ pool }).appendToStream({
      streamId: "catalog.source-observation-chunk-A",
      expectedVersion: 0,
      context,
      events: events.slice(0, -1).map(createPassthroughDomainEventCodec<SourceObservationEvent>().encode),
    });
    await record("chunk-B");
    await expect(services.sourceObservations.promoteObservation({ observationId: "chunk-B", context })).rejects.toThrow(
      "promotion-target-incomplete-source",
    );
    expect(await itemCreations()).toHaveLength(0);
  });

  it("refuses conflicting source terminal targets before any item effects", async () => {
    const observation = await record("terminal-source");
    const store = createPostgresEventStore({ pool });
    const streamId = "catalog.source-observation-terminal-source";
    const history = await readCompleteStream(store, { streamId });
    await store.appendToStream({
      streamId,
      expectedVersion: history.length,
      context,
      events: ["cat_synthetic_one", "cat_synthetic_two"].map((catalogItemId) => ({
        eventType: "catalog.source-observation.promoted",
        payload: {
          catalogItemId,
          promotedAt: "2026-10-10T00:00:00.000Z",
          promotionProfileKey: observation.sourceProfileKey,
          promotionProfileVersion: observation.sourceProfileVersion,
          promotionPlanFingerprint: "a".repeat(64),
        },
      })),
    });
    await expect(
      services.sourceObservations.promoteObservation({ observationId: "terminal-source", context }),
    ).rejects.toThrow("promotion-target-conflicting-source-terminal");
    expect(await itemCreations()).toHaveLength(0);
  });

  it.each(["unknown-version", "malformed-execution"])(
    "refuses %s binding records rather than reclaiming their keys",
    async (poison) => {
      await record("binding-poison");
      const key = { level: "member", observationId: "binding-poison" } as const;
      await createPostgresEventStore({ pool }).appendToStream({
        streamId: promotionTargetBindingStream(key),
        expectedVersion: 0,
        context,
        events: [
          {
            eventType: "catalog.promotion-target.bound",
            payload: {
              version: poison === "unknown-version" ? 3 : 1,
              key,
              targetId: "cat_synthetic_poison",
              operationId: "synthetic-poison",
              generation: 1,
              ...(poison === "malformed-execution"
                ? { execution: { planFingerprint: "a".repeat(64), baselineVersion: "0", batches: [] } }
                : {}),
            },
          },
        ],
      });
      await expect(
        services.sourceObservations.promoteObservation({ observationId: "binding-poison", context }),
      ).rejects.toThrow();
      expect(await itemCreations()).toHaveLength(0);
    },
  );
});
