import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizedObservation } from "../../../support/test-support/source-observation-fixtures";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import type { SourceObservationListRow } from "../read-model/queries";
import { unitKeyForCatalogProviderProfileVersion } from "./governance/catalog-integration-impact-analysis";
import { createSourceObservationMergeCandidateRuntime } from "./source-observation-merge-candidate-runtime";
import {
  staticCatalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionReader,
} from "./source-observation-runtime-contracts";

/**
 * Bound contracts for the two deliberate bounded-prefix reads in
 * source-observation-merge-candidate-runtime.ts (#6277):
 *
 * - bounded-contexts/catalog/features/source-observations/api/source-observation-merge-candidate-runtime.ts:readStream#1
 *   (create-versus-refresh existence probe)
 * - bounded-contexts/catalog/features/source-observations/api/source-observation-merge-candidate-runtime.ts:readStream#2
 *   (split-target existence probe)
 *
 * Both bounds are asserted on the read that actually decides: the FIRST read
 * against a candidate stream, which is the existence probe. A probe that
 * quietly widened to the 500-event page cap would fail these tests. The
 * complete replays the aggregate repository performs afterwards are the
 * canonical mechanism doing its job and are deliberately not constrained.
 */
const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_reviewer", forAccountId: "acc_system" },
  trace: {},
} as EventStoreContext;

describe("Catalog Merge Candidate bounded-prefix reads", () => {
  let profileVersions: CatalogProviderIntegrationProfileVersionReader;
  let profileKeyByProvider: Map<string, { profileKey: string; profileVersion: string; unitKey: string }>;

  beforeEach(async () => {
    profileVersions = staticCatalogProviderIntegrationProfileVersions;
    profileKeyByProvider = new Map();
    for (const providerKey of ["tcgdex", "tcgplayer"]) {
      const [version] = await profileVersions.listProfileVersions(providerKey);
      expect(version, `the static profile registry must publish a ${providerKey} version`).toBeDefined();
      // Each provider's scope mapping must carry ITS OWN ingestion unit key --
      // the matcher looks the observation's unit key up per provider, so one
      // shared key silently excludes every observation from the other provider.
      profileKeyByProvider.set(providerKey, {
        profileKey: version.profileKey,
        profileVersion: version.profileVersion,
        unitKey: unitKeyForCatalogProviderProfileVersion(version),
      });
    }
  });

  function harness() {
    const { eventStore } = createInMemoryEventStore();
    // Every read, in order. The aggregate repository legitimately replays these
    // same streams at the page maximum, so the bound is proven by WHICH read
    // the existence probe is -- the first one against a stream -- rather than
    // by forbidding the complete replay that follows it.
    const reads: { streamId: string; limit: number | undefined }[] = [];
    const boundedEventStore: EventStore = {
      ...eventStore,
      readStream: async (input) => {
        reads.push({ streamId: input.streamId, limit: input.limit });
        return eventStore.readStream(input);
      },
    };
    const deps = {
      eventStore: boundedEventStore,
      checkpointStore: {},
      db: { query: async () => ({ rows: acceptedScopeMappings(profileKeyByProvider) }) },
    } as unknown as CatalogRuntimeDeps;

    return {
      eventStore,
      reads,
      firstReadPerStream: () => {
        const seen = new Map();
        for (const read of reads) if (!seen.has(read.streamId)) seen.set(read.streamId, read.limit);
        return [...seen.values()];
      },
      runtime: createSourceObservationMergeCandidateRuntime({ deps, profileVersions }),
    };
  }

  function observationRow(observationId: string, providerKey: string, externalKey: string, cardNumber: string) {
    const profile = profileKeyByProvider.get(providerKey)!;
    const normalized = normalizedObservation({
      name: `Charizard ex ${cardNumber}`,
      cardNumber,
      setId: "sv2",
      setName: "Paldea Evolved",
      expansionId: "sv2",
      expansionName: "Paldea Evolved",
      expansionAbbreviation: "PAL",
      expansionCardCount: 193,
      expansionParallelSetCardCount: null,
      seriesId: "sv",
      seriesName: "Scarlet & Violet",
      rarity: "Double Rare",
      illustrator: null,
      releaseDate: "2023-06-09",
      releaseYear: 2023,
      imageBaseUrl: null,
      imageUrls: [`https://images.example/cards/sv2-${cardNumber}.png`],
      cardVariantKey: "standard",
      cardVariantLabel: "Standard",
      cardVariantSourceKey: "normal",
      cardVariantIsPrimaryImage: true,
      imageDisclaimer: null,
      variants: {},
      externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: `product:${cardNumber}` }],
      mergeIdentity: {
        tcg: "pokemon",
        productLineName: "Pokemon TCG",
        setName: "Paldea Evolved",
        printedProductName: `Charizard ex ${cardNumber}`,
        collectorNumber: cardNumber,
        languageCode: "en",
        productForm: "pokemon-card",
      },
    });

    return {
      observation_id: observationId,
      sync_run_id: "job_sync_1",
      provider_key: providerKey,
      external_key: externalKey,
      source_url: `https://provider.example/${externalKey}`,
      language_code: "en",
      source_record_hash: `${observationId}-hash`,
      source_updated_at: null,
      observed_at: "2026-06-24T11:59:00.000Z",
      source_profile_key: profile.profileKey,
      source_profile_version: profile.profileVersion,
      source_mapping_fingerprint: `${providerKey}-mapping`,
      normalized,
      status: "observed",
      status_reason: null,
      promoted_catalog_item_id: null,
      promoted_reference_record_id: null,
      promoted_at: null,
      promotion_profile_key: null,
      promotion_profile_version: null,
      promotion_plan_fingerprint: null,
      updated_at: "2026-06-24T11:59:00.000Z",
    } satisfies SourceObservationListRow;
  }

  function twoCandidateBatch() {
    return [
      observationRow("obs_tcgdex_054", "tcgdex", "sv2-054", "54"),
      observationRow("obs_tcgplayer_054", "tcgplayer", "product:54", "54"),
      observationRow("obs_tcgdex_099", "tcgdex", "sv2-099", "99"),
    ];
  }

  it("selects create versus refresh from its declared one-event prefix", async () => {
    const { reads, firstReadPerStream, runtime } = harness();
    const observations = twoCandidateBatch();

    const created = await runtime.persistCatalogMergeCandidatesFromObservations(observations, context);
    expect(created.candidates.length).toBeGreaterThan(0);
    expect(firstReadPerStream(), "every existence probe must consume exactly the declared bound").toEqual(
      created.candidates.map(() => 1),
    );

    reads.length = 0;
    const refreshed = await runtime.persistCatalogMergeCandidatesFromObservations(observations, context);

    // Second pass: the streams are no longer empty, so the probe now selects
    // refresh -- still from one event, never from the whole history.
    expect(refreshed.candidates.map((candidate) => candidate.candidateId)).toEqual(
      created.candidates.map((candidate) => candidate.candidateId),
    );
    expect(firstReadPerStream()).toEqual(created.candidates.map(() => 1));
    expect(reads.filter((read) => read.limit === 1)).toHaveLength(created.candidates.length);
  });

  it("rejects a split onto an existing candidate from its declared one-event prefix", async () => {
    const { reads, runtime } = harness();
    const created = await runtime.persistCatalogMergeCandidatesFromObservations(twoCandidateBatch(), context);
    const original = created.candidates.find((candidate) => candidate.snapshot.membership.length > 1);
    const occupied = created.candidates.find((candidate) => candidate !== original);
    expect(original, "the fixture must produce a multi-observation candidate to split").toBeDefined();
    expect(occupied, "the fixture must produce a second candidate whose stream is already occupied").toBeDefined();

    const [firstMember, ...remainingMembers] = original!.snapshot.membership;
    reads.length = 0;

    await expect(
      runtime.services.splitCatalogMergeCandidate({
        candidateId: original!.candidateId,
        splitCandidateId: occupied!.candidateId,
        remainingSnapshot: { ...original!.snapshot, membership: remainingMembers },
        splitSnapshot: { ...original!.snapshot, membership: [firstMember] },
        reason: "separating a misgrouped observation",
        context,
      }),
    ).rejects.toThrow("Split Catalog Merge Candidate already exists.");
    expect(
      reads.filter((read) => read.streamId.includes(occupied!.candidateId)),
      "the split-target probe must consume exactly the declared bound",
    ).toEqual([{ streamId: expect.stringContaining(occupied!.candidateId), limit: 1 }]);
  });
});

function acceptedScopeMappings(profiles: Map<string, { unitKey: string }>): readonly ProviderScopeMappingRow[] {
  return [...profiles.entries()].map(
    ([providerKey, profile]) =>
      ({
        mapping_id: `map_${providerKey}_scope_paldea_evolved`,
        scope_record_id: "scope_paldea_evolved",
        provider_key: providerKey,
        unit_key: profile.unitKey,
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
      }) as unknown as ProviderScopeMappingRow,
  );
}
