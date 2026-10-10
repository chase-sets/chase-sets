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
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { module as catalogModule } from "../../../index";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import { seedCatalogDatabase } from "../../../support/authoring-support/seed";
import { seedContext as context } from "../../../support/seed-support/context";
import type { CatalogItemId, DimensionId, OptionId } from "../../../ids";
import fixture from "../api/__fixtures__/tcgdex/normal.json";
import productFixture from "../api/__fixtures__/tcgplayer-pokemon-sealed-product/normal.json";
import { tcgplayerPokemonSealedProductSourceObservationMappingContract } from "../api/providers/tcgplayer/executable-mapping-contract";
import { tcgdexPokemonCardSourceObservationMappingContract } from "../api/tcgdex-executable-mapping-contract";
import { normalizeCatalogProviderSourceObservation } from "../api/promotion/provider-source-observation-normalizer";
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
} from "../api/promotion/promotion-target-indexes";
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
import {
  discoverPromotionTargets,
  locatedPromotionSourceTargets,
  foldPromotionTargetItem,
} from "../api/promotion/promotion-target-discovery";
import {
  resolveCatalogProviderDuplicatePrevention,
  type CatalogProviderDuplicatePreventionDb,
} from "../api/promotion/provider-duplicate-prevention-resolver";
import {
  canonicalPromotionReferenceText,
  promotionReferenceTrimCharacters,
} from "../api/promotion/promotion-reference-canonicalization";
import {
  promotionLowercaseRanges,
  promotionCasedRanges,
  promotionCaseIgnorableRanges,
} from "../api/promotion/promotion-reference-casing-data";
import { promotionCurrentItem } from "../api/promotion/source-observation-target-exclusion";
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

  async function record(id: string, reference = "product:493958", overrides: Partial<typeof fixture> = {}) {
    const mapped = normalizeCatalogProviderSourceObservation({
      contract: await persistedMappingContract(),
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

  it("proves pinned SQL casing bytes against JavaScript, including contextual and expanding mappings", async () => {
    const vectors = new Set([
      "",
      "\u0130",
      "A\u03a3",
      "A\u03a3A",
      "A'\u03a3\u0301",
      "\u1e9e",
      "ss",
      "\u00c9",
      "E\u0301",
      `${promotionReferenceTrimCharacters}MiXeD${promotionReferenceTrimCharacters}`,
      "\u0130".repeat(2048),
    ]);
    for (const [first, last, stride] of promotionLowercaseRanges)
      for (let point = first; point <= last; point += stride) vectors.add(String.fromCodePoint(point));
    for (const [first, last] of [...promotionCasedRanges, ...promotionCaseIgnorableRanges]) {
      for (const point of [first - 1, first, last, last + 1]) {
        if (point < 1 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) continue;
        const char = String.fromCodePoint(point);
        vectors.add(`A${char}\u03a3`);
        vectors.add(`A\u03a3${char}A`);
      }
    }
    const all = [...vectors];
    for (let start = 0; start < all.length; start += 500) {
      const batch = all.slice(start, start + 500);
      const result = await pool.query<{ value: string; bytes: string }>(
        "SELECT value, encode(convert_to(catalog_promotion_reference_text_v1(value), 'UTF8'), 'hex') AS bytes FROM unnest($1::text[]) AS value",
        [batch],
      );
      expect(result.rows).toHaveLength(batch.length);
      for (const row of result.rows)
        expect(row.bytes, JSON.stringify(row.value)).toBe(
          Buffer.from(canonicalPromotionReferenceText(row.value)).toString("hex"),
        );
    }
    expect((await pool.query("SELECT catalog_promotion_reference_text_v1(NULL) AS value")).rows).toEqual([
      { value: null },
    ]);
    const normalized = {
      externalCatalogItemReferences: [
        { providerKey: " A ", externalKey: " B " },
        { providerKey: 1, externalKey: "bad" },
      ],
      externalProductReferences: [{ providerKey: "A", externalKey: "B", selectedOptions: [] }],
      malformedSurroundingEvidence: true,
    };
    expect(
      (
        await pool.query<{ pairs: unknown }>("SELECT catalog_promotion_reference_pairs_v1($1::jsonb) AS pairs", [
          JSON.stringify(normalized),
        ])
      ).rows[0].pairs,
    ).toEqual({
      externalCatalogItemReferences: [{ providerKey: "a", externalKey: "b" }],
      externalProductReferences: [{ providerKey: "a", externalKey: "b" }],
    });
  });

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
      expect(await locatePromotionReferenceStreams(pool, canonical)).toContain(streamId);
      await expect(acquire("cat_candidate_fork", [canonical])).rejects.toThrow("promotion-target-bound-elsewhere");
      const first = await acquire("cat_candidate_retained", [canonical]);
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
    const contract = await persistedMappingContract();
    await store.appendToStreams!(
      Array.from({ length: 500 }, (_, index) => {
        const id = `page-${String(index).padStart(3, "0")}`;
        const mapped = normalizeCatalogProviderSourceObservation({
          contract,
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
    expect(queries).toHaveLength(3);
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

  it.each(["linked", "unlinked", "relinked", "inactive-pinned", "inactive-released"] as const)(
    "distinguishes real retained %s history before allocating",
    async (state) => {
      const retained = await retainedPlan("lifecycle-A");
      const owner = "cat_synthetic_lifecycle" as CatalogItemId;
      for (const command of retained.plan.commands.filter(
        (command) => command.type !== "LinkExternalProductReference",
      )) {
        await services.items.commandHandler({
          streamId: `catalog.item-${owner}`,
          command: command.type === "CreateCatalogItem" ? { ...command, itemId: owner } : command,
          context,
        });
      }
      if (["unlinked", "relinked", "inactive-released"].includes(state))
        await services.items.commandHandler({
          streamId: `catalog.item-${owner}`,
          command: {
            type: "UnlinkExternalCatalogItemReference",
            providerKey: "TCGPLAYER",
            externalKey: " PRODUCT:493958 ",
          },
          context,
        });
      if (state === "relinked")
        await services.items.commandHandler({
          streamId: `catalog.item-${owner}`,
          command: {
            type: "LinkExternalCatalogItemReference",
            providerKey: "tcgplayer",
            externalKey: "product:493958",
          },
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
      if (state.startsWith("inactive"))
        expect(
          await readCompleteStream(createPostgresEventStore({ pool }), { streamId: `catalog.item-${owner}` }),
        ).toEqual(before);
    },
  );

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

  it.each(["A", "B"])(
    "independent runtimes preserve one target under frozen item projections, %s first",
    async (first) => {
      await record("A", "PRODUCT:493958");
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

  it.each(["A", "B"].flatMap((first) => [false, true].map((conflictingOptions) => ({ first, conflictingOptions }))))(
    "Product reference exclusion, $first first, conflicting Options=$conflictingOptions",
    async ({ first, conflictingOptions }) => {
      const identity = tcgplayerPokemonSealedProductSourceObservationMappingContract;
      const version = await services.providerIntegrationProfiles.getProfileVersion(
        identity.providerKey,
        identity.profileVersion,
        { profileKey: identity.profileKey },
      );
      if (!version) throw new Error("Seeded sealed-product profile is missing");
      // Give this synthetic sealed Product a real, authored Condition dimension.
      // The fixture's provider-facing optionKey is not a Catalog Option ID.
      const dimensionId = catalogSeedIds.dimensions.condition.dimensionId as DimensionId;
      const compatibleOption = catalogSeedIds.dimensions.condition.optionIds.nearMint as OptionId;
      const conflictingOption = catalogSeedIds.dimensions.condition.optionIds.good as OptionId;
      const blueprintStream = `catalog.blueprint-${catalogSeedIds.blueprints.pokemonSealedProduct}`;
      await services.blueprints.commandHandler({
        streamId: blueprintStream,
        command: {
          type: "SetBlueprintDimensions",
          dimensionRules: [{ dimensionId, required: false, allowedOptionIds: [compatibleOption, conflictingOption] }],
        },
        context,
      });
      await services.blueprints.commandHandler({
        streamId: blueprintStream,
        command: { type: "SetBlueprintProductResolutionRules", canonicalDimensionOrder: [dimensionId] },
        context,
      });
      await drainLocalProjectionHandlerSets("catalog", pool, services.blueprints.projectors);
      for (const member of ["A", "B"]) {
        const externalKey = member === "A" ? "800001" : "800002";
        const mapped = normalizeCatalogProviderSourceObservation({
          contract: requireSourceObservationMappingContract(version),
          payload: {
            ...productFixture,
            observationId: `product-${member}`,
            externalKey,
            productId: Number(externalKey),
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: `product:${externalKey}` }],
            externalProductReferences: productFixture.externalProductReferences.map((reference) => ({
              ...reference,
              externalKey: member === "A" ? reference.externalKey.toUpperCase() : reference.externalKey.toLowerCase(),
              selectedOptions: [
                {
                  dimensionId,
                  optionId: conflictingOptions && member !== first ? conflictingOption : compatibleOption,
                },
              ],
            })),
          },
          observedAt: "2026-10-10T00:00:00.000Z",
        });
        expect(mapped.diagnostics).toEqual([]);
        if (!mapped.observation) throw new Error("Sealed-product mapper produced no observation");
        expect(mapped.observation.normalized).toMatchObject({
          kind: "pokemon-sealed-product",
          externalProductReferences: [
            {
              selectedOptions: [
                {
                  dimensionId,
                  optionId: conflictingOptions && member !== first ? conflictingOption : compatibleOption,
                },
              ],
            },
          ],
        });
        await services.sourceObservations.commandHandler({
          streamId: `catalog.source-observation-product-${member}`,
          command: { type: "RecordSourceObservation", ...mapped.observation },
          context,
        });
      }
      await drainLocalProjectionHandlerSets("catalog", pool, services.sourceObservations.projectors);
      const winner = await services.sourceObservations.promoteObservation({
        observationId: `product-${first}`,
        context,
      });
      const before = await readCompleteStream(createPostgresEventStore({ pool }), {
        streamId: `catalog.item-${winner.catalogItemId}`,
      });
      const incoming = createCatalogServices(pool).sourceObservations.promoteObservation({
        observationId: `product-${first === "A" ? "B" : "A"}`,
        context,
      });
      if (conflictingOptions) {
        await expect(incoming).rejects.toThrow("promotion-target-product-options-conflict");
        expect(
          await readCompleteStream(createPostgresEventStore({ pool }), {
            streamId: `catalog.item-${winner.catalogItemId}`,
          }),
        ).toEqual(before);
      } else await expect(incoming).resolves.toMatchObject({ catalogItemId: winner.catalogItemId });
      expect(await itemCreations()).toHaveLength(1);
    },
  );

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])(
    "retained mapper-derived create boundary %s never creates a second target",
    async (boundary) => {
      const retained = await retainedPlan("retained-A", boundary >= 13 ? "PRODUCT:493958" : undefined);
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
    await record("refresh-B", "product:493958", {
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
      externalKey: "product:493958",
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
    await pool.query("DROP INDEX catalog_promotion_source_references_canonical_v1_idx");
    await expect(requirePromotionTargetIndexes(pool)).rejects.toThrow("promotion-target-index-unavailable");
    await expect(
      services.sourceObservations.promoteObservation({ observationId: "missing-index", context }),
    ).rejects.toThrow("promotion-target-index-unavailable");
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
