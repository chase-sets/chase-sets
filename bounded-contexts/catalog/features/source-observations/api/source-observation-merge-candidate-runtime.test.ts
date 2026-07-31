import { EVENT_STORE_READ_PAGE_SIZE_MAX, type EventStoreContext } from "@chase-sets/event-core/storage";
import { assertBoundedStreamReadContract, createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it, vi } from "vitest";
import { normalizedObservation } from "../../../support/test-support/source-observation-fixtures";
import type { SourceObservationListRow } from "../read-model/queries";
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

function createHarness() {
  const { eventStore, streams } = createInMemoryEventStore();
  const observations = [
    observationRow("obs_tcgdex_054", "sv2-054"),
    observationRow("obs_tcgdex_054_refresh", "sv2-054-refresh"),
  ];
  const db: PgQueryable = {
    query: async <Row>(text) => {
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

function acceptedScopeMapping() {
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
