import { describe, expect, it } from "vitest";
import {
  createPostgresEventStore,
  type PgQueryable,
  type PgPoolClient,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import { seedContext as context } from "../../../support/seed-support/context";
import type { CatalogItemId } from "../../../ids";
import fixture from "../api/__fixtures__/tcgdex/normal.json";
import { normalizeCatalogProviderSourceObservation } from "../api/promotion/provider-source-observation-normalizer";
import { locatePromotionReferenceStreams } from "../api/promotion/promotion-reference-locator";
import {
  createPostgresPromotionTargetExclusion,
  type PromotionTargetAuthority,
} from "../api/promotion/promotion-target-exclusion";
import {
  promotionTargetBindingStream,
  retainedPromotionTargetBindingStream,
} from "../api/promotion/promotion-target-identity";
import { decideSourceObservation, initialSourceObservationState, type SourceObservationEvent } from "../domain/domain";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  decideCatalogItem,
  evolveCatalogItem,
  initialCatalogItemState,
  type CatalogItemCommand,
  type CatalogItemEvent,
} from "../../catalog-items/domain/domain";
import { usePromotionTargetExclusionFixture } from "./promotion-target-exclusion-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for promotion target exclusion DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("promotion target exclusion through real Catalog services", () => {
  let pool: PgTransactionalPool;
  let services: CatalogServices;
  const { persistedMappingContract, record, retainedPlan, itemCreations, boundary, acquire } =
    usePromotionTargetExclusionFixture(databaseBaseUrl, (fresh) => {
      ({ pool, services } = fresh);
    });

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
});
