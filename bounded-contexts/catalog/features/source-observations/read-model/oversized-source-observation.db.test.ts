import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createPostgresEventStore,
  EVENT_STORE_MAX_PAYLOAD_BYTES,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
  type RecordSourceObservationCommand,
  type SourceObservationEvent,
} from "../domain/domain";
import { buildSourceObservationProjectionHandlers } from "./projection";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for oversized Source Observation database tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describeDb("oversized Source Observation event storage", () => {
  let pool: PgTransactionalPool;
  let nextEventId = 1;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["catalog"], "oversized_source_observation");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });

  beforeEach(async () => {
    nextEventId = 1;
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
  });

  afterAll(async () => closeMultiContextTestPools({ catalog: pool }));

  it("stores and replays a Fifth Dawn-sized provider document through bounded events", async () => {
    const eventStore = createPostgresEventStore({
      pool,
      now: () => "2026-07-19T12:00:00.000Z" as never,
      createEventId: () => `evt_oversized_${nextEventId++}` as never,
    });
    const { commandHandler } = createAggregateCommandHandler({
      eventStore,
      codec: createPassthroughDomainEventCodec<SourceObservationEvent>(),
      initialState: () => initialSourceObservationState,
      evolve: evolveSourceObservation,
      decide: decideSourceObservation,
    });
    const command = oversizedFifthDawnCommand();

    const result = await commandHandler({
      streamId: "catalog.source-observation-mtgjson_set_en_5DN",
      command,
      context: eventContext(),
    });

    expect(result.storedEvents.length).toBeGreaterThan(20);
    expect(result.state.sourcePayload).toEqual(command.sourcePayload);
    const storedSizes = await pool.query<{ event_type: string; payload_bytes: string }>(
      `SELECT event_type, octet_length(convert_to(payload::text, 'UTF8')) AS payload_bytes
       FROM event_store_events
       WHERE stream_id = $1
       ORDER BY stream_version`,
      ["catalog.source-observation-mtgjson_set_en_5DN"],
    );
    expect(Math.max(...storedSizes.rows.map((row) => Number(row.payload_bytes)))).toBeLessThanOrEqual(
      EVENT_STORE_MAX_PAYLOAD_BYTES,
    );
    expect(storedSizes.rows[0]?.event_type).toBe("catalog.source-observation.recorded");
    expect(
      storedSizes.rows
        .slice(1)
        .every((row) => row.event_type === "catalog.source-observation.source-payload-chunk-recorded"),
    ).toBe(true);

    const handlers = buildSourceObservationProjectionHandlers(pool);
    for (const storedEvent of result.storedEvents) {
      await handlers[storedEvent.eventType]?.({
        streamId: storedEvent.streamId,
        data: storedEvent.payload,
        timing: { recordedAt: storedEvent.recordedAt },
      } as never);
    }

    const projected = await pool.query<{ source_payload: unknown }>(
      "SELECT source_payload FROM catalog_source_observations WHERE observation_id = $1",
      [command.observationId],
    );
    expect(projected.rows[0]?.source_payload).toEqual(command.sourcePayload);
    await expect(
      pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM catalog_source_observation_payload_assemblies"),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("rejects one synthetic over-limit event without writing a stream", async () => {
    const eventStore = createPostgresEventStore({ pool });
    const streamId = "catalog.source-observation-negative-control";

    await expect(
      eventStore.appendToStream({
        streamId,
        expectedVersion: "no_stream",
        context: eventContext(),
        events: [
          {
            eventType: "catalog.source-observation.negative-control",
            payload: { providerDocument: "x".repeat(EVENT_STORE_MAX_PAYLOAD_BYTES) },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "payload_too_large",
      details: { maxPayloadBytes: EVENT_STORE_MAX_PAYLOAD_BYTES },
    });

    const count = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id = $1",
      [streamId],
    );
    expect(count.rows).toEqual([{ count: "0" }]);
  });
});

function oversizedFifthDawnCommand(): RecordSourceObservationCommand {
  return {
    type: "RecordSourceObservation",
    observationId: "mtgjson_set_en_5DN",
    providerKey: "mtgjson",
    externalKey: "set:5DN",
    sourceUrl: "https://mtgjson.com/api/v5/5DN.json",
    languageCode: "en",
    sourceRecordHash: "sha256:fifth-dawn-provider-document",
    sourceUpdatedAt: "2026-07-19T11:00:00.000Z",
    observedAt: "2026-07-19T12:00:00.000Z",
    sourceProfileKey: "mtg-set-reference-data",
    sourceProfileVersion: "2026.06.19",
    sourceMappingFingerprint: "sha256:mtg-set-reference-data",
    normalized: {
      kind: "magic-set-reference",
      tcg: "magic",
      languageCode: "en",
      name: "Fifth Dawn",
      cardNumber: null,
      setCode: "5DN",
      setName: "Fifth Dawn",
      expansionName: "Fifth Dawn",
      setId: "00000000-0000-0000-0000-0000000005dn",
      releaseDate: "2004-06-04",
      releaseYear: 2004,
      cardCount: 165,
      productLineName: "Magic: The Gathering",
      imageUrls: [],
    },
    sourcePayload: {
      code: "5DN",
      cards: Array.from({ length: 8_000 }, (_, index) => ({
        uuid: `fifth-dawn-card-${index}`,
        name: `Fifth Dawn Card ${index} λ`,
        text: "Retained provider provenance. ".repeat(5),
      })),
    },
  };
}

function eventContext(): EventStoreContext {
  return {
    tenantId: "tenant_db_proof" as never,
    audit: {
      performedByUserId: "user_db_proof" as never,
      forAccountId: "account_db_proof" as never,
    },
  };
}
