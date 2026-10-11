import { describe, expect, it } from "vitest";
import { drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import { seedContext as context } from "../../../support/seed-support/context";
import type { CatalogItemId } from "../../../ids";
import fixture from "../api/__fixtures__/tcgdex/normal.json";
import { normalizeCatalogProviderSourceObservation } from "../api/promotion/provider-source-observation-normalizer";
import {
  loadCatalogItemPromotionProfile,
  previewCatalogItemPromotionPlan,
} from "../api/source-observation-promotion-execution";
import { locatePromotionReferenceStreams } from "../api/promotion/promotion-reference-locator";
import { promotionTargetBindingStream } from "../api/promotion/promotion-target-identity";
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
import { decideSourceObservation, initialSourceObservationState, type SourceObservationEvent } from "../domain/domain";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { usePromotionTargetExclusionFixture } from "./promotion-target-exclusion-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for promotion target exclusion DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("promotion target exclusion through real Catalog services", () => {
  let pool: PgTransactionalPool;
  let services: CatalogServices;
  const { persistedMappingContract, record, retainedPlan, itemCreations } = usePromotionTargetExclusionFixture(
    databaseBaseUrl,
    (fresh) => {
      ({ pool, services } = fresh);
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
