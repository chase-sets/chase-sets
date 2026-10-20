import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
  type SourceObservationCommand,
  type SourceObservationEvent,
  type SourceObservationState,
} from "../../domain/domain";
import {
  buildCatalogBrowserE2eChangedObservationSeedEvidence,
  buildCatalogBrowserE2ePromotedObservationSeedEvidence,
  catalogBrowserE2eChangedObservation,
  catalogBrowserE2ePromotedObservation,
  seedChangedSourceObservationScenario,
  seedPromotedSourceObservationScenario,
} from "./seed";
import {
  createSyntheticDisplayIdentityQueryable,
  syntheticCurrentCatalogItem,
} from "./synthetic-display-identity-queryable";

// Database-free evidence: a SYNTHETIC display identity fixture stands in for
// the scenario read model so the validated planner still runs the real
// resolver. It proves the seed derivation, never production identity validation.
function syntheticSeedDisplayIdentityDb(fallback?: {
  query: (sql: string, values?: readonly unknown[]) => Promise<unknown>;
}) {
  return createSyntheticDisplayIdentityQueryable({
    currentItems: [
      syntheticCurrentCatalogItem({
        catalog_item_id: catalogSeedIds.items.pikachuJungle,
        status: "active",
        title: "Synthetic Pikachu",
      }),
    ],
    ...(fallback ? { fallback: fallback as never } : {}),
  });
}

describe("promoted Source Observation scenario seed", () => {
  it("derives the bounded TCGdex fixture through the executable mapper and promotion planner", async () => {
    const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence(syntheticSeedDisplayIdentityDb());

    expect(evidence.recordCommand).toMatchObject({
      type: "RecordSourceObservation",
      observationId: "tcgdex_en_base2_60",
      externalKey: "base2-60",
      providerKey: "tcgdex",
      sourceProfileKey: "pokemon-tcg",
      sourceProfileVersion: "2026.06.03",
      sourceRecordHash: "33176435566a66d6f02e6d9a2e61716cc1d7d3dc51d945e5a4a2a708365065c4",
      sourceUpdatedAt: "2026-05-23T17:18:39+01:00",
      normalized: expect.objectContaining({
        name: "Pikachu",
        illustrator: "Ken Sugimori",
        cardVariantKey: "standard",
        variants: {
          firstEdition: true,
          holo: false,
          normal: true,
          reverse: false,
          wPromo: false,
        },
      }),
      sourcePayload: expect.objectContaining({
        id: "base2-60",
        illustrator: "Ken Sugimori",
        updated: "2026-05-23T17:18:39+01:00",
      }),
    });
    expect(evidence.recordCommand.sourcePayload).not.toHaveProperty("pricing");
    expect(evidence.promotionPlan).toMatchObject({
      mode: "refresh",
      catalogItemId: catalogSeedIds.items.pikachuJungle,
      providerKey: "tcgdex",
      profileKey: "pokemon-tcg",
      profileVersion: "2026.06.03",
    });
    expect(evidence.promotionCommand.promotionPlanFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.promotionCommand.promotionPlanFingerprint).not.toBe(
      evidence.recordCommand.sourceMappingFingerprint,
    );
  });

  it("records and promotes one identity-consistent observation from empty history", async () => {
    const commands: Array<{ streamId: string; command: SourceObservationCommand }> = [];
    const services = fakeServices([], commands);

    await seedPromotedSourceObservationScenario(services as never);

    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      streamId: `catalog.source-observation-${catalogBrowserE2ePromotedObservation.observationId}`,
      command: { type: "RecordSourceObservation", observationId: catalogBrowserE2ePromotedObservation.observationId },
    });
    expect(commands[1]).toMatchObject({
      command: {
        type: "PromoteSourceObservation",
        catalogItemId: catalogSeedIds.items.pikachuJungle,
        promotionProfileKey: "pokemon-tcg",
        promotionProfileVersion: "2026.06.03",
      },
    });
  });

  it("does not append duplicate events after the exact promoted aggregate exists", async () => {
    const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence(syntheticSeedDisplayIdentityDb());
    const { rows } = exactHistory(evidence.recordCommand, evidence.promotionCommand);
    const commands: Array<{ streamId: string; command: SourceObservationCommand }> = [];

    await seedPromotedSourceObservationScenario(fakeServices(rows, commands) as never);

    expect(commands).toEqual([]);
  });

  it("rejects a recorded aggregate whose mapped facts do not match the fixture", async () => {
    const evidence = await buildCatalogBrowserE2ePromotedObservationSeedEvidence(syntheticSeedDisplayIdentityDb());
    const { rows } = exactHistory(evidence.recordCommand);
    rows[0] = {
      ...rows[0]!,
      payload: {
        ...rows[0]!.payload,
        normalized: { ...(rows[0]!.payload.normalized as object), name: "Raichu" },
      },
    };

    await expect(seedPromotedSourceObservationScenario(fakeServices(rows, []) as never)).rejects.toThrow(
      "mismatched identity, facts, target, profile, terminal state, or fingerprint",
    );
  });
});

const changedObservationStreamId = `catalog.source-observation-${catalogBrowserE2eChangedObservation.observationId}`;
const changedSeedLifecycle = [
  "catalog.source-observation.recorded",
  "catalog.source-observation.promoted",
  "catalog.source-observation.changed",
];
// The pager journey's stated limit for every tcgdex observation the browser-e2e seed creates.
const browserE2eTcgdexObservationBudget = 25;

describe("changed Source Observation scenario seed", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("derives a recorded, promoted, then changed 1st Edition revision that rehydrates to the changed state", async () => {
    const evidence = await buildCatalogBrowserE2eChangedObservationSeedEvidence(syntheticSeedDisplayIdentityDb());
    const identity = { observationId: "tcgdex_en_base2_60_1st_edition", externalKey: "base2-60:1st-edition" };

    expect(evidence.recordCommand).toMatchObject({
      ...identity,
      providerKey: "tcgdex",
      sourceUpdatedAt: "2026-05-23T17:18:39+01:00",
      observedAt: "2026-06-03T00:00:00.000Z",
      normalized: expect.objectContaining({ name: "Pikachu", cardVariantKey: "1st-edition" }),
    });
    expect(evidence.changedRecordCommand).toMatchObject({
      ...identity,
      sourceUpdatedAt: "2026-06-10T09:00:00+01:00",
      observedAt: "2026-06-10T09:00:00.000Z",
    });
    expect(evidence.changedRecordCommand.sourceRecordHash).not.toBe(evidence.recordCommand.sourceRecordHash);
    expect(evidence.promotionCommand).toMatchObject({
      catalogItemId: catalogSeedIds.items.pikachuJungle,
      promotionPlanFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const { rows, state } = exactHistory(
      evidence.recordCommand,
      evidence.promotionCommand,
      evidence.changedRecordCommand,
    );
    expect(rows.map((row) => row.event_type)).toEqual(changedSeedLifecycle);
    expect(state).toMatchObject({
      id: identity.observationId,
      status: "changed",
      promotedCatalogItemId: catalogSeedIds.items.pikachuJungle,
      sourceRecordHash: evidence.changedRecordCommand.sourceRecordHash,
    });
  });

  it("first boot appends the three events to one stream at the verified versions", async () => {
    const store = inMemoryScenarioStore();

    await seedChangedSourceObservationScenario(store.services as never);

    expect(store.appends).toEqual([
      { streamId: changedObservationStreamId, commandType: "RecordSourceObservation", expectedVersion: 0 },
      { streamId: changedObservationStreamId, commandType: "PromoteSourceObservation", expectedVersion: 1 },
      { streamId: changedObservationStreamId, commandType: "RecordSourceObservation", expectedVersion: 2 },
    ]);
    expect(replay(store.streams.get(changedObservationStreamId) ?? [])).toMatchObject({
      status: "changed",
      promotedCatalogItemId: catalogSeedIds.items.pikachuJungle,
    });
  });

  it("second boot appends nothing and both boots log the same count-and-lifecycle artifact within the budget", async () => {
    const store = inMemoryScenarioStore();
    for (let boot = 0; boot < 2; boot += 1) {
      await seedPromotedSourceObservationScenario(store.services as never);
      await seedChangedSourceObservationScenario(store.services as never);
    }

    expect(store.appends).toHaveLength(5);
    expect([...store.streams.keys()]).toEqual([
      `catalog.source-observation-${catalogBrowserE2ePromotedObservation.observationId}`,
      changedObservationStreamId,
    ]);
    const artifact = {
      event: "catalog-scenario-source-observations-seeded",
      tcgdexObservationCount: 2,
      changedObservationId: catalogBrowserE2eChangedObservation.observationId,
      changedObservationLifecycle: changedSeedLifecycle,
    };
    expect(vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([artifact, artifact]);
    expect(artifact.tcgdexObservationCount).toBeLessThanOrEqual(browserE2eTcgdexObservationBudget);
  });

  it.each([1, 2])("resumes an interrupted first boot from its exact %i-event authoritative prefix", async (prefix) => {
    const history = await changedSeedHistory();
    const store = inMemoryScenarioStore({ [changedObservationStreamId]: history.slice(0, prefix) });

    await seedChangedSourceObservationScenario(store.services as never);

    expect(store.appends.map((append) => append.expectedVersion)).toEqual([0, 1, 2].slice(prefix));
    expect(store.streams.get(changedObservationStreamId)).toEqual(history);
  });

  const negativeControls: ReadonlyArray<{
    history: string;
    stored: (history: readonly StoredRow[]) => readonly StoredRow[];
    refusal: string;
  }> = [
    {
      history: "a recorded event with malformed facts",
      stored: ([recorded]) => [
        { ...recorded!, payload: { ...recorded!.payload, normalized: { ...normalizedOf(recorded!), name: "Raichu" } } },
      ],
      refusal: "requires the exact event at version 1 (field path 'normalized.name')",
    },
    {
      history: "a partial promotion with no recorded event",
      stored: ([, promoted]) => [{ ...promoted!, stream_version: 1 }],
      refusal: "requires the exact event at version 1.",
    },
    {
      history: "a partial history that changed before any promotion",
      stored: ([recorded, , changed]) => [recorded!, { ...changed!, stream_version: 2 }],
      refusal: "requires the exact event at version 2.",
    },
    {
      history: "a promotion to another Catalog Item",
      stored: ([recorded, promoted]) => [
        recorded!,
        { ...promoted!, payload: { ...promoted!.payload, catalogItemId: "cat_seed_other_item" } },
      ],
      refusal: "requires the exact event at version 2 (field path 'catalogItemId')",
    },
    {
      history: "an unknown event type",
      stored: ([recorded]) => [
        recorded!,
        {
          event_type: "catalog.source-observation.unexpected",
          payload: { reason: "negative control" },
          stream_version: 2,
        },
      ],
      refusal: "requires the exact event at version 2.",
    },
    {
      history: "an event appended after the changed revision",
      stored: (history) => [
        ...history,
        {
          event_type: "catalog.source-observation.deferred",
          payload: { reason: "negative control", deferredAt: "2026-06-11T00:00:00.000Z", reviewStatus: "changed" },
          stream_version: 4,
        },
      ],
      refusal: "cannot reconcile lifecycle",
    },
  ];

  it.each(negativeControls)("refuses $history without appending a repair", async ({ stored, refusal }) => {
    const store = inMemoryScenarioStore({ [changedObservationStreamId]: stored(await changedSeedHistory()) });

    await expect(seedChangedSourceObservationScenario(store.services as never)).rejects.toThrow(refusal);
    expect(store.appends).toEqual([]);
  });

  it("authors from the event store and never reads the lagging Source Observation projection", async () => {
    const store = inMemoryScenarioStore();

    await seedChangedSourceObservationScenario(store.services as never);

    expect(store.queries.some((sql) => sql.includes("FROM event_store_events"))).toBe(true);
    expect(store.queries.filter((sql) => sql.includes("catalog_source_observations"))).toEqual([]);
  });

  it("derives every revision from the committed fixture without a provider network call", async () => {
    const providerFetch = vi.fn(() => Promise.reject(new Error("synthetic TCGdex network call")));
    vi.stubGlobal("fetch", providerFetch);

    await buildCatalogBrowserE2eChangedObservationSeedEvidence(syntheticSeedDisplayIdentityDb());
    await seedChangedSourceObservationScenario(inMemoryScenarioStore().services as never);

    expect(providerFetch).not.toHaveBeenCalled();
  });
});

type StoredRow = Readonly<{ event_type: string; payload: Record<string, unknown>; stream_version: number }>;

async function changedSeedHistory(): Promise<readonly StoredRow[]> {
  const evidence = await buildCatalogBrowserE2eChangedObservationSeedEvidence(syntheticSeedDisplayIdentityDb());
  return exactHistory(evidence.recordCommand, evidence.promotionCommand, evidence.changedRecordCommand).rows;
}

function normalizedOf(row: StoredRow): Record<string, unknown> {
  return row.payload.normalized as Record<string, unknown>;
}

function replay(rows: readonly StoredRow[]): SourceObservationState {
  return rows.reduce<SourceObservationState>(
    (state, row) =>
      evolveSourceObservation(state, { type: row.event_type, data: row.payload } as SourceObservationEvent),
    initialSourceObservationState,
  );
}

// An in-memory event store for the scenario seeds: it answers the seeds' event-store reads, decides
// each appended command against its own replayed stream, and enforces the caller's expected version.
function inMemoryScenarioStore(initialStreams: Readonly<Record<string, readonly StoredRow[]>> = {}) {
  const streams = new Map<string, readonly StoredRow[]>(Object.entries(initialStreams));
  const appends: Array<{ streamId: string; commandType: string; expectedVersion: number | undefined }> = [];
  const db = syntheticSeedDisplayIdentityDb({
    query: async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("projection_active")) {
        return { rows: [{ stream_created: true, stream_published: true, projection_active: true }] };
      }
      if (sql.includes("FROM event_store_streams")) {
        return { rows: [{ count: [...streams.keys()].filter((id) => id.startsWith(String(values[0]))).length }] };
      }
      if (sql.includes("FROM event_store_events")) {
        return { rows: streams.get(String(values[0])) ?? [] };
      }
      throw new Error(`Unexpected scenario seed query: ${sql}`);
    },
  });
  const commandHandler = async (input: {
    streamId: string;
    command: SourceObservationCommand;
    expectedVersion?: number;
  }) => {
    const rows = streams.get(input.streamId) ?? [];
    if (input.expectedVersion !== undefined && input.expectedVersion !== rows.length) {
      throw new Error(`synthetic concurrency conflict on ${input.streamId}`);
    }
    const events = decideSourceObservation(replay(rows), input.command);
    streams.set(input.streamId, [
      ...rows,
      ...events.map((event, index) => ({
        event_type: event.type,
        payload: event.data as Record<string, unknown>,
        stream_version: rows.length + index + 1,
      })),
    ]);
    appends.push({ streamId: input.streamId, commandType: input.command.type, expectedVersion: input.expectedVersion });
  };

  return { services: { db, sourceObservations: { commandHandler } }, streams, appends, queries: db.queries };
}

function exactHistory(...commands: SourceObservationCommand[]) {
  let state: SourceObservationState = initialSourceObservationState;
  const rows: StoredRow[] = [];
  for (const command of commands) {
    const events = decideSourceObservation(state, command);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    rows.push({
      event_type: event.type,
      payload: event.data as Record<string, unknown>,
      stream_version: rows.length + 1,
    });
    state = evolveSourceObservation(state, event);
  }
  return { rows, state };
}

function fakeServices(
  rows: readonly { event_type: string; payload: Record<string, unknown> }[],
  commands: Array<{ streamId: string; command: SourceObservationCommand }>,
) {
  return {
    db: syntheticSeedDisplayIdentityDb({
      query: async (sql: string) =>
        sql.includes("projection_active")
          ? { rows: [{ stream_created: true, stream_published: true, projection_active: true }] }
          : { rows },
    }),
    sourceObservations: {
      commandHandler: async (input: { streamId: string; command: SourceObservationCommand }) => {
        commands.push({ streamId: input.streamId, command: input.command });
      },
    },
  };
}
