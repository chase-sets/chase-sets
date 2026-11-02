import { EVENT_STORE_READ_PAGE_SIZE_MAX, type EventStoreContext } from "@chase-sets/event-core/storage";
import { assertBoundedStreamReadContract, createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it, vi } from "vitest";
import { normalizedObservation } from "../../../support/test-support/source-observation-fixtures";
import type { SourceObservationListRow } from "../read-model/queries";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import type { SourceObservationMagicCardPrintNormalized } from "../domain/domain";
import { evolveCatalogMergeCandidate, initialCatalogMergeCandidateState } from "../domain/catalog-merge-candidate";
import type { CatalogMergeCandidateEvent } from "../domain/catalog-merge-candidate";
import { buildCatalogMergeCandidatesFromObservations } from "./promotion/catalog-merge-candidate-matcher";
import { catalogProviderProfileVersionIngestionUnitKey } from "./provider-integration-profiles";
import { createSourceObservationMergeCandidateRuntime } from "./source-observation-merge-candidate-runtime";
import { staticCatalogProviderIntegrationProfileVersions } from "./source-observation-runtime-contracts";
import { catalogMergeCandidateStreamId } from "./source-observation-stream-identity";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_reviewer", forAccountId: "acc_catalog" },
  trace: {},
} as EventStoreContext;

const siteIds = [
  "bounded-contexts/catalog/features/source-observations/api/source-observation-merge-candidate-runtime.ts#readStream#1",
  "bounded-contexts/catalog/features/source-observations/api/source-observation-merge-candidate-runtime.ts#readStream#2",
] as const;

describe("source observation merge candidate bounded stream contracts", () => {
  it(`${siteIds[0]} refreshes rather than recreates a candidate with history beyond the bound`, async () => {
    const harness = createHarness();
    const first = await harness.generate();
    expect(first.exclusions).toEqual([]);
    const candidate = first.candidates[0]!;
    const streamId = catalogMergeCandidateStreamId(candidate.candidateId);
    await harness.generate();
    expect(harness.streams.get(streamId)).toHaveLength(2);

    const readStream = vi.spyOn(harness.eventStore, "readStream");
    await harness.generate();

    expect(harness.streams.get(streamId)?.map((event) => event.eventType)).toEqual([
      "catalog.merge-candidate.created",
      "catalog.merge-candidate.refreshed",
      "catalog.merge-candidate.refreshed",
    ]);
    assertBoundedStreamReadContract({
      streamId,
      bound: 1,
      historyLength: 2,
      requests: readStream.mock.calls
        .map(([request]) => request)
        .filter((request) => request.streamId === streamId && request.limit !== EVENT_STORE_READ_PAGE_SIZE_MAX),
    });
  });

  it(`${siteIds[1]} rejects an existing split candidate with history beyond the bound`, async () => {
    const harness = createHarness();
    const generated = await harness.generate();
    expect(generated.exclusions).toEqual([]);
    const original = generated.candidates[0]!;
    await harness.generate();
    const splitCandidateId = "candidate-already-exists";
    const splitStreamId = catalogMergeCandidateStreamId(splitCandidateId);
    await harness.eventStore.appendToStream({
      streamId: splitStreamId,
      expectedVersion: "no_stream",
      context,
      events: [
        { eventType: "catalog.test.split-reserved", payload: { sequence: 1 } },
        { eventType: "catalog.test.split-reserved", payload: { sequence: 2 } },
      ],
    });

    const readStream = vi.spyOn(harness.eventStore, "readStream");
    await expect(
      harness.services.splitCatalogMergeCandidate({
        candidateId: original.candidateId,
        remainingSnapshot: { ...original.snapshot, membership: original.snapshot.membership.slice(0, 1) },
        splitCandidateId,
        splitSnapshot: { ...original.snapshot, membership: original.snapshot.membership.slice(1) },
        reason: "Separate conflicting observations",
        context,
      }),
    ).rejects.toThrow("Split Catalog Merge Candidate already exists.");

    assertBoundedStreamReadContract({
      streamId: splitStreamId,
      bound: 1,
      historyLength: 2,
      requests: readStream.mock.calls
        .map(([request]) => request)
        .filter((request) => request.streamId === splitStreamId),
    });
  });
});

describe("source observation merge candidate reconciliation regressions", () => {
  it.each([false, true])(
    "AC1/AC2 Time Spiral provider permutation reversed=%s matches the one-pass oracle at every step",
    async (reverse) => {
      const { mtgjson, scryfall } = await timeSpiralRows();
      const rows = reverse ? [scryfall, mtgjson] : [mtgjson, scryfall];
      const harness = createPersistenceHarness([], timeSpiralMappings());
      const runtime = createSourceObservationMergeCandidateRuntime({
        deps: harness.deps,
        profileVersions: staticCatalogProviderIntegrationProfileVersions,
      });
      const union: SourceObservationListRow[] = [];
      let candidateId: string | undefined;
      for (const row of rows) {
        union.push(row);
        harness.rows.push(row);
        const result = await runtime.persistCatalogMergeCandidatesFromObservations([row], context);
        expectOracle(result, union, timeSpiralMappings());
        expectPersistedOracle(harness, result);
        expect(result.candidates).toHaveLength(1);
        candidateId ??= result.candidates[0]!.candidateId;
        expect(result.candidates[0]!.candidateId).toBe(candidateId);
      }
      const state = harness.states()[0]!;
      expect(state.snapshot?.membership).toHaveLength(2);
      expect(state.snapshot?.conflicts).not.toHaveLength(0);
      expect([...harness.streams.values()][0]?.map((event) => event.eventType)).toEqual([
        "catalog.merge-candidate.created",
        "catalog.merge-candidate.refreshed",
      ]);
      expectNoDuplicateMembers(harness);
    },
  );

  it("AC3 Time Spiral cross-run re-import replaces only the incoming provider tuples and preserves both runs", async () => {
    const { mtgjson, scryfall } = await timeSpiralRows();
    const harness = createPersistenceHarness([mtgjson, scryfall], timeSpiralMappings());
    const runtime = createSourceObservationMergeCandidateRuntime({
      deps: harness.deps,
      profileVersions: staticCatalogProviderIntegrationProfileVersions,
    });
    await runtime.persistCatalogMergeCandidatesFromObservations([mtgjson], context);
    expectOracle(
      await runtime.persistCatalogMergeCandidatesFromObservations([scryfall], context),
      [mtgjson, scryfall],
      timeSpiralMappings(),
    );
    const refreshed = { ...mtgjson, source_record_hash: "changed-mtgjson-hash", sync_run_id: "job_time_spiral_run_2" };
    harness.rows.splice(0, harness.rows.length, refreshed, scryfall);
    const result = await runtime.persistCatalogMergeCandidatesFromObservations([refreshed], context);
    expectOracle(result, [refreshed, scryfall], timeSpiralMappings());
    expectPersistedOracle(harness, result);
    expect(result.candidates[0]?.snapshot.syncRunIds).toEqual(["job_time_spiral_run_1", "job_time_spiral_run_2"]);
    expect(
      result.candidates[0]?.snapshot.membership.find((member) => member.providerKey === "scryfall")?.sourceRecordHash,
    ).toBe(scryfall.source_record_hash);
  });

  it.each(["rejected", "excluded", "elsewhere"] as const)(
    "AC4b current member %s leaves exactly as one-pass matching",
    async (mode) => {
      const first = observationRow("obs_a", "a");
      const second = observationRow("obs_b", "b");
      const retained = observationRow("obs_c", "c");
      const harness = createPersistenceHarness([first, second, retained]);
      const runtime = createSourceObservationMergeCandidateRuntime({
        deps: harness.deps,
        profileVersions: staticCatalogProviderIntegrationProfileVersions,
      });
      await runtime.persistCatalogMergeCandidatesFromObservations([first, retained], context);
      const changed =
        mode === "rejected"
          ? { ...first, status: "rejected" }
          : {
              ...first,
              normalized: normalizedObservation({
                ...first.normalized,
                ...(mode === "excluded" ? { setId: "unmapped", setName: "Unmapped" } : { cardNumber: "99" }),
              }),
            };
      harness.rows.splice(0, harness.rows.length, changed, second, retained);
      const result = await runtime.persistCatalogMergeCandidatesFromObservations([second], context);
      expectOracle(result, mode === "rejected" ? [second, retained] : [changed, second, retained], [
        acceptedScopeMapping(),
      ]);
      expectNoDuplicateMembers(harness);
      expectPersistedOracle(harness, result);
    },
  );

  it.each([false, true])(
    "AC4c cross-fingerprint reference join reversed=%s never leaves duplicate holders",
    async (reverse) => {
      const references = [{ providerKey: "synthetic", externalKey: "synthetic-shared-card" }];
      const a = {
        ...observationRow("obs_z_unit_a", "a"),
        normalized: normalizedObservation({
          ...observationRow("unused", "unused").normalized,
          cardNumber: "54",
          externalCatalogItemReferences: references,
        }),
      };
      const b = {
        ...observationRow("obs_a_unit_b", "b"),
        normalized: normalizedObservation({
          ...a.normalized,
          cardNumber: "54a",
          externalCatalogItemReferences: references,
        }),
      };
      const harness = createPersistenceHarness([a, b]);
      const runtime = createSourceObservationMergeCandidateRuntime({
        deps: harness.deps,
        profileVersions: staticCatalogProviderIntegrationProfileVersions,
      });
      const [first, second] = reverse ? [b, a] : [a, b];
      await runtime.persistCatalogMergeCandidatesFromObservations([first!], context);
      harness.project();
      const before = [...harness.streams.values()].reduce((count, events) => count + events.length, 0);
      if (reverse) {
        expectOracle(
          await runtime.persistCatalogMergeCandidatesFromObservations([second!], context),
          [a, b],
          [acceptedScopeMapping()],
        );
      } else {
        await expect(runtime.persistCatalogMergeCandidatesFromObservations([second!], context)).rejects.toThrow(
          "re-keying",
        );
        expect([...harness.streams.values()].reduce((count, events) => count + events.length, 0)).toBe(before);
      }
      expectNoDuplicateMembers(harness);
    },
  );

  it.each([false, true])(
    "AC4d concurrent refresh is version-guarded with projection discovered=%s",
    async (project) => {
      const a = observationRow("obs_a", "a");
      const b = observationRow("obs_b", "b");
      const concurrent = observationRow("obs_c", "c");
      const harness = createPersistenceHarness([a, b, concurrent]);
      const runtime = createSourceObservationMergeCandidateRuntime({
        deps: harness.deps,
        profileVersions: staticCatalogProviderIntegrationProfileVersions,
      });
      const created = await runtime.persistCatalogMergeCandidatesFromObservations([a], context);
      if (project) harness.project();
      const writer = createSourceObservationMergeCandidateRuntime({
        deps: harness.deps,
        profileVersions: staticCatalogProviderIntegrationProfileVersions,
      });
      const append = harness.deps.eventStore.appendToStream.bind(harness.deps.eventStore);
      const read = harness.deps.eventStore.readStream.bind(harness.deps.eventStore);
      let raced = false;
      vi.spyOn(harness.deps.eventStore, "readStream").mockImplementation(async (input) => {
        if (!raced && input.limit === 1) {
          raced = true;
          const snapshot = buildCatalogMergeCandidatesFromObservations([a, concurrent], {
            addedAt: a.observed_at,
            acceptedScopeMappings: [acceptedScopeMapping()],
            providerUnitKeyByObservationId: pokemonUnitKeys([a, concurrent]),
          }).candidates[0]!.snapshot;
          await append({
            streamId: catalogMergeCandidateStreamId(created.candidates[0]!.candidateId),
            expectedVersion: 1,
            context,
            events: [
              {
                eventType: "catalog.merge-candidate.refreshed",
                payload: {
                  candidateId: created.candidates[0]!.candidateId,
                  status: "ready",
                  snapshot,
                  refreshedAt: a.observed_at,
                },
              },
            ],
          });
        }
        return read(input);
      });
      await expect(writer.persistCatalogMergeCandidatesFromObservations([b], context)).rejects.toMatchObject({
        code: "concurrency_conflict",
      });
      expect(harness.states()[0]?.snapshot?.membership.map((member) => member.observationId)).toEqual([
        a.observation_id,
        concurrent.observation_id,
      ]);
      expect([...harness.streams.values()][0]).toHaveLength(2);
    },
  );

  it("AC4d guards creates with no_stream when another worker creates after reconciliation", async () => {
    const a = observationRow("obs_a", "a");
    const b = observationRow("obs_b", "b");
    const harness = createPersistenceHarness([a, b]);
    const runtime = createSourceObservationMergeCandidateRuntime({
      deps: harness.deps,
      profileVersions: staticCatalogProviderIntegrationProfileVersions,
    });
    const append = harness.deps.eventStore.appendToStream.bind(harness.deps.eventStore);
    let raced = false;
    vi.spyOn(harness.deps.eventStore, "appendToStream").mockImplementation(async (input) => {
      if (!raced) {
        raced = true;
        expect(input.expectedVersion).toBe("no_stream");
        await append({
          ...input,
          events: [
            {
              ...input.events[0]!,
              payload: {
                ...input.events[0]!.payload,
                snapshot: buildCatalogMergeCandidatesFromObservations([a], {
                  addedAt: a.observed_at,
                  acceptedScopeMappings: [acceptedScopeMapping()],
                  providerUnitKeyByObservationId: pokemonUnitKeys([a]),
                }).candidates[0]!.snapshot,
              },
            },
          ],
        });
      }
      return append(input);
    });
    await expect(runtime.persistCatalogMergeCandidatesFromObservations([b], context)).rejects.toMatchObject({
      code: "concurrency_conflict",
    });
    expect(harness.states()[0]?.snapshot?.membership.map((member) => member.observationId)).toEqual([a.observation_id]);
  });

  it("AC4e reads more than a page of prior members completely in a single by-ID query", async () => {
    const prior = Array.from({ length: 1001 }, (_, index) =>
      observationRow(`obs_${String(index).padStart(4, "0")}`, `key_${index}`),
    );
    const incoming = observationRow("obs_z_incoming", "incoming");
    const harness = createPersistenceHarness([...prior, incoming]);
    const runtime = createSourceObservationMergeCandidateRuntime({
      deps: harness.deps,
      profileVersions: staticCatalogProviderIntegrationProfileVersions,
    });
    await runtime.persistCatalogMergeCandidatesFromObservations(prior, context);
    const query = vi.spyOn(harness.deps.db, "query");
    const result = await runtime.persistCatalogMergeCandidatesFromObservations([incoming], context);
    expectOracle(result, [...prior, incoming], [acceptedScopeMapping()]);
    const reads = query.mock.calls.filter(([sql]) => sql.includes("FROM catalog_source_observations"));
    expect(reads).toHaveLength(1);
    expect(reads[0]?.[0]).not.toMatch(/LIMIT/i);
    expect(reads[0]?.[1]?.[0]).toHaveLength(prior.length);
  });

  it("F4 loads zero streams from another scope even after this runtime touched that scope", async () => {
    const a = observationRow("obs_scope_a", "a");
    const b = {
      ...observationRow("obs_scope_b", "b"),
      normalized: normalizedObservation({ ...a.normalized, setId: "other", setName: "Other" }),
    };
    const mappings = [
      acceptedScopeMapping(),
      {
        ...acceptedScopeMapping(),
        mapping_id: "map_other",
        scope_record_id: "scope_other",
        set_id: "other",
        set_name: "Other",
      },
    ];
    const harness = createPersistenceHarness([a, b], mappings);
    const runtime = createSourceObservationMergeCandidateRuntime({
      deps: harness.deps,
      profileVersions: staticCatalogProviderIntegrationProfileVersions,
    });
    const first = await runtime.persistCatalogMergeCandidatesFromObservations([a], context);
    const read = vi.spyOn(harness.deps.eventStore, "readStream");
    const result = await runtime.persistCatalogMergeCandidatesFromObservations([b], context);
    expectOracle(result, [b], mappings);
    expect(
      read.mock.calls.filter(
        ([request]) => request.streamId === catalogMergeCandidateStreamId(first.candidates[0]!.candidateId),
      ),
    ).toEqual([]);
  });

  it("F4 keeps both providers after a fresh runtime starts with projection discovery empty", async () => {
    const { mtgjson: first, scryfall: second } = await timeSpiralRows();
    const harness = createPersistenceHarness([first, second], timeSpiralMappings());

    const firstRuntime = createSourceObservationMergeCandidateRuntime({
      deps: harness.deps,
      profileVersions: staticCatalogProviderIntegrationProfileVersions,
    });
    const firstResult = await firstRuntime.persistCatalogMergeCandidatesFromObservations([first], context);
    const secondRuntime = createSourceObservationMergeCandidateRuntime({
      deps: harness.deps,
      profileVersions: staticCatalogProviderIntegrationProfileVersions,
    });
    const secondResult = await secondRuntime.persistCatalogMergeCandidatesFromObservations([second], context);

    expect(firstResult.candidates).toHaveLength(1);
    expectOracle(firstResult, [first], timeSpiralMappings());
    expectOracle(secondResult, [first, second], timeSpiralMappings());
    expect(secondResult.candidates[0]?.snapshot.membership.map((member) => member.observationId)).toEqual([
      first.observation_id,
      second.observation_id,
    ]);
    expectPersistedOracle(harness, secondResult);
  });

  it("F4 loads newly generated candidate IDs and reconciles their undiscovered members until stable", async () => {
    const a = observationRow("obs_a", "a");
    const b = observationRow("obs_b", "b");
    const c = {
      ...observationRow("obs_c", "c"),
      normalized: normalizedObservation({ ...pokemonFacts(a), cardNumber: "99" }),
    };
    const harness = createPersistenceHarness([a, b, c]);
    const firstRuntime = createSourceObservationMergeCandidateRuntime({
      deps: harness.deps,
      profileVersions: staticCatalogProviderIntegrationProfileVersions,
    });
    await firstRuntime.persistCatalogMergeCandidatesFromObservations([a, b], context);
    harness.project();
    await firstRuntime.persistCatalogMergeCandidatesFromObservations([c], context);
    const changed = { ...b, normalized: normalizedObservation({ ...pokemonFacts(b), cardNumber: "99" }) };
    harness.rows.splice(0, harness.rows.length, a, changed, c);
    const secondRuntime = createSourceObservationMergeCandidateRuntime({
      deps: harness.deps,
      profileVersions: staticCatalogProviderIntegrationProfileVersions,
    });
    const result = await secondRuntime.persistCatalogMergeCandidatesFromObservations([a], context);
    expectOracle(result, [a, changed, c], [acceptedScopeMapping()]);
    expectNoDuplicateMembers(harness);
  });

  it("AC4b removes an existing member whose row is no longer eligible for matching", async () => {
    const first = observationRow("obs_tcgdex_054", "sv2-054");
    const second = observationRow("obs_tcgdex_054_refresh", "sv2-054-refresh");
    const harness = createPersistenceHarness([first]);
    const runtime = createSourceObservationMergeCandidateRuntime({
      deps: harness.deps,
      profileVersions: staticCatalogProviderIntegrationProfileVersions,
    });

    await runtime.persistCatalogMergeCandidatesFromObservations([first], context);
    harness.rows.splice(0, harness.rows.length, { ...first, status: "rejected" }, second);
    const result = await runtime.persistCatalogMergeCandidatesFromObservations([second], context);

    expectOracle(result, [second], [acceptedScopeMapping()]);
    expectPersistedOracle(harness, result);
    expect(result.candidates[0]?.snapshot.membership.map((member) => member.observationId)).toEqual([
      second.observation_id,
    ]);
  });

  it.each([false, true])(
    "AC4a fails closed when an existing member row is absent; substituted=%s",
    async (substituted) => {
      const first = observationRow("obs_tcgdex_054", "sv2-054");
      const second = observationRow("obs_tcgdex_054_refresh", "sv2-054-refresh");
      const harness = createPersistenceHarness([first]);
      const runtime = createSourceObservationMergeCandidateRuntime({
        deps: harness.deps,
        profileVersions: staticCatalogProviderIntegrationProfileVersions,
      });

      await runtime.persistCatalogMergeCandidatesFromObservations([first], context);
      harness.rows.splice(0, harness.rows.length, second);
      if (substituted) {
        const query = harness.deps.db.query.bind(harness.deps.db);
        vi.spyOn(harness.deps.db, "query").mockImplementation(async (sql, values) =>
          sql.includes("WHERE observation_id = ANY") ? { rows: [second], rowCount: 1 } : query(sql, values),
        );
      }

      await expect(runtime.persistCatalogMergeCandidatesFromObservations([second], context)).rejects.toThrow(
        "could not prove every existing member row",
      );
      expect([...harness.streams.values()][0]).toHaveLength(1);
    },
  );

  it("AC3 retains the other member when one unit is re-imported", async () => {
    const first = observationRow("obs_tcgdex_054", "sv2-054");
    const second = observationRow("obs_tcgdex_054_refresh", "sv2-054-refresh");
    const refreshed = { ...first, source_record_hash: "obs_tcgdex_054-new-hash", sync_run_id: "job_sync_2" };
    const harness = createPersistenceHarness([first, second]);
    const runtime = createSourceObservationMergeCandidateRuntime({
      deps: harness.deps,
      profileVersions: staticCatalogProviderIntegrationProfileVersions,
    });

    await runtime.persistCatalogMergeCandidatesFromObservations([first], context);
    harness.rows.splice(0, harness.rows.length, first, second);
    const both = await runtime.persistCatalogMergeCandidatesFromObservations([second], context);
    harness.rows.splice(0, harness.rows.length, refreshed, second);
    const result = await runtime.persistCatalogMergeCandidatesFromObservations([refreshed], context);

    expectOracle(result, [refreshed, second], [acceptedScopeMapping()]);
    expectPersistedOracle(harness, result);
    expect(both.candidates[0]?.snapshot.membership).toHaveLength(2);
    expect(result.candidates[0]?.snapshot.membership.map((member) => member.observationId)).toEqual([
      first.observation_id,
      second.observation_id,
    ]);
    expect(
      result.candidates[0]?.snapshot.membership.find((member) => member.observationId === first.observation_id),
    ).toMatchObject({ sourceRecordHash: refreshed.source_record_hash });
  });
});

function createHarness() {
  const { eventStore, streams } = createInMemoryEventStore();
  const observations = [
    observationRow("obs_tcgdex_054", "sv2-054"),
    observationRow("obs_tcgdex_054_refresh", "sv2-054-refresh"),
  ];
  const db: PgQueryable = {
    query: async <Row>(text: string) => {
      const rows = text.includes("FROM catalog_source_observations") ? observations : [acceptedScopeMapping()];
      return { rows: rows as Row[], rowCount: rows.length };
    },
  };
  const runtime = createSourceObservationMergeCandidateRuntime({
    deps: {
      eventStore,
      checkpointStore: {
        loadCheckpoint: async () => "0" as never,
        saveCheckpoint: async () => undefined,
      },
      db,
    },
    profileVersions: staticCatalogProviderIntegrationProfileVersions,
  });

  return {
    eventStore,
    streams,
    services: runtime.services,
    generate: () => runtime.services.generateCatalogMergeCandidates({ context }),
  };
}

function createPersistenceHarness(
  initialRows: SourceObservationListRow[],
  mappings: readonly ProviderScopeMappingRow[] = [acceptedScopeMapping()],
) {
  const { eventStore, streams } = createInMemoryEventStore();
  const rows = [...initialRows];
  let projected: Array<{ candidate_id: string; scope_record_id: string }> = [];
  function states() {
    return [...streams.values()].map((events) =>
      events.reduce(
        (state, event) =>
          evolveCatalogMergeCandidate(state, {
            type: event.eventType,
            data: event.payload,
          } as CatalogMergeCandidateEvent),
        initialCatalogMergeCandidateState,
      ),
    );
  }
  const deps: Parameters<typeof createSourceObservationMergeCandidateRuntime>[0]["deps"] = {
    eventStore,
    checkpointStore: {
      loadCheckpoint: async () => "0" as never,
      saveCheckpoint: async () => undefined,
    },
    db: {
      query: async <Row>(text: string, values?: readonly unknown[]) => {
        if (text.includes("FROM catalog_source_observations")) {
          const requestedIds = values?.[0];
          let resultRows = Array.isArray(requestedIds)
            ? rows.filter((row) => requestedIds.includes(row.observation_id))
            : rows;
          const limit = /LIMIT\s+(\d+)/i.exec(text);
          if (limit) resultRows = resultRows.slice(0, Number(limit[1]));
          return { rows: resultRows as Row[], rowCount: resultRows.length };
        }
        if (text.includes("FROM catalog_merge_candidates")) {
          const scopes = values?.[0];
          const resultRows = projected.filter((row) => Array.isArray(scopes) && scopes.includes(row.scope_record_id));
          return { rows: resultRows as Row[], rowCount: resultRows.length };
        }
        return { rows: [...mappings] as Row[], rowCount: mappings.length };
      },
    },
  };

  return {
    deps,
    rows,
    streams,
    states,
    project: () => {
      projected = states().flatMap((state) =>
        state.id && state.snapshot
          ? [{ candidate_id: state.id, scope_record_id: state.snapshot.identity.scopeRecordId }]
          : [],
      );
    },
  };
}

function acceptedScopeMapping(): ProviderScopeMappingRow {
  return {
    mapping_id: "map_tcgdex_scope_paldea_evolved",
    scope_record_id: "scope_paldea_evolved",
    provider_key: "tcgdex",
    unit_key: "tcgdex:pokemon:single-card:source-observation-import",
    product_line_id: null,
    series_id: null,
    set_id: "sv2",
    set_name: "Paldea Evolved",
    language_coordinates: { languageCode: "en" },
    confidence: "exact",
    review_status: "accepted",
    provenance: {},
    evidence: {},
    last_actor: "usr_reviewer",
    last_reason: "verified",
    policy_version: "scope-mapping-v1",
    proposed_at: "2026-06-24T10:00:00.000Z",
    reviewed_at: "2026-06-24T10:05:00.000Z",
    updated_at: "2026-06-24T10:05:00.000Z",
  };
}

function pokemonUnitKeys(rows: readonly SourceObservationListRow[]) {
  return Object.fromEntries(
    rows.map((row) => [row.observation_id, "tcgdex:pokemon:single-card:source-observation-import"]),
  );
}

function pokemonFacts(row: SourceObservationListRow) {
  if (row.normalized.kind !== "pokemon-card") throw new Error("Expected Pokemon fixture");
  return row.normalized;
}

function withoutTimestamps(value: unknown) {
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => (/(?:At|_at)$/.test(key) ? undefined : item)));
}

function expectOracle(
  result: ReturnType<typeof buildCatalogMergeCandidatesFromObservations>,
  rows: readonly SourceObservationListRow[],
  mappings: readonly ProviderScopeMappingRow[],
) {
  const oracle = buildCatalogMergeCandidatesFromObservations(rows, {
    addedAt: "2026-07-14T12:00:00.000Z",
    acceptedScopeMappings: mappings,
    providerUnitKeyByObservationId: Object.fromEntries(
      rows.map((row) => [
        row.observation_id,
        row.provider_key === "tcgdex"
          ? "tcgdex:pokemon:single-card:source-observation-import"
          : `${row.provider_key}:mtg:single-card:reference-data`,
      ]),
    ),
  });
  expect(withoutTimestamps(result.candidates)).toEqual(withoutTimestamps(oracle.candidates));
}

function expectNoDuplicateMembers(harness: ReturnType<typeof createPersistenceHarness>) {
  const ids = harness
    .states()
    .flatMap((state) => state.snapshot?.membership.map((member) => member.observationId) ?? []);
  expect(new Set(ids).size).toBe(ids.length);
}

function expectPersistedOracle(
  harness: ReturnType<typeof createPersistenceHarness>,
  result: ReturnType<typeof buildCatalogMergeCandidatesFromObservations>,
) {
  const snapshots = harness
    .states()
    .map((state) => ({ candidateId: state.id, snapshot: state.snapshot }))
    .sort((left, right) => left.candidateId!.localeCompare(right.candidateId!));
  expect(withoutTimestamps(snapshots)).toEqual(withoutTimestamps(result.candidates));
}

function timeSpiralMappings(): ProviderScopeMappingRow[] {
  return ["mtgjson", "scryfall"].map((provider) => ({
    ...acceptedScopeMapping(),
    mapping_id: `map_${provider}_tsp`,
    scope_record_id: "scope_time_spiral",
    provider_key: provider,
    unit_key: `${provider}:mtg:single-card:reference-data`,
    set_id: provider === "mtgjson" ? "TSP" : "tsp",
    set_name: "Time Spiral",
  }));
}

async function timeSpiralRows() {
  const rows = await Promise.all(
    ["mtgjson", "scryfall"].map(async (provider) => {
      const versions = await staticCatalogProviderIntegrationProfileVersions.listProfileVersions(provider);
      const version = versions.find(
        (item) => catalogProviderProfileVersionIngestionUnitKey(item) === `${provider}:mtg:single-card:reference-data`,
      );
      if (!version) throw new Error(`Missing ${provider} card-print profile fixture`);
      const normalized: SourceObservationMagicCardPrintNormalized = {
        kind: "magic-card-print",
        tcg: "magic",
        languageCode: "en",
        name: "Fury Sliver",
        cardNumber: "157",
        setCode: provider === "mtgjson" ? "TSP" : "tsp",
        setName: "Time Spiral",
        expansionName: "Time Spiral",
        setId: provider === "mtgjson" ? null : "c1d109bc-ffd8-428f-8d7d-3f8d7e648046",
        oracleId: "44623693-51d6-49ad-8cd7-140505caf02f",
        rarity: provider === "mtgjson" ? "Uncommon" : "Rare",
        illustrator: "Paolo Parente",
        releaseDate: "2006-10-06",
        releaseYear: 2006,
        cardVariantKey: "standard",
        cardVariantLabel: "Standard",
        imageUrls: [],
        mergeIdentity: {
          tcg: "magic",
          productLineName: "Magic: The Gathering",
          setName: "Time Spiral",
          printedProductName: "Fury Sliver",
          collectorNumber: "157",
          languageCode: "en",
          productForm: "magic-card-print",
        },
      };
      return {
        ...observationRow(`obs_${provider}_tsp_157`, `card:${provider}-157`),
        sync_run_id: "job_time_spiral_run_1",
        provider_key: provider,
        source_profile_key: version.profileKey,
        source_profile_version: version.profileVersion,
        normalized,
      };
    }),
  );
  return { mtgjson: rows[0]!, scryfall: rows[1]! };
}

function observationRow(observationId: string, externalKey: string): SourceObservationListRow {
  return {
    observation_id: observationId,
    sync_run_id: "job_sync_1",
    provider_key: "tcgdex",
    external_key: externalKey,
    source_url: `https://provider.example/${externalKey}`,
    language_code: "en",
    source_record_hash: `${observationId}-hash`,
    source_updated_at: null,
    observed_at: "2026-06-24T11:59:00.000Z",
    source_profile_key: "pokemon-tcg",
    source_profile_version: "2026.06.03",
    source_mapping_fingerprint: "tcgdex-mapping",
    normalized: normalizedObservation({
      name: "Charizard ex",
      cardNumber: "54",
      setId: "sv2",
      setName: "Paldea Evolved",
      expansionId: "sv2",
      expansionName: "Paldea Evolved",
    }),
    status: "observed",
    status_reason: null,
    promoted_catalog_item_id: null,
    promoted_reference_record_id: null,
    promoted_at: null,
    promotion_profile_key: null,
    promotion_profile_version: null,
    promotion_plan_fingerprint: null,
    updated_at: "2026-06-24T11:59:00.000Z",
  };
}
