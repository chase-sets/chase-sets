import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { JsonObject } from "@chase-sets/primitives/json";
import { bootstrapContextDatabase, drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../../index";
import { createCatalogServices } from "../../../../support/authoring-support/services";
import { seedCatalogDatabase } from "../../../../support/authoring-support/seed";
import { seedContext } from "../../../../support/seed-support/context";
import { localizedTextMapFromEnglish } from "../../../../support/runtime-support/common";
import type { BlueprintId, CatalogItemId, CategoryId, DisplayTemplateId, FieldId } from "../../../../ids";
import { seedCatalogItems } from "../../../catalog-items/api/seed";
import { seedReferenceData } from "../../../reference-data/api/seed";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
  type SourceObservationCommand,
  type SourceObservationEvent,
  type SourceObservationState,
} from "../../domain/domain";
import {
  buildCatalogBrowserE2ePromotedObservationSeedEvidence,
  catalogBrowserE2ePromotedObservation,
  diagnoseSeedStateDivergence,
  seedPromotedSourceObservationScenario,
} from "./seed";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for Source Observation seed database tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const observationStreamId = `catalog.source-observation-${catalogBrowserE2ePromotedObservation.observationId}`;

type StoredEventInput = Readonly<{ eventType: string; payload: JsonObject }>;

describeDb("promoted Source Observation scenario seed database lifecycle", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "catalog_scenario_observation_seed");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
  });

  afterAll(async () => closeMultiContextTestPools({ catalog: pool }));

  async function historicalMigrationFixture() {
    await seedCatalogDatabase(pool, undefined, { enabledDataProfiles: ["catalog-integration-bootstrap"] });
    const services = createCatalogServices(pool);
    const blueprints = await pool.query<{ key: string; blueprint_id: BlueprintId }>(
      "SELECT key, blueprint_id FROM catalog_blueprints",
    );
    const fields = await pool.query<{ key: string; field_id: FieldId }>("SELECT key, field_id FROM catalog_fields");
    const categories = await pool.query<{ key: string; category_id: CategoryId }>(
      "SELECT key, category_id FROM catalog_categories",
    );
    await seedCatalogItems(
      services,
      Object.fromEntries(blueprints.rows.map((row) => [row.key, row.blueprint_id])),
      Object.fromEntries(fields.rows.map((row) => [row.key, row.field_id])),
      Object.fromEntries(categories.rows.map((row) => [row.key, row.category_id])),
      await seedReferenceData(services),
      {
        catalogItemIds: [catalogSeedIds.items.pikachuJungle as CatalogItemId],
        beforePublication: async () => {
          await drainLocalProjectionHandlerSets("catalog", pool, services.projectors);
        },
      },
    );
    await drainLocalProjectionHandlerSets("catalog", pool, services.projectors);
    const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence(pool);
    expect(evidence.promotionPlan.planFingerprint).toBe(
      "9ec3a12b68c7f1945da0089934ddc97ccc956d5a799c98d2cb8d9c61614ad90c",
    );
    const record = commandEvents(evidence.recordCommand);
    const promotion = commandEvents(
      {
        ...evidence.promotionCommand,
        promotionPlanFingerprint: "f0d75b34e937923016ba19fad5b9b611e101d8e31b8cbe2176e26aadaf4de599",
      },
      record.state,
    );
    await appendObservationHistory(pool, [...record.events, ...promotion.events]);
    await drainLocalProjectionHandlerSets("catalog", pool, services.sourceObservations.projectors);
    return { services, evidence };
  }

  async function completeEventRows(streamId: string) {
    return (
      await pool.query<{ row_json: string }>(
        "SELECT row_to_json(t)::text AS row_json FROM event_store_events t WHERE stream_id=$1 ORDER BY stream_version",
        [streamId],
      )
    ).rows;
  }

  it("migrates historical plan evidence once and resumes after append committed before projection", async () => {
    const { services } = await historicalMigrationFixture();
    const original = await completeEventRows(observationStreamId);
    const targetStream = `catalog.item-${catalogSeedIds.items.pikachuJungle}`;
    const targetBefore = await completeEventRows(targetStream);
    const summaryBefore = (await pool.query("SELECT * FROM catalog_source_observation_integration_scope_summaries"))
      .rows;
    const commandHandler = services.sourceObservations.commandHandler;
    const interrupted = {
      ...services,
      sourceObservations: {
        ...services.sourceObservations,
        commandHandler: async (input: Parameters<typeof commandHandler>[0]) => {
          expect(input.expectedVersion).toBe(2);
          await commandHandler(input);
          throw new Error("synthetic lost acknowledgement after commit");
        },
      },
    };
    await expect(seedPromotedSourceObservationScenario(interrupted)).rejects.toThrow(
      "synthetic lost acknowledgement after commit",
    );
    expect(await observationEventCount(pool)).toBe(3);
    expect((await projectedObservation(pool))?.promotion_plan_fingerprint).toBe(
      "f0d75b34e937923016ba19fad5b9b611e101d8e31b8cbe2176e26aadaf4de599",
    );
    await seedPromotedSourceObservationScenario(services);
    await drainLocalProjectionHandlerSets("catalog", pool, services.sourceObservations.projectors);
    await seedPromotedSourceObservationScenario(services);
    await drainLocalProjectionHandlerSets("catalog", pool, services.sourceObservations.projectors);
    const after = await completeEventRows(observationStreamId);
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2)).toEqual(original);
    expect(JSON.parse(after[2]!.row_json).event_type).toBe("catalog.source-observation.promotion-plan-recorded");
    expect(await completeEventRows(targetStream)).toEqual(targetBefore);
    expect(await projectedObservation(pool)).toMatchObject({
      status: "promoted",
      promotion_plan_fingerprint: "9ec3a12b68c7f1945da0089934ddc97ccc956d5a799c98d2cb8d9c61614ad90c",
    });
    expect((await pool.query("SELECT * FROM catalog_source_observation_integration_scope_summaries")).rows).toEqual(
      summaryBefore,
    );
    expect(
      (await pool.query("SELECT * FROM event_projection_poison_events WHERE stream_id=$1", [observationStreamId])).rows,
    ).toEqual([]);
    expect(
      (await pool.query("SELECT * FROM event_projection_blocked_streams WHERE stream_id=$1", [observationStreamId]))
        .rows,
    ).toEqual([]);
    const applications = await pool.query<{ count: string; distinct_events: string }>(
      "SELECT count(*)::text AS count, count(DISTINCT event_id)::text AS distinct_events FROM event_subscription_applications WHERE stream_id=$1",
      [observationStreamId],
    );
    expect(applications.rows).toEqual([{ count: "3", distinct_events: "3" }]);
    const orphans = await pool.query(
      "SELECT a.event_id FROM event_subscription_applications a LEFT JOIN event_store_events e ON e.event_id=a.event_id WHERE a.stream_id=$1 AND e.event_id IS NULL",
      [observationStreamId],
    );
    expect(orphans.rows).toEqual([]);
    const outbox = await pool.query<{ count: string; distinct_positions: string }>(
      `SELECT count(*)::text AS count, count(DISTINCT source_global_position)::text AS distinct_positions
       FROM realtime_projection_outbox
       WHERE projection_name='catalog-source-observation-projection'
       AND source_global_position IN (SELECT global_position FROM event_store_events WHERE stream_id=$1)`,
      [observationStreamId],
    );
    expect(outbox.rows).toEqual([{ count: "3", distinct_positions: "3" }]);
    const promoted = await pool.query<{ promoted_at: string }>(
      "SELECT promoted_at FROM catalog_source_observations WHERE observation_id=$1",
      [catalogBrowserE2ePromotedObservation.observationId],
    );
    expect(new Date(promoted.rows[0]!.promoted_at).toISOString()).toBe("2026-06-03T00:01:00.000Z");
    await seedCatalogDatabase(pool, undefined, { enabledDataProfiles: ["scenario-seed"] });
    expect(await completeEventRows(observationStreamId)).toEqual(after);
    expect(await completeEventRows(targetStream)).toEqual(targetBefore);
  });

  it("keeps the historical stream on append failure and completes through normal seed re-entry", async () => {
    const { services } = await historicalMigrationFixture();
    const before = await completeEventRows(observationStreamId);
    await pool.query(`ALTER TABLE event_store_events ADD CONSTRAINT synthetic_migration_append_failure
      CHECK (event_type <> 'catalog.source-observation.promotion-plan-recorded')`);
    await expect(seedPromotedSourceObservationScenario(services)).rejects.toMatchObject({
      code: "infrastructure_failure",
      details: { cause: expect.stringContaining("synthetic_migration_append_failure") },
    });
    expect(await completeEventRows(observationStreamId)).toEqual(before);
    expect(
      (
        await pool.query<{ current_version: string }>(
          "SELECT current_version::text FROM event_store_streams WHERE stream_id=$1",
          [observationStreamId],
        )
      ).rows,
    ).toEqual([{ current_version: "2" }]);
    await pool.query("ALTER TABLE event_store_events DROP CONSTRAINT synthetic_migration_append_failure");
    await seedCatalogDatabase(pool, undefined, { enabledDataProfiles: ["scenario-seed"] });
    const after = await completeEventRows(observationStreamId);
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2)).toEqual(before);
  });

  it("refuses a concurrent append between predecessor proof and command commit", async () => {
    const { services, evidence } = await historicalMigrationFixture();
    const commandHandler = services.sourceObservations.commandHandler;
    const original = await completeEventRows(observationStreamId);
    const competingCommand: SourceObservationCommand = {
      ...evidence.promotionCommand,
      type: "RecordSourceObservationPromotionPlan",
      promotionPlanFingerprint: "synthetic-competing-plan",
    };
    const competing = {
      ...services,
      sourceObservations: {
        ...services.sourceObservations,
        commandHandler: async (input: Parameters<typeof commandHandler>[0]) => {
          await commandHandler({ ...input, command: competingCommand, expectedVersion: 2 });
          return commandHandler(input);
        },
      },
    };
    await expect(seedPromotedSourceObservationScenario(competing)).rejects.toMatchObject({
      code: "concurrency_conflict",
    });
    const after = await completeEventRows(observationStreamId);
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2)).toEqual(original);
    expect(JSON.parse(after[2]!.row_json).payload.promotionPlanFingerprint).toBe("synthetic-competing-plan");
    await expect(seedPromotedSourceObservationScenario(services)).rejects.toThrow();
    expect(await completeEventRows(observationStreamId)).toEqual(after);
  });

  it.each([
    {
      profile: "catalog-integration-bootstrap",
      expectedStreamId: `catalog.display-template-${catalogSeedIds.displayTemplates.pokemonSingleCardDefault}`,
      expectedEventType: "catalog.display-template.published",
    },
    {
      profile: "scenario-seed",
      expectedStreamId: `catalog.item-${catalogSeedIds.items.pikachuJungle}`,
      expectedEventType: "catalog.catalog-item.published",
    },
    {
      profile: "representative-commerce-state",
      expectedStreamId: `catalog.item-${catalogSeedIds.items.pikachuPrismaticEvolutions}`,
      expectedEventType: "catalog.catalog-item.published",
    },
  ] as const)(
    "exercises the seedCatalogDatabase $profile path through its expected durable stream",
    async ({ profile, expectedStreamId, expectedEventType }) => {
      await seedCatalogDatabase(pool, undefined, { enabledDataProfiles: [profile] });

      const events = await pool.query<{ event_type: string }>(
        `SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version ASC`,
        [expectedStreamId],
      );
      expect(events.rows.map((row) => row.event_type)).toContain(expectedEventType);
    },
  );

  for (const initialHistory of ["empty", "recorded-only"] as const) {
    it(`converges ${initialHistory} history and preserves one record plus one promotion across repeats`, async () => {
      const services = createCatalogServices(pool);
      await appendCatalogItemLifecycle(pool, services, catalogSeedIds.items.pikachuJungle);
      const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence(pool);
      if (initialHistory === "recorded-only") {
        await appendObservationHistory(pool, commandEvents(evidence.recordCommand).events);
      }

      await seedPromotedSourceObservationScenario(services);
      await seedPromotedSourceObservationScenario(services);
      await drainLocalProjectionHandlerSets("catalog", pool, services.sourceObservations.projectors);

      const events = await pool.query<{ event_type: string }>(
        `SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version ASC`,
        [observationStreamId],
      );
      expect(events.rows.map((row) => row.event_type)).toEqual([
        "catalog.source-observation.recorded",
        "catalog.source-observation.promoted",
      ]);
      const row = await projectedObservation(pool);
      expect(row).toMatchObject({
        observation_id: catalogBrowserE2ePromotedObservation.observationId,
        status: "promoted",
        promoted_catalog_item_id: catalogSeedIds.items.pikachuJungle,
        source_record_hash: "33176435566a66d6f02e6d9a2e61716cc1d7d3dc51d945e5a4a2a708365065c4",
        promotion_plan_fingerprint: evidence.promotionCommand.promotionPlanFingerprint,
      });
    });
  }

  const poisonCases = [
    "promoted-only",
    "terminal",
    "unexpected",
    "mismatched-identity",
    "mismatched-facts",
    "mismatched-target",
    "mismatched-profile",
    "mismatched-fingerprint",
  ] as const;

  for (const poisonCase of poisonCases) {
    it(`fails deterministically for ${poisonCase} history and does not append a repair promotion`, async () => {
      const services = createCatalogServices(pool);
      await appendCatalogItemLifecycle(pool, services, catalogSeedIds.items.pikachuJungle);
      const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence(pool);
      const history = poisonedHistory(poisonCase, evidence.recordCommand, evidence.promotionCommand);
      await appendObservationHistory(pool, history);
      const countBefore = await observationEventCount(pool);

      await expect(seedPromotedSourceObservationScenario(services)).rejects.toThrow(
        /cannot reconcile lifecycle|cannot rehydrate|mismatched identity, facts, target, profile, terminal state, or fingerprint|unexpected event/,
      );
      expect(await observationEventCount(pool)).toBe(countBefore);

      await drainLocalProjectionHandlerSets("catalog", pool, services.sourceObservations.projectors);
      const row = await projectedObservation(pool);
      switch (poisonCase) {
        case "promoted-only":
          expect(row).toBeUndefined();
          break;
        case "mismatched-target":
          expect(row).toMatchObject({ status: "promoted", promoted_catalog_item_id: "cat_seed_missing_target" });
          break;
        case "mismatched-fingerprint":
          expect(row).toMatchObject({
            status: "promoted",
            promoted_catalog_item_id: catalogSeedIds.items.pikachuJungle,
            promotion_plan_fingerprint: "f".repeat(64),
          });
          break;
        case "terminal":
          expect(row).toMatchObject({ status: "rejected", promoted_catalog_item_id: null });
          break;
        default:
          expect(row).toMatchObject({ status: "observed", promoted_catalog_item_id: null });
      }
    });
  }

  it("older-revision promoted stream reconciles or refuses naming the differing field path", async () => {
    const services = createCatalogServices(pool);
    await appendCatalogItemLifecycle(pool, services, catalogSeedIds.items.pikachuJungle);
    const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence(pool);
    const recorded = commandEvents(evidence.recordCommand);
    const record = recorded.events[0]!;
    const promoted = commandEvents(evidence.promotionCommand, recorded.state).events[0]!;

    // An older fixture revision wrote the same source revision tuple with stale normalized facts, so
    // replaying the fixture's record command emits one refresh that carries the promotion forward.
    await appendObservationHistory(pool, [
      mutateEvent(record, { normalized: { ...(record.payload.normalized as JsonObject), name: "Raichu" } }),
      promoted,
    ]);

    await seedPromotedSourceObservationScenario(services);
    await seedPromotedSourceObservationScenario(services);
    await drainLocalProjectionHandlerSets("catalog", pool, services.sourceObservations.projectors);

    const reconciled = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version ASC`,
      [observationStreamId],
    );
    expect(reconciled.rows.map((row) => row.event_type)).toEqual([
      "catalog.source-observation.recorded",
      "catalog.source-observation.promoted",
      "catalog.source-observation.refreshed",
    ]);
    expect(await projectedObservation(pool)).toMatchObject({
      status: "promoted",
      promoted_catalog_item_id: catalogSeedIds.items.pikachuJungle,
      promotion_plan_fingerprint: evidence.promotionCommand.promotionPlanFingerprint,
    });

    // Promotion-side drift cannot be reconciled without promoting twice, so it is refused by name.
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
    const refusingServices = createCatalogServices(pool);
    await appendCatalogItemLifecycle(pool, refusingServices, catalogSeedIds.items.pikachuJungle);
    await appendObservationHistory(pool, [record, mutateEvent(promoted, { promotionPlanFingerprint: "f".repeat(64) })]);
    const countBefore = await observationEventCount(pool);

    await expect(seedPromotedSourceObservationScenario(refusingServices)).rejects.toThrow(
      "at field path 'promotionPlanFingerprint'",
    );
    expect(await observationEventCount(pool)).toBe(countBefore);
  });

  it("promotion fingerprint refusal names expected and actual bounded scalar values", async () => {
    const services = createCatalogServices(pool);
    await appendCatalogItemLifecycle(pool, services, catalogSeedIds.items.pikachuJungle);
    const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence(pool);
    const recorded = commandEvents(evidence.recordCommand);
    const promoted = commandEvents(evidence.promotionCommand, recorded.state).events[0]!;
    const recordedFingerprint = "f".repeat(64);
    await appendObservationHistory(pool, [
      recorded.events[0]!,
      mutateEvent(promoted, { promotionPlanFingerprint: recordedFingerprint }),
    ]);
    const countBefore = await observationEventCount(pool);

    await expect(seedPromotedSourceObservationScenario(services)).rejects.toThrow(
      `at field path 'promotionPlanFingerprint' (expected ${JSON.stringify(evidence.promotionCommand.promotionPlanFingerprint)}, actual ${JSON.stringify(recordedFingerprint)})`,
    );
    expect(await observationEventCount(pool)).toBe(countBefore);
  });

  it("promotion fingerprint refusal marks a truncated scalar without printing the full value", async () => {
    const services = createCatalogServices(pool);
    await appendCatalogItemLifecycle(pool, services, catalogSeedIds.items.pikachuJungle);
    const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence(pool);
    const recorded = commandEvents(evidence.recordCommand);
    const promoted = commandEvents(evidence.promotionCommand, recorded.state).events[0]!;
    const longFingerprint = "f".repeat(128);
    await appendObservationHistory(pool, [
      recorded.events[0]!,
      mutateEvent(promoted, { promotionPlanFingerprint: longFingerprint }),
    ]);
    const countBefore = await observationEventCount(pool);

    await expect(seedPromotedSourceObservationScenario(services)).rejects.toThrow(
      `at field path 'promotionPlanFingerprint' (expected ${JSON.stringify(evidence.promotionCommand.promotionPlanFingerprint)}, actual ${JSON.stringify("f".repeat(96))}[truncated])`,
    );
    expect(await observationEventCount(pool)).toBe(countBefore);
  });

  it("requireSeedState mutant that accepts any state fails the poison matrix", async () => {
    const services = createCatalogServices(pool);
    await appendCatalogItemLifecycle(pool, services, catalogSeedIds.items.pikachuJungle);
    const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence(pool);
    const expectedRecordedState = commandEvents(evidence.recordCommand).state;
    const expectedPromotedState = commandEvents(evidence.promotionCommand, expectedRecordedState).state;
    // The mutation the matrix has to kill: a state guard that accepts every rehydrated history.
    const acceptAnySeedState = (): string | null => null;
    const expectedFieldPaths: Record<string, string> = {
      "mismatched-identity": "externalKey",
      "mismatched-facts": "normalized.name",
      "mismatched-target": "promotedCatalogItemId",
      "mismatched-profile": "sourceProfileVersion",
      "mismatched-fingerprint": "promotionPlanFingerprint",
    };

    const heldOnlyByStateGuard: string[] = [];
    for (const poisonCase of poisonCases) {
      const history = poisonedHistory(poisonCase, evidence.recordCommand, evidence.promotionCommand);
      const lifecycle = history.map((event) => event.eventType);
      const recordedOnly = isSeedLifecycle(lifecycle, ["catalog.source-observation.recorded"]);
      const promotedLifecycle = isSeedLifecycle(lifecycle, [
        "catalog.source-observation.recorded",
        "catalog.source-observation.promoted",
      ]);
      if (!recordedOnly && !promotedLifecycle) {
        continue;
      }

      heldOnlyByStateGuard.push(poisonCase);
      const expectedState = recordedOnly ? expectedRecordedState : expectedPromotedState;
      expect(diagnoseSeedStateDivergence(replayStoredEvents(history), expectedState)).toBe(
        expectedFieldPaths[poisonCase],
      );
      expect(acceptAnySeedState()).toBeNull();
    }

    // Every one of these lifecycles is legal, so only the state guard rejects them; the mutant above
    // would take each poisoned history as the seeded state and turn these matrix rows green on poison.
    expect(heldOnlyByStateGuard).toEqual([
      "mismatched-identity",
      "mismatched-facts",
      "mismatched-target",
      "mismatched-profile",
      "mismatched-fingerprint",
    ]);

    await appendObservationHistory(
      pool,
      poisonedHistory("mismatched-target", evidence.recordCommand, evidence.promotionCommand),
    );
    await expect(seedPromotedSourceObservationScenario(services)).rejects.toThrow(
      "at field path 'promotedCatalogItemId'",
    );
  });

  it("fails before observation append when another Catalog Item exists but the exact target is absent", async () => {
    const services = createCatalogServices(pool);
    await appendCatalogItemLifecycle(pool, services, "cat_seed_other_item");

    await expect(seedPromotedSourceObservationScenario(services)).rejects.toThrow(
      `requires active Catalog Item '${catalogSeedIds.items.pikachuJungle}' in its exact event stream and projection`,
    );
    expect(await observationEventCount(pool)).toBe(0);
  });

  it("repairs the exact target through the sibling scenario seed even when another Catalog Item already exists", async () => {
    const services = createCatalogServices(pool);
    await appendCatalogItemLifecycle(pool, services, "cat_seed_other_item");

    await seedCatalogDatabase(pool, undefined, { enabledDataProfiles: ["scenario-seed"] });
    const refreshedServices = createCatalogServices(pool);
    await drainLocalProjectionHandlerSets("catalog", pool, refreshedServices.sourceObservations.projectors);

    const target = await pool.query<{ status: string }>("SELECT status FROM catalog_items WHERE catalog_item_id = $1", [
      catalogSeedIds.items.pikachuJungle,
    ]);
    expect(target.rows).toEqual([{ status: "active" }]);
    expect(await projectedObservation(pool)).toMatchObject({
      status: "promoted",
      promoted_catalog_item_id: catalogSeedIds.items.pikachuJungle,
    });
  });
});

function poisonedHistory(
  poisonCase:
    | "promoted-only"
    | "terminal"
    | "unexpected"
    | "mismatched-identity"
    | "mismatched-facts"
    | "mismatched-target"
    | "mismatched-profile"
    | "mismatched-fingerprint",
  recordCommand: Extract<SourceObservationCommand, { type: "RecordSourceObservation" }>,
  promotionCommand: Extract<SourceObservationCommand, { type: "PromoteSourceObservation" }>,
): readonly StoredEventInput[] {
  const recorded = commandEvents(recordCommand);
  const promoted = commandEvents(promotionCommand, recorded.state).events[0]!;
  const record = recorded.events[0]!;

  switch (poisonCase) {
    case "promoted-only":
      return [promoted];
    case "terminal":
      return [
        record,
        ...commandEvents({ type: "RejectSourceObservation", reason: "terminal negative control" }, recorded.state)
          .events,
      ];
    case "unexpected":
      return [record, { eventType: "catalog.source-observation.unexpected", payload: { reason: "negative control" } }];
    case "mismatched-identity":
      return [mutateEvent(record, { externalKey: "legacy-key" })];
    case "mismatched-facts":
      return [
        mutateEvent(record, {
          normalized: { ...(record.payload.normalized as JsonObject), name: "Raichu" },
        }),
      ];
    case "mismatched-target":
      return [record, mutateEvent(promoted, { catalogItemId: "cat_seed_missing_target" })];
    case "mismatched-profile":
      return [mutateEvent(record, { sourceProfileVersion: "2026.05.legacy" })];
    case "mismatched-fingerprint":
      return [record, mutateEvent(promoted, { promotionPlanFingerprint: "f".repeat(64) })];
  }
}

function commandEvents(
  command: SourceObservationCommand,
  initial: SourceObservationState = initialSourceObservationState,
) {
  const domainEvents = decideSourceObservation(initial, command);
  let state = initial;
  const events = domainEvents.map((event) => {
    state = evolveSourceObservation(state, event);
    return { eventType: event.type, payload: event.data as JsonObject };
  });
  return { events, state };
}

function mutateEvent(event: StoredEventInput, patch: JsonObject): StoredEventInput {
  return { ...event, payload: { ...event.payload, ...patch } };
}

async function appendObservationHistory(pool: PgTransactionalPool, events: readonly StoredEventInput[]): Promise<void> {
  if (events.length === 0) {
    return;
  }
  await createPostgresEventStore({ pool }).appendToStream({
    streamId: observationStreamId,
    expectedVersion: "no_stream",
    context: seedContext,
    events,
  });
}

async function appendCatalogItemLifecycle(
  pool: PgTransactionalPool,
  services: ReturnType<typeof createCatalogServices>,
  catalogItemId: string,
): Promise<void> {
  await createPostgresEventStore({ pool }).appendToStream({
    streamId: `catalog.item-${catalogItemId}`,
    expectedVersion: "no_stream",
    context: seedContext,
    events: [
      {
        eventType: "catalog.catalog-item.created",
        payload: {
          itemId: catalogItemId,
          languageCode: "en",
          title: { defaultLocale: "en", values: { en: catalogItemId } },
          subtitle: { defaultLocale: "en", values: { en: "" } },
          description: { defaultLocale: "en", values: { en: "" } },
        },
      },
      { eventType: "catalog.catalog-item.published", payload: {} },
    ],
  });
  await drainLocalProjectionHandlerSets("catalog", pool, services.items.projectors);
  await publishGlobalTitleDisplayTemplate(pool, services);
}

// The exact identity prerequisite the promotion seed now validates: the bare
// lifecycle item resolves through a published global title template. Without
// it the seed's refresh plan is blocked as `display-identity-unresolvable`.
async function publishGlobalTitleDisplayTemplate(
  pool: PgTransactionalPool,
  services: ReturnType<typeof createCatalogServices>,
): Promise<void> {
  const displayTemplateId = "dtp_01SEEDDBTESTGLOBALTITLE0000" as DisplayTemplateId;
  const streamId = `catalog.display-template-${displayTemplateId}`;
  const existing = await pool.query("SELECT 1 FROM event_store_events WHERE stream_id = $1 LIMIT 1", [streamId]);
  if ((existing.rowCount ?? 0) === 0) {
    await services.displayTemplates.commandHandler({
      streamId,
      command: {
        type: "CreateDisplayTemplate",
        displayTemplateId,
        key: "seed-db-test-global-title",
        name: localizedTextMapFromEnglish("Seed DB test global title"),
        description: localizedTextMapFromEnglish(""),
        target: { kind: "global" },
        priority: 0,
        titleTemplate: "{item.title}",
        subtitleTemplate: null,
      },
      context: seedContext,
    });
    await services.displayTemplates.commandHandler({
      streamId,
      command: { type: "PublishDisplayTemplate" },
      context: seedContext,
    });
  }
  await drainLocalProjectionHandlerSets("catalog", pool, services.displayTemplates.projectors);
}

async function projectedObservation(pool: PgTransactionalPool) {
  const result = await pool.query<{
    observation_id: string;
    status: string;
    promoted_catalog_item_id: string | null;
    source_record_hash: string;
    promotion_plan_fingerprint: string | null;
  }>(
    `SELECT observation_id, status, promoted_catalog_item_id, source_record_hash, promotion_plan_fingerprint
       FROM catalog_source_observations
       WHERE observation_id = $1`,
    [catalogBrowserE2ePromotedObservation.observationId],
  );
  return result.rows[0];
}

async function observationEventCount(pool: PgTransactionalPool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id = $1",
    [observationStreamId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function isSeedLifecycle(lifecycle: readonly string[], expected: readonly string[]): boolean {
  return lifecycle.length === expected.length && lifecycle.every((eventType, index) => eventType === expected[index]);
}

function replayStoredEvents(events: readonly StoredEventInput[]): SourceObservationState {
  return events.reduce<SourceObservationState>(
    (state, event) =>
      evolveSourceObservation(state, { type: event.eventType, data: event.payload } as SourceObservationEvent),
    initialSourceObservationState,
  );
}
