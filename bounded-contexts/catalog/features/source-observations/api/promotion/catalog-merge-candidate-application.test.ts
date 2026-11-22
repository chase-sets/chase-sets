import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { bootstrapContextDatabase, drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { globalPositionFromBigInt, type StoredEvent } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../../index";
import type { CatalogRuntimeDeps } from "../../../../support/authoring-support/runtime-support";
import { seedCatalogDatabase } from "../../../../support/authoring-support/seed";
import { createCatalogServices, type CatalogServices } from "../../../../support/authoring-support/services";
import { seedContext as context } from "../../../../support/seed-support/context";
import {
  decideCatalogItem,
  evolveCatalogItem,
  initialCatalogItemState,
  type CatalogItemEvent,
} from "../../../catalog-items/domain/domain";
import {
  decideCatalogMergeCandidate,
  evolveCatalogMergeCandidate,
  initialCatalogMergeCandidateState,
  type CatalogMergeCandidateEvent,
  type CatalogMergeCandidatePromotionPlan,
  type CatalogMergeCandidateReviewSnapshot,
} from "../../domain/catalog-merge-candidate";
import { decideSourceObservation, initialSourceObservationState } from "../../domain/domain";
import { getSourceObservationDetail } from "../../read-model/queries";
import type { BlueprintId, CatalogItemId, ReferenceRecordId } from "../../../../ids";
import { createCatalogIntegrationRolloutControlPolicyFromEnv } from "../governance/catalog-integration-rollout-controls";
import {
  loadCatalogItemPromotionProfile,
  requireSourceObservationMappingContract,
} from "../source-observation-promotion-execution";
import * as referenceHierarchy from "../source-observation-promotion-reference-hierarchy";
import { createSyntheticDisplayIdentityQueryable } from "../seeding/synthetic-display-identity-queryable";
import type { CatalogAssetStorage } from "../seeding/asset-storage";
import { createPostgresPromotionTargetExclusion } from "./promotion-target-exclusion";
import type { PromotionTargetExclusion } from "./promotion-target-exclusion";
import type { PromotionTargetDiscovery } from "./promotion-target-discovery";
import {
  magicCandidate,
  magicObservation,
  observationRow,
  registeredMagicProfile,
  registeredMagicProfiles,
} from "../../tests/magic-provider-role-fixture";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../provider-integration-profiles";
import {
  catalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionIngestionUnitKey,
} from "../providers/registry";
import tcgplayerOnePieceCard from "../__fixtures__/tcgplayer-one-piece-single-card/normal.json";
import { catalogMergeCandidateStreamId, sourceObservationStreamId } from "../source-observation-stream-identity";
import {
  applyCatalogMergeCandidatePromotion,
  catalogMergeCandidateTargetId,
  loadCandidateApplication,
  requirePinnedProfileEligible,
  snapshotWithAuthoredFacts,
  shouldBlockDuplicatePrevention,
  type CatalogMergeCandidateApplicationPorts,
} from "./catalog-merge-candidate-application";
import {
  normalizeCatalogProviderSourceObservation,
  type CatalogProviderSourceObservationInput,
} from "./provider-source-observation-normalizer";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;

const pinned = { providerKey: "tcgdex", profileKey: "pokemon-tcg", profileVersion: "2026.06.24" };

function version(
  overrides: Partial<{
    profileKey: string;
    profileVersion: string;
    lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"];
    active: boolean;
    capabilities: readonly string[];
    unitKey: string;
  }> = {},
): CatalogProviderIntegrationProfileVersionRecord {
  return {
    providerKey: "tcgdex",
    profileKey: overrides.profileKey ?? pinned.profileKey,
    profileVersion: overrides.profileVersion ?? pinned.profileVersion,
    lifecycle: overrides.lifecycle ?? "active",
    active: overrides.active ?? true,
    ingestionUnitIdentity: { unitKey: overrides.unitKey ?? "tcgdex:pokemon:en" },
    profile: {
      status: "active",
      capabilities: overrides.capabilities ?? ["catalog-item-promotion"],
      normalizedObservationMapping: { kind: "pokemon-card" },
    },
  } as unknown as CatalogProviderIntegrationProfileVersionRecord;
}

const deprecated = () => version({ lifecycle: "deprecated", active: false });

describe("pinned application profile eligibility", () => {
  it("keeps an active pinned profile eligible", () => {
    expect(requirePinnedProfileEligible([version()], pinned)).toMatchObject(pinned);
  });

  it("keeps a pin eligible when a competing version of the same profile was activated", () => {
    const successor = version({ profileVersion: "2026.10.01" });
    expect(requirePinnedProfileEligible([deprecated(), successor], pinned)).toMatchObject({
      ...pinned,
      lifecycle: "deprecated",
    });
  });

  it.each([
    ["deprecated with no successor", [deprecated()]],
    [
      "deprecated beside an unrelated active unit",
      [
        deprecated(),
        version({ profileKey: "pokemon-tcg-ja", profileVersion: "2026.10.01", unitKey: "tcgdex:pokemon:ja" }),
      ],
    ],
    ["retired", [version({ lifecycle: "retired", active: false })]],
    ["stripped of promotion capability", [version({ capabilities: ["source-observation-import"] })]],
  ])("refuses a pin that was %s", (_name, versions) => {
    expect(() => requirePinnedProfileEligible(versions, pinned)).toThrow("promotion-application-profile-revoked");
  });

  it("refuses a pin whose record is missing or duplicated", () => {
    expect(() => requirePinnedProfileEligible([], pinned)).toThrow("promotion-application-profile-missing");
    expect(() => requirePinnedProfileEligible([version(), version()], pinned)).toThrow(
      "promotion-application-profile-missing",
    );
  });

  it("allocates a deterministic candidate target only from the candidate id", () => {
    expect(catalogMergeCandidateTargetId("cand_a")).toBe(catalogMergeCandidateTargetId("cand_a"));
    expect(catalogMergeCandidateTargetId("cand_a")).toMatch(/^cat_candidate_[a-f0-9]{64}$/);
    expect(catalogMergeCandidateTargetId("cand_a")).not.toBe(catalogMergeCandidateTargetId("cand_b"));
  });

  it("does not block a plan for review-only bridge evidence without concrete duplicate candidates", () => {
    expect(
      shouldBlockDuplicatePrevention({
        status: "review-only",
        ruleKey: "exact-external-catalog-item-reference",
        candidateCatalogItemIds: [],
        evidenceSummary: {
          ruleKey: "exact-external-catalog-item-reference",
          matchKind: "exact-external-catalog-item-reference",
          evidenceText: "0 external Catalog Item reference(s)",
          candidateCatalogItemIds: [],
        },
      }),
    ).toBe(false);
    expect(
      shouldBlockDuplicatePrevention({
        status: "review-only",
        ruleKey: "exact-external-catalog-item-reference",
        candidateCatalogItemIds: ["cat_existing"],
        evidenceSummary: {
          ruleKey: "exact-external-catalog-item-reference",
          matchKind: "exact-external-catalog-item-reference",
          evidenceText: "1 external Catalog Item reference(s)",
          candidateCatalogItemIds: ["cat_existing"],
        },
      }),
    ).toBe(true);
    expect(
      shouldBlockDuplicatePrevention({
        status: "blocked",
        ruleKey: "exact-external-catalog-item-reference",
        diagnosticText: "Multiple Catalog Items match this Source Observation's external catalog item references.",
        candidateCatalogItemIds: [],
        evidenceSummary: {
          ruleKey: "exact-external-catalog-item-reference",
          matchKind: "exact-external-catalog-item-reference",
          evidenceText: "0 external Catalog Item reference(s)",
          candidateCatalogItemIds: [],
        },
      }),
    ).toBe(true);
  });
});

describe("retained application checkpoint replay", () => {
  const candidateId = "cand_synthetic";
  const at = "2026-10-11T00:00:00.000Z";
  const initiator = { jobId: "job_synthetic", unitId: candidateId };
  type Event = Readonly<{ type: string; data: Record<string, unknown> }>;

  // Created, approved, planned and applied exactly as the decider emits them.
  function lifecycle() {
    const created = decideCatalogMergeCandidate(initialCatalogMergeCandidateState, {
      type: "CreateCatalogMergeCandidate",
      candidateId,
      snapshot: reviewSnapshot(),
      createdAt: at,
    })[0]!;
    const createdState = evolveCatalogMergeCandidate(initialCatalogMergeCandidateState, created);
    const approved = decideCatalogMergeCandidate(createdState, {
      type: "PromoteCatalogMergeCandidate",
      reason: "Synthetic approval.",
      actor: { userId: "usr_synthetic", accountId: "acc_synthetic" },
      promotedAt: at,
    })[0]!;
    const approvedState = evolveCatalogMergeCandidate(createdState, approved);
    const plan = applicationPlan(2);
    const planned = decideCatalogMergeCandidate(approvedState, {
      type: "PlanCatalogMergeCandidatePromotion",
      plan,
      plannedAt: at,
    })[0]!;
    const applied = decideCatalogMergeCandidate(evolveCatalogMergeCandidate(approvedState, planned), {
      type: "RecordCatalogMergeCandidatePromotionApplied",
      application: completionOf(plan),
      appliedAt: at,
    })[0]!;
    const deferred = decideCatalogMergeCandidate(createdState, {
      type: "DeferCatalogMergeCandidate",
      reason: "Synthetic deferral.",
      actor: { userId: "usr_synthetic", accountId: "acc_synthetic" },
      deferredAt: at,
    })[0]!;
    return { created, approved, planned, applied, deferred };
  }

  function applicationPlan(approvalVersion: number): CatalogMergeCandidatePromotionPlan {
    const target = catalogMergeCandidateTargetId(candidateId);
    return {
      approvalVersion,
      ...initiator,
      catalogItemId: target,
      mode: "create",
      targetBaseline: { streamVersion: 0, status: null },
      identityFingerprint: reviewSnapshot().identityFingerprint,
      membership: reviewSnapshot().membership,
      profiles: [{ providerKey: "tcgdex", profileKey: "pokemon-tcg", profileVersion: "2026.06.24" }],
      catalogMapping: { blueprintId: "bp_synthetic", categoryId: "cat_synthetic", fields: [] },
      referenceRecordIds: {},
      assetPlan: null,
      commands: [{ type: "CreateCatalogItem", itemId: target }],
      planFingerprint: `sha256:${"a".repeat(64)}`,
    };
  }

  function completionOf(plan: CatalogMergeCandidatePromotionPlan) {
    return {
      approvalVersion: plan.approvalVersion,
      catalogItemId: plan.catalogItemId,
      appliedMode: plan.mode,
      planFingerprint: plan.planFingerprint,
      jobId: plan.jobId,
      unitId: plan.unitId,
    };
  }

  // A checkpoint pair the decider would never emit, written as raw retained history.
  function checkpoints(plan: Record<string, unknown>, candidate = candidateId): readonly Event[] {
    const completion = completionOf(plan as CatalogMergeCandidatePromotionPlan);
    return [
      { type: "catalog.merge-candidate.promotion-planned", data: { candidateId: candidate, plan, plannedAt: at } },
      {
        type: "catalog.merge-candidate.promotion-applied",
        data: { candidateId: candidate, ...completion, appliedAt: at },
      },
    ];
  }

  function retained(events: readonly (Event | CatalogMergeCandidateEvent)[]): EventStore {
    const rows = events.map((event, index) => ({
      eventType: event.type,
      payload: structuredClone(event.data),
      streamVersion: index + 1,
    }));
    return {
      readStream: async ({ streamId, fromVersion = 1, limit = 1000 }: Parameters<EventStore["readStream"]>[0]) =>
        streamId === catalogMergeCandidateStreamId(candidateId)
          ? rows.filter((row) => row.streamVersion >= fromVersion).slice(0, limit)
          : [],
    } as unknown as EventStore;
  }

  // Only the event store is wired: a replay that tried to plan, execute or append would fail differently.
  function applicationPorts(eventStore: EventStore) {
    const applyCandidateCommandAtVersion = vi.fn();
    const ports = { deps: { eventStore }, applyCandidateCommandAtVersion };
    return { ports: ports as unknown as CatalogMergeCandidateApplicationPorts, applyCandidateCommandAtVersion };
  }

  function apply(eventStore: EventStore, unit = initiator) {
    return applyCatalogMergeCandidatePromotion(applicationPorts(eventStore).ports, {
      candidateId,
      ...unit,
      approvalReason: "Synthetic.",
      context: {} as never,
    });
  }

  it("reads a created/approved prefix without checkpoints unchanged", async () => {
    const { created, approved } = lifecycle();
    const loaded = await loadCandidateApplication(retained([created, approved]), candidateId);
    expect(loaded).toMatchObject({ version: 2, approvalVersion: 2 });
    expect(loaded.state).toMatchObject({ status: "promoted", promotionPlan: null, promotionApplication: null });
  });

  it("loads the choices from the recorded approval for application planning", async () => {
    const { created } = lifecycle();
    const resolution = {
      conflictCode: "name-mismatch",
      fieldPath: "catalogItem.name",
      chosenValue: "Kept catalog name",
      reason: "Keep the reviewed Catalog value.",
      observationIds: ["obs_synthetic"],
    };
    const approved = decideCatalogMergeCandidate(
      evolveCatalogMergeCandidate(initialCatalogMergeCandidateState, created),
      {
        type: "PromoteCatalogMergeCandidate",
        reason: "Resolved the name.",
        actor: { userId: "usr_synthetic", accountId: "acc_synthetic" },
        promotedAt: at,
        conflictResolutions: [resolution],
      },
    )[0]!;
    const loaded = await loadCandidateApplication(retained([created, approved]), candidateId);
    expect(loaded.resolvedConflicts).toEqual([resolution]);
    expect(loaded.state.snapshot?.proposedCatalogItemFacts.name).toBe("Synthetic review card");
  });

  it("recovers one valid plan and completion for its initiating unit only, with no writes", async () => {
    const { created, approved, planned, applied } = lifecycle();
    const eventStore = retained([created, approved, planned, applied]);
    const { ports, applyCandidateCommandAtVersion } = applicationPorts(eventStore);
    await expect(
      applyCatalogMergeCandidatePromotion(ports, {
        candidateId,
        ...initiator,
        approvalReason: "Synthetic.",
        context: {} as never,
      }),
    ).resolves.toEqual({
      candidateId,
      status: "promoted",
      catalogItemId: null,
      reason: null,
      appliedCatalogItemId: catalogMergeCandidateTargetId(candidateId),
      appliedMode: "create",
      approvalVersion: 2,
      planFingerprint: `sha256:${"a".repeat(64)}`,
    });
    await expect(apply(eventStore, { jobId: "job_later", unitId: candidateId })).resolves.toMatchObject({
      status: "skipped-not-eligible",
      reason: "Catalog Merge Candidate application is already complete.",
    });
    expect(applyCandidateCommandAtVersion).not.toHaveBeenCalled();
  });

  it.each<[string, () => readonly (Event | CatalogMergeCandidateEvent)[]]>([
    [
      "a plan with no commands and an invalid fingerprint, completed by a matching record",
      () => {
        const { created, approved } = lifecycle();
        const poisoned = { ...applicationPlan(2), commands: [], planFingerprint: "synthetic-invalid-fingerprint" };
        return [created, approved, ...checkpoints(poisoned)];
      },
    ],
    [
      "a plan whose fingerprint is not the planner's sha256 format",
      () => {
        const { created, approved } = lifecycle();
        return [created, approved, ...checkpoints({ ...applicationPlan(2), planFingerprint: "synthetic-invalid" })];
      },
    ],
    [
      "a plan without approved provenance or profile evidence",
      () => {
        const { created, approved } = lifecycle();
        return [created, approved, ...checkpoints({ ...applicationPlan(2), membership: [], profiles: [] })];
      },
    ],
    [
      "a repeated completion",
      () => {
        const { created, approved, planned, applied } = lifecycle();
        return [created, approved, planned, applied, applied];
      },
    ],
    [
      "a repeated plan",
      () => {
        const { created, approved, planned, applied } = lifecycle();
        return [created, approved, planned, planned, applied];
      },
    ],
    [
      "checkpoints recorded for another candidate",
      () => {
        const { created, approved } = lifecycle();
        return [created, approved, ...checkpoints(applicationPlan(2), "cand_synthetic_other")];
      },
    ],
    [
      "a completion recorded before its plan",
      () => {
        const { created, approved, planned, applied } = lifecycle();
        return [created, approved, applied, planned];
      },
    ],
    [
      "a plan recorded before its approval",
      () => {
        const { created, approved } = lifecycle();
        const [planned, applied] = checkpoints(applicationPlan(3));
        return [created, planned!, approved, applied!];
      },
    ],
    [
      "a review event after the bound plan",
      () => {
        const { created, approved, planned, deferred } = lifecycle();
        return [created, approved, planned, deferred];
      },
    ],
    [
      "a completion that disagrees with its plan",
      () => {
        const { created, approved, planned, applied } = lifecycle();
        return [created, approved, planned, { ...applied, data: { ...applied.data, catalogItemId: "cat_synthetic" } }];
      },
    ],
  ])("refuses retained history with %s before the applied shortcut", async (_name, history) => {
    const conflict = /^promotion-application-conflicting-history/;
    await expect(loadCandidateApplication(retained(history()), candidateId)).rejects.toThrow(conflict);
    await expect(apply(retained(history()))).rejects.toThrow(conflict);
  });
});

describe("Catalog Item authority from each member's own reviewed provider unit (registered Magic profiles)", () => {
  const scopeRecordId = "scope_time_spiral";
  const at = "2026-10-27T00:00:00.000Z";
  const scryfallCardPrint = registeredMagicProfile("scryfall-card-print");
  type Event = Readonly<{ type: string; data: unknown }>;
  type Arranged = Readonly<{
    candidateId: string;
    snapshot: CatalogMergeCandidateReviewSnapshot;
    eventStore: EventStore;
  }>;

  // The real matcher builds the candidate; member streams are what the
  // Source Observation decider records for each mapped observation.
  function arrange(
    members: readonly CatalogProviderSourceObservationInput[],
    review: (snapshot: CatalogMergeCandidateReviewSnapshot) => CatalogMergeCandidateReviewSnapshot = (s) => s,
  ): Arranged {
    const matched = magicCandidate(members.map(observationRow), scopeRecordId);
    const snapshot = review(matched.snapshot);
    const streams = new Map<string, readonly Event[]>([
      [
        catalogMergeCandidateStreamId(matched.candidateId),
        decideCatalogMergeCandidate(initialCatalogMergeCandidateState, {
          type: "CreateCatalogMergeCandidate",
          candidateId: matched.candidateId,
          snapshot,
          createdAt: at,
        }),
      ],
      ...members.map((member): [string, readonly Event[]] => [
        sourceObservationStreamId(member.observationId),
        decideSourceObservation(initialSourceObservationState, { type: "RecordSourceObservation", ...member }),
      ]),
    ]);
    const eventStore = {
      readStream: async ({ streamId, fromVersion = 1, limit = 1000 }: Parameters<EventStore["readStream"]>[0]) =>
        (streams.get(streamId) ?? [])
          .map((event, index) => ({
            eventType: event.type,
            payload: structuredClone(event.data),
            streamVersion: index + 1,
          }))
          .filter((row) => row.streamVersion >= fromVersion)
          .slice(0, limit),
    } as unknown as EventStore;
    return { candidateId: matched.candidateId, snapshot, eventStore };
  }

  // Nothing past provider-role resolution is wired: a candidate write, a
  // database read or a Reference Data call is recorded and fails by name.
  async function apply(arranged: Arranged, versions = registeredMagicProfiles()) {
    const touched: string[] = [];
    const allowed: unknown[] = [];
    const refuse = (what: string) => () => {
      touched.push(what);
      throw new Error(`unexpected-${what}`);
    };
    const ports = {
      deps: { eventStore: arranged.eventStore, db: { query: refuse("database") } },
      referenceData: {},
      profileVersions: {
        listProfileVersions: async (providerKey: string) =>
          versions.filter((version) => version.providerKey === providerKey),
        getActiveProfileVersion: refuse("profile-selector"),
      },
      rolloutControlPolicy: { assertAllowed: (input: unknown) => void allowed.push(input) },
      applyCandidateCommandAtVersion: refuse("candidate-write"),
    } as unknown as CatalogMergeCandidateApplicationPorts;
    const settled = await applyCatalogMergeCandidatePromotion(ports, {
      candidateId: arranged.candidateId,
      jobId: "job_provider_roles",
      unitId: arranged.candidateId,
      approvalReason: "Synthetic.",
      context: {} as never,
    }).then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error }),
    );
    return { ...settled, touched: [...new Set(touched)], allowed };
  }

  const mixed = (card: Parameters<typeof magicObservation>[1] = {}) => [
    magicObservation("mtgjson-card"),
    magicObservation("scryfall-card-print", card),
  ];
  const scryfallPromotion = {
    capability: "promotion",
    providerKey: "scryfall",
    unitKey: catalogProviderProfileVersionIngestionUnitKey(scryfallCardPrint),
  };
  const replaced = (overrides: Partial<CatalogProviderIntegrationProfileVersionRecord>) =>
    registeredMagicProfiles().map((version) =>
      version === scryfallCardPrint ? { ...version, ...overrides } : version,
    );
  const successor = (kind = scryfallCardPrint.profile.normalizedObservationMapping.kind) =>
    ({
      ...scryfallCardPrint,
      profileVersion: "2026.10.27",
      profile: {
        ...scryfallCardPrint.profile,
        normalizedObservationMapping: { ...scryfallCardPrint.profile.normalizedObservationMapping, kind },
      },
    }) as CatalogProviderIntegrationProfileVersionRecord;

  it("AC1 reproduction: a mixed MTGJSON/Scryfall candidate passes its MTGJSON member and resolves only the Scryfall card-print unit", async () => {
    const arranged = arrange(mixed());
    expect(arranged.snapshot.membership.map((member) => member.providerKey)).toEqual(["mtgjson", "scryfall"]);
    expect(arranged.snapshot.conflicts).toEqual([]);

    const { error, touched, allowed } = await apply(arranged);

    // The pre-repair baseline refused here with promotion-plan-blocked:promotion-profile-unavailable
    // at the MTGJSON lookup. Now only the Scryfall member is resolved and gated, and the
    // application proceeds to load its Catalog mapping (the first unwired dependency).
    expect(allowed).toEqual([scryfallPromotion]);
    expect(touched).toEqual(["database"]);
    expect(error).toMatchObject({ message: "unexpected-database" });
  });

  // The snapshot a reviewer's edit that dropped the Scryfall external reference leaves.
  const withoutScryfallReference = (snapshot: CatalogMergeCandidateReviewSnapshot) => ({
    ...snapshot,
    matches: { catalogItemId: null, productIds: [] },
    proposedExternalCatalogItemReferences: snapshot.proposedExternalCatalogItemReferences.filter(
      (entry) => entry.providerKey !== "scryfall",
    ),
  });

  it.each([
    ["with its reviewed Scryfall external reference", true],
    ["whose reviewer dropped the Scryfall external reference", false],
  ])("AC2: an MTGJSON-only candidate %s is skipped as reference-only with zero writes", async (_name, reference) => {
    const arranged = arrange([magicObservation("mtgjson-card")], reference ? undefined : withoutScryfallReference);
    expect(
      arranged.snapshot.proposedExternalCatalogItemReferences.some((entry) => entry.providerKey === "scryfall"),
    ).toBe(reference);

    const { result, error, touched, allowed } = await apply(arranged);

    expect(error).toBeNull();
    expect(result).toStrictEqual({
      candidateId: arranged.candidateId,
      status: "skipped-not-eligible",
      disposition: "reference-only",
      catalogItemId: null,
      reason: expect.stringMatching(/^Catalog Merge Candidate has no item-producing member/),
      appliedCatalogItemId: null,
      appliedMode: null,
      approvalVersion: null,
      planFingerprint: null,
    });
    expect(touched).toEqual([]);
    expect(allowed).toEqual([]);
  });

  it("AC2: an MTGJSON set-reference-only candidate is skipped as reference-only with zero writes", async () => {
    const arranged = arrange([magicObservation("mtgjson-set")]);

    const { result, error, touched, allowed } = await apply(arranged);

    expect(error).toBeNull();
    expect(result).toStrictEqual({
      candidateId: arranged.candidateId,
      status: "skipped-not-eligible",
      disposition: "reference-only",
      catalogItemId: null,
      reason: expect.stringMatching(/^Catalog Merge Candidate has no item-producing member/),
      appliedCatalogItemId: null,
      appliedMode: null,
      approvalVersion: null,
      planFingerprint: null,
    });
    expect(touched).toEqual([]);
    expect(allowed).toEqual([]);
  });

  it("keeps an unregistered non-promotable member blocked", async () => {
    const arranged = arrange([magicObservation("mtgjson-set")], (snapshot) => snapshot);
    const versions = registeredMagicProfiles().filter((version) => version.profileKey !== "mtg-set-reference-data");

    const { result, error, touched, allowed } = await apply(arranged, versions);

    expect(result).toBeNull();
    expect(error).toMatchObject({ code: "promotion-plan-blocked:no-promotable-member" });
    expect(touched).toEqual([]);
    expect(allowed).toEqual([]);
  });

  it("AC3: an active Scryfall card-print profile never qualifies a Scryfall member reviewed under the image-evidence unit", async () => {
    const arranged = arrange([magicObservation("mtgjson-card"), magicObservation("scryfall-image-evidence")]);
    expect(arranged.snapshot.membership.map((member) => member.sourceProfileKey)).toEqual([
      "mtg-card-reference-data",
      "mtg-card-image-evidence",
    ]);

    const { result, touched, allowed } = await apply(arranged);

    expect(result).toMatchObject({ status: "skipped-not-eligible", disposition: "reference-only" });
    expect(touched).toEqual([]);
    expect(allowed).toEqual([]);
  });

  it("AC3: a reviewed tuple that names the card-print unit for an image-evidence revision qualifies nothing", async () => {
    const arranged = arrange(
      [magicObservation("mtgjson-card"), magicObservation("scryfall-image-evidence")],
      (snapshot) => ({
        ...snapshot,
        membership: snapshot.membership.map((member) =>
          member.providerKey === "scryfall" ? { ...member, sourceProfileKey: scryfallCardPrint.profileKey } : member,
        ),
      }),
    );

    const { error, touched, allowed } = await apply(arranged);

    expect(error).toMatchObject({ code: "promotion-plan-blocked:member-revision-missing" });
    expect(touched).toEqual([]);
    expect(allowed).toEqual([]);
  });

  it.each<[string, string, () => readonly CatalogProviderIntegrationProfileVersionRecord[]]>([
    [
      "is not registered",
      "promotion-profile-unavailable",
      () => registeredMagicProfiles().filter((version) => version !== scryfallCardPrint),
    ],
    [
      "is deprecated without a successor",
      "promotion-profile-inactive",
      () => replaced({ lifecycle: "deprecated", active: false }),
    ],
    ["is retired", "promotion-profile-inactive", () => replaced({ lifecycle: "retired", active: false })],
    ["is registered twice", "promotion-profile-ambiguous", () => [...registeredMagicProfiles(), scryfallCardPrint]],
    [
      "is active in two competing versions",
      "promotion-profile-ambiguous",
      () => [...registeredMagicProfiles(), successor()],
    ],
    [
      "is succeeded by a version that maps another kind",
      "promotion-profile-incompatible",
      () => [...replaced({ lifecycle: "deprecated", active: false }), successor("magic-sealed-product")],
    ],
  ])(
    "AC2/AC3: the Scryfall card-print unit that %s fails closed with %s and no writes",
    async (_name, code, versions) => {
      const { error, touched } = await apply(arrange(mixed()), versions());

      expect(error).toMatchObject({ code: `promotion-plan-blocked:${code}` });
      expect(touched).toEqual([]);
    },
  );

  it("AC2/AC3: a retained Scryfall revision without the required name fails closed before planning", async () => {
    const [mtgjson, scryfall] = mixed();
    const { name: _name, ...nameless } = scryfall!.normalized as unknown as Record<string, unknown>;
    const arranged = arrange([mtgjson!, { ...scryfall!, normalized: nameless as never }]);
    // The approved name exists only because the MTGJSON member carries it.
    expect(arranged.snapshot.proposedCatalogItemFacts.name).toBe("Fury Sliver");

    const { error, touched, allowed } = await apply(arranged);

    expect(error).toMatchObject({ code: "promotion-plan-blocked:promotion-facts-missing" });
    expect(allowed).toEqual([scryfallPromotion]);
    expect(touched).toEqual([]);
  });

  it("AC3: an approved fact that only the MTGJSON member carries never authors the Item", async () => {
    // As checked in, the Scryfall fixture has no rarity; the approved rarity is MTGJSON's.
    const arranged = arrange(mixed({ scryfallRarity: null }));
    expect(arranged.snapshot.proposedCatalogItemFacts.rarity).toBe("uncommon");

    const { error, touched } = await apply(arranged);

    // Optional reference-only facts are omitted; planning continues until the
    // first unwired database dependency. A fallback mutant would instead
    // carry MTGJSON rarity into the Item plan and fail the DB discriminant.
    expect(error).toMatchObject({ message: "unexpected-database" });
    expect(touched).toEqual(["database"]);
  });

  it("AC3: an optional fact recovered from candidate identity is not authored by the Scryfall member", async () => {
    const [mtgjson, scryfall] = mixed();
    const { cardNumber: _cardNumber, ...withoutCardNumber } = scryfall!.normalized as unknown as Record<
      string,
      unknown
    >;
    const arranged = arrange([mtgjson!, { ...scryfall!, normalized: withoutCardNumber as never }]);
    const effective = snapshotWithAuthoredFacts(arranged.snapshot, [
      {
        revision: { normalized: withoutCardNumber, providerKey: "scryfall" },
        normalized: withoutCardNumber,
        version: scryfallCardPrint,
      },
    ] as never);

    expect(effective.proposedCatalogItemFacts).not.toHaveProperty("collectorNumber");
    expect(effective.fieldProvenance).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldPath: "catalogItem.collectorNumber" })]),
    );
  });

  it("AC3: an optional MTGJSON-only rarity is omitted before display planning", () => {
    const [mtgjson, scryfall] = mixed({ scryfallRarity: null });
    const arranged = arrange([mtgjson!, scryfall!]);
    const effective = snapshotWithAuthoredFacts(arranged.snapshot, [
      {
        revision: { normalized: scryfall!.normalized, providerKey: "scryfall" },
        normalized: scryfall!.normalized,
        version: scryfallCardPrint,
      },
    ] as never);

    expect(effective.proposedCatalogItemFacts).not.toHaveProperty("rarity");
    expect(effective.fieldProvenance).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldPath: "catalogItem.rarity" })]),
    );
  });

  it("AC3: a reviewer's correction is reviewed authority, not reference facts", async () => {
    // The snapshot a reviewer's rarity correction leaves: the value with manual provenance on the
    // first member, as the merge-candidate runtime records an edit.
    const arranged = arrange(mixed({ scryfallRarity: null }), (snapshot) => {
      const anchor = snapshot.membership[0]!;
      return {
        ...snapshot,
        matches: { catalogItemId: null, productIds: [] },
        proposedCatalogItemFacts: { ...snapshot.proposedCatalogItemFacts, rarity: "uncommon" },
        fieldProvenance: [
          ...snapshot.fieldProvenance.filter((entry) => entry.fieldPath !== "catalogItem.rarity"),
          {
            fieldPath: "catalogItem.rarity",
            value: "uncommon",
            observationId: anchor.observationId,
            providerKey: anchor.providerKey,
            sourceProfileKey: anchor.sourceProfileKey,
            sourceProfileVersion: anchor.sourceProfileVersion,
            confidence: "manual",
            evidence: { operatorCorrection: true },
          },
        ],
      };
    });

    const { error, touched } = await apply(arranged);

    expect(error).toMatchObject({ message: "unexpected-database" });
    expect(touched).toEqual(["database"]);
  });
});

describe("Catalog Merge Candidate Catalog-owned pictures", () => {
  const scryfall = magicObservation("scryfall-card-print");
  const at = scryfall.observedAt;
  const existingId = "cat_synthetic_existing" as CatalogItemId;
  const referenceId = "ref_synthetic_set" as ReferenceRecordId;
  const reference = { targetReferenceRecordId: referenceId, referenceRecordIdsByTypeKey: {} };
  const magic = registeredMagicProfile("scryfall-card-print");
  const imageUrls: Readonly<Record<string, string>> = {
    scryfall: "https://cards.scryfall.io/normal/front/synthetic.jpg?1790000000",
    scrydex: "https://images.scrydex.com/onepiece/synthetic/large",
    tcgplayer: "https://tcgplayer-cdn.tcgplayer.com/product/123_200w.jpg",
    ygoprodeck: "https://images.ygoprodeck.com/images/cards/123.jpg",
  };
  type ImageKind =
    | "magic-card-print"
    | "one-piece-card-print"
    | "one-piece-sealed-product"
    | "yugioh-card-print"
    | "yugioh-sealed-product";

  beforeEach(() => {
    vi.spyOn(referenceHierarchy, "resolvePromotionReferenceHierarchy").mockResolvedValue(reference);
    vi.spyOn(referenceHierarchy, "resolvePromotionReferenceHierarchyReadOnly").mockResolvedValue(reference);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function member(
    providerKey: string,
    kind: ImageKind,
    url = imageUrls[providerKey] ?? imageUrls.ygoprodeck!,
  ): { observation: CatalogProviderSourceObservationInput; version: CatalogProviderIntegrationProfileVersionRecord } {
    const profile = {
      ...magic.profile,
      duplicatePreventionMapping: { ...magic.profile.duplicatePreventionMapping, rules: [] },
      normalizedObservationMapping: { ...magic.profile.normalizedObservationMapping, kind },
    };
    const version = { ...magic, providerKey, profile };
    const observation = {
      ...scryfall,
      observationId: `obs_synthetic_${providerKey}_${kind}`,
      providerKey,
      sourceUpdatedAt: null,
      normalized: {
        ...scryfall.normalized,
        kind,
        tcg: kind === "magic-card-print" ? "magic" : kind.startsWith("one-piece-") ? "one-piece" : "yugioh",
        imageUrls: [url],
      },
    } as CatalogProviderSourceObservationInput;
    return { observation, version };
  }

  async function arrange(
    members: readonly ReturnType<typeof member>[],
    existing: readonly CatalogItemEvent[] | null = null,
  ) {
    const candidateId = "cand_synthetic_picture";
    const candidateStream = catalogMergeCandidateStreamId(candidateId);
    const targetId = existing ? existingId : (catalogMergeCandidateTargetId(candidateId) as CatalogItemId);
    const itemStream = `catalog.item-${targetId}`;
    const snapshot: CatalogMergeCandidateReviewSnapshot = {
      ...reviewSnapshot(),
      matches: { catalogItemId: existing ? existingId : null, productIds: [] },
      proposedCatalogItemFacts: { name: "Fury Sliver" },
      membership: members.map(({ observation }) => ({
        observationId: observation.observationId,
        syncRunId: null,
        providerKey: observation.providerKey,
        externalKey: observation.externalKey,
        sourceRecordHash: observation.sourceRecordHash,
        sourceProfileKey: observation.sourceProfileKey,
        sourceProfileVersion: observation.sourceProfileVersion,
        sourceMappingFingerprint: observation.sourceMappingFingerprint,
        observedAt: at,
        addedAt: at,
      })),
    };
    const created = decideCatalogMergeCandidate(initialCatalogMergeCandidateState, {
      type: "CreateCatalogMergeCandidate",
      candidateId,
      snapshot,
      createdAt: at,
    });
    let candidateState = created.reduce(evolveCatalogMergeCandidate, initialCatalogMergeCandidateState);
    type Event = Readonly<{ type: string; data: unknown }>;
    const streams = new Map<string, readonly Event[]>([
      [candidateStream, created],
      [itemStream, existing ?? []],
    ]);
    function recordCandidate(command: Parameters<typeof decideCatalogMergeCandidate>[1]) {
      const events = decideCatalogMergeCandidate(candidateState, command);
      streams.set(candidateStream, [...streams.get(candidateStream)!, ...events]);
      candidateState = events.reduce(evolveCatalogMergeCandidate, candidateState);
      return candidateState;
    }
    recordCandidate({
      type: "PromoteCatalogMergeCandidate",
      reason: "Synthetic approval.",
      actor: { userId: "usr_synthetic", accountId: "acc_synthetic" },
      promotedAt: at,
    });
    for (const { observation } of members) {
      streams.set(
        sourceObservationStreamId(observation.observationId),
        decideSourceObservation(initialSourceObservationState, { type: "RecordSourceObservation", ...observation }),
      );
    }
    let itemEvents = existing ?? [];
    let item = itemEvents.reduce(evolveCatalogItem, initialCatalogItemState);
    function recordItem(events: readonly CatalogItemEvent[]) {
      itemEvents = [...itemEvents, ...events];
      streams.set(itemStream, itemEvents);
      item = events.reduce(evolveCatalogItem, item);
    }
    const rows = (streamId: string): StoredEvent[] =>
      (streams.get(streamId) ?? []).map((event, index) => ({
        eventId: `evt_synthetic_${index + 1}`,
        streamId,
        eventType: event.type,
        payload: structuredClone(event.data) as JsonObject,
        streamVersion: index + 1,
        globalPosition: globalPositionFromBigInt(BigInt(index + 1)),
        tenantId: context.tenantId,
        performedByUserId: context.audit.performedByUserId,
        forAccountId: context.audit.forAccountId,
        occurredAt: at as StoredEvent["occurredAt"],
        recordedAt: at as StoredEvent["recordedAt"],
        metadata: {},
      }));
    const eventStore: EventStore = {
      readStream: async ({ streamId, fromVersion = 1, limit = 1000 }: Parameters<EventStore["readStream"]>[0]) =>
        rows(streamId).slice(fromVersion - 1, fromVersion - 1 + limit),
      appendToStream: vi.fn(),
      readAll: vi.fn(),
    };
    const promotionTargetExclusion: PromotionTargetExclusion = {
      async acquire({ selectTarget }) {
        const evidence: PromotionTargetDiscovery = {
          items: new Map([[targetId, item]]),
          histories: new Map([[itemStream, rows(itemStream)]]),
          bindings: new Map(),
          sources: new Map(),
          keys: new Map(),
        };
        return {
          targetId: await selectTarget(evidence, vi.fn()),
          evidence,
          append: async ({ expectedVersion, events }) => {
            expect(expectedVersion).toBe(itemEvents.length);
            const previousLength = itemEvents.length;
            const codec = createPassthroughDomainEventCodec<CatalogItemEvent>();
            recordItem(
              events.map((event, index) =>
                codec.decode({
                  ...event,
                  streamVersion: previousLength + index + 1,
                } as Parameters<typeof codec.decode>[0]),
              ),
            );
            return rows(itemStream).slice(previousLength);
          },
          guard: vi.fn(),
          preparePlan: async () => 0,
          commandHandler: async ({ command }) => {
            const events = decideCatalogItem(item, command);
            const previousLength = itemEvents.length;
            recordItem(events);
            return {
              version: itemEvents.length,
              state: item,
              newEvents: events,
              storedEvents: rows(itemStream).slice(previousLength),
            };
          },
        };
      },
    };
    const db = createSyntheticDisplayIdentityQueryable({
      referenceRecords: [
        {
          reference_record_id: referenceId,
          type_key: "set",
          key: "synthetic-set",
          name: "Synthetic set",
          attributes: {},
          relationships: [],
          status: "active",
        },
      ],
      fallback: {
        async query<T>(sql: string, values: readonly unknown[] = []) {
          const result = sql.includes(" AS id FROM catalog_")
            ? [{ id: values[0] }]
            : sql.includes("SELECT product_asset_sets FROM catalog_items")
              ? [{ product_asset_sets: item.productAssetSets }]
              : [];
          return { rows: result as T[], rowCount: result.length };
        },
      },
    });
    const putObject = vi.fn<CatalogAssetStorage["putObject"]>(async ({ key }) => ({
      key,
      publicUrl: `https://assets.example/${key}`,
    }));
    const bytes = await sharp({
      create: { width: 12, height: 16, channels: 3, background: "#633399" },
    })
      .png()
      .toBuffer();
    const fetcher = vi.fn(
      async () => new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const ports = {
      deps: { eventStore, db, promotionTargetExclusion, assetStorage: { putObject } },
      referenceData: {},
      profileVersions: {
        listProfileVersions: async (providerKey: string) =>
          members.map(({ version }) => version).filter((entry) => entry.providerKey === providerKey),
      },
      rolloutControlPolicy: { assertAllowed: vi.fn() },
      applyCandidateCommandAtVersion: async ({
        command,
      }: Parameters<CatalogMergeCandidateApplicationPorts["applyCandidateCommandAtVersion"]>[0]) =>
        recordCandidate(command),
    } as unknown as CatalogMergeCandidateApplicationPorts;
    const apply = (jobId = "job_synthetic_picture") =>
      applyCatalogMergeCandidatePromotion(ports, {
        candidateId,
        jobId,
        unitId: candidateId,
        approvalReason: "Synthetic approval.",
        context,
      });
    return {
      apply,
      fetcher,
      putObject,
      plan: () => candidateState.promotionPlan!,
      item: () => item,
      itemEvents: () => itemEvents,
    };
  }

  function expectCatalogPicture(fixture: Awaited<ReturnType<typeof arrange>>, providerKey: string) {
    const [asset] = fixture.item().productAssetSets;
    expect(asset?.sourcePolicy).toMatchObject({
      sourceProviderKey: providerKey,
      approval: "catalog-owned-rehost-approved",
    });
    const detail = asset!.variants.find((variant) => variant.role === "catalog-detail" && variant.density === 1)!;
    expect(detail.publicUrl).toMatch(/^https:\/\/assets\.example\//);
    expect(fixture.plan().commands).toEqual(
      expect.arrayContaining([
        { type: "SetCatalogItemImageUrls", imageUrls: [detail.publicUrl] },
        { type: "SetCatalogItemProductAssetSets", productAssetSets: [asset] },
      ]),
    );
    expect(fixture.item().imageUrls).toEqual([detail.publicUrl]);
  }

  it.each<[string, ImageKind]>([
    ["scryfall", "magic-card-print"],
    ["scrydex", "one-piece-card-print"],
    ["scrydex", "one-piece-sealed-product"],
    ["tcgplayer", "one-piece-card-print"],
    ["tcgplayer", "one-piece-sealed-product"],
    ["ygoprodeck", "yugioh-card-print"],
    ["ygoprodeck", "yugioh-sealed-product"],
    ["tcgplayer", "yugioh-card-print"],
    ["tcgplayer", "yugioh-sealed-product"],
  ])("rehosts %s %s evidence into a created Catalog Item", async (providerKey, kind) => {
    const fixture = await arrange([member(providerKey, kind)]);
    await expect(fixture.apply()).resolves.toMatchObject({ status: "promoted", appliedMode: "create" });
    expectCatalogPicture(fixture, providerKey);
    expect(fixture.fetcher).toHaveBeenCalledTimes(1);
  });

  it("ignores unapproved image evidence from an item-producing provider", async () => {
    const fixture = await arrange([member("ygojson", "yugioh-sealed-product")]);
    await expect(fixture.apply()).resolves.toMatchObject({ status: "promoted" });
    expect(fixture.item().productAssetSets).toEqual([]);
    expect(fixture.item().imageUrls).toEqual([]);
    expect(fixture.fetcher).not.toHaveBeenCalled();
    expect(fixture.putObject).not.toHaveBeenCalled();
  });

  it("does not let an unapproved provider block or supply the picture for an approved member", async () => {
    const fixture = await arrange([
      member("ygojson", "yugioh-sealed-product", "https://images.example/unapproved.jpg"),
      member("tcgplayer", "yugioh-sealed-product"),
    ]);
    await expect(fixture.apply()).resolves.toMatchObject({ status: "promoted" });
    expectCatalogPicture(fixture, "tcgplayer");
    expect(fixture.fetcher).toHaveBeenCalledExactlyOnceWith(
      imageUrls.tcgplayer,
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("never fetches an approved provider's non-image host", async () => {
    const fixture = await arrange([
      member("tcgplayer", "one-piece-card-print", "https://www.tcgplayer.com/product/synthetic.jpg"),
    ]);
    await expect(fixture.apply()).resolves.toMatchObject({ status: "promoted" });
    expect(fixture.item().imageUrls).toEqual([]);
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });

  it("uses the registered TCGplayer One Piece listing's picture without giving it Item authority", async () => {
    const version = catalogProviderIntegrationProfileVersions.find(
      (entry) => entry.providerKey === "tcgplayer" && entry.profileKey === "one-piece-single-card-product-sku",
    )!;
    const { observation, diagnostics } = normalizeCatalogProviderSourceObservation({
      contract: requireSourceObservationMappingContract(version),
      payload: { ...tcgplayerOnePieceCard, imageUrls: [imageUrls.tcgplayer!] },
      observedAt: at,
    });
    expect(diagnostics).toEqual([]);
    expect(observation?.normalized).toMatchObject({
      kind: "provider-product",
      tcg: "one-piece",
      imageUrls: [imageUrls.tcgplayer],
    });
    const fixture = await arrange([
      member("scrydex", "one-piece-card-print", ""),
      { observation: observation!, version },
    ]);
    await expect(fixture.apply()).resolves.toMatchObject({ status: "promoted" });
    expectCatalogPicture(fixture, "tcgplayer");
    expect(fixture.plan().profiles.map(({ providerKey }) => providerKey)).toEqual(["scrydex"]);
  });

  function itemWithoutPicture() {
    const created = decideCatalogItem(initialCatalogItemState, {
      type: "CreateCatalogItem",
      itemId: existingId,
      languageCode: "en",
      title: { defaultLocale: "en", values: { en: "Fury Sliver" } },
      subtitle: { defaultLocale: "en", values: { en: "" } },
      description: { defaultLocale: "en", values: { en: "" } },
    });
    const assigned = decideCatalogItem(created.reduce(evolveCatalogItem, initialCatalogItemState), {
      type: "AssignBlueprintToCatalogItem",
      blueprintId: magic.profile.catalogFieldMapping.blueprintKey as BlueprintId,
    });
    return [...created, ...assigned];
  }

  it("adds a picture when application refreshes an existing Item without an asset set", async () => {
    const fixture = await arrange([member("scryfall", "magic-card-print")], itemWithoutPicture());
    await expect(fixture.apply()).resolves.toMatchObject({ status: "promoted", appliedMode: "refresh" });
    expectCatalogPicture(fixture, "scryfall");
  });

  it("leaves a stored source hash unchanged even when the evidence URL changes", async () => {
    const first = await arrange([member("scryfall", "magic-card-print")], itemWithoutPicture());
    await first.apply();
    expectCatalogPicture(first, "scryfall");
    const second = await arrange(
      [member("scryfall", "magic-card-print", "https://cards.scryfall.io/normal/front/renamed.jpg")],
      first.itemEvents(),
    );
    await expect(second.apply()).resolves.toMatchObject({ status: "promoted", appliedMode: "refresh" });
    expect(second.item().productAssetSets).toEqual(first.item().productAssetSets);
    expect(second.item().imageUrls).toEqual(first.item().imageUrls);
    expect(second.plan().commands.map(({ type }) => type)).not.toContain("SetCatalogItemProductAssetSets");
    expect(second.plan().commands.map(({ type }) => type)).not.toContain("SetCatalogItemImageUrls");
    expect(second.putObject).not.toHaveBeenCalled();
  });

  it("blocks disagreeing approved picture evidence before download", async () => {
    const fixture = await arrange([
      member("scrydex", "one-piece-card-print"),
      member("tcgplayer", "one-piece-card-print"),
    ]);
    await expect(fixture.apply()).rejects.toMatchObject({ code: "promotion-plan-blocked:asset-provenance-ambiguous" });
    expect(fixture.fetcher).not.toHaveBeenCalled();
    expect(fixture.plan()).toBeNull();
  });

  it("classifies a failed download without failing Catalog Item promotion", async () => {
    const fixture = await arrange([member("scryfall", "magic-card-print")]);
    fixture.fetcher.mockRejectedValueOnce(new Error("synthetic transport failure"));
    const outcome = await fixture.apply();
    expect(outcome).toMatchObject({ status: "promoted", diagnosticCode: "asset-processing-failed" });
    await expect(fixture.apply()).resolves.toEqual(outcome);
    expect(fixture.item().id).not.toBeNull();
    expect(fixture.item().productAssetSets).toEqual([]);
    expect(fixture.putObject).not.toHaveBeenCalled();
  });

  it("fills an already-applied candidate's missing picture without rewriting its retained promotion", async () => {
    const fixture = await arrange([member("scryfall", "magic-card-print")]);
    fixture.fetcher.mockRejectedValueOnce(new Error("synthetic transport failure"));
    const first = await fixture.apply();
    const plan = fixture.plan();
    const before = fixture.itemEvents().length;

    const second = await fixture.apply("job_synthetic_picture_reapply");
    expect(second).toMatchObject({ status: "promoted", planFingerprint: first.planFingerprint });
    expect(second).not.toHaveProperty("diagnosticCode");
    expect(fixture.plan()).toEqual(plan);
    expect(
      fixture
        .itemEvents()
        .slice(before)
        .map(({ type }) => type),
    ).toEqual(["catalog.catalog-item.image-urls-set", "catalog.catalog-item.product-asset-sets-set"]);
    expect(fixture.item().productAssetSets).toHaveLength(1);
    const writes = fixture.putObject.mock.calls.length;

    await expect(fixture.apply("job_synthetic_picture_later")).resolves.toMatchObject({
      status: "skipped-not-eligible",
    });
    expect(fixture.fetcher).toHaveBeenCalledTimes(2);
    expect(fixture.putObject).toHaveBeenCalledTimes(writes);
    await expect(fixture.apply()).resolves.toEqual(first);
  });
});

describeDb("Catalog Merge Candidate application with registered Magic profiles (db)", () => {
  const scopeRecordId = "scope_time_spiral";
  let pool: PgTransactionalPool;
  let services: CatalogServices;
  let store: ReturnType<typeof createPostgresEventStore>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "magic_candidate_application");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
    await seedCatalogDatabase(pool, undefined, { enabledDataProfiles: ["catalog-integration-bootstrap"] });
    services = createCatalogServices(pool);
    store = createPostgresEventStore({ pool });
  });
  afterAll(async () => closeMultiContextTestPools({ catalog: pool }));

  function candidateCommands() {
    return createAggregateCommandHandler({
      eventStore: store,
      codec: createPassthroughDomainEventCodec<CatalogMergeCandidateEvent>(),
      initialState: () => initialCatalogMergeCandidateState,
      evolve: evolveCatalogMergeCandidate,
      decide: decideCatalogMergeCandidate,
    }).commandHandler;
  }

  // Observations are recorded through the Source Observation service; the real
  // matcher builds the candidate from their projected rows.
  async function candidateFrom(observations: readonly CatalogProviderSourceObservationInput[]) {
    const rows = [];
    for (const observation of observations) {
      await services.sourceObservations.commandHandler({
        streamId: sourceObservationStreamId(observation.observationId),
        command: { type: "RecordSourceObservation", ...observation },
        context,
      });
      await drainLocalProjectionHandlerSets("catalog", pool, services.sourceObservations.projectors);
      rows.push((await getSourceObservationDetail(pool, observation.observationId))!);
    }
    const { candidateId, snapshot } = magicCandidate(rows, scopeRecordId);
    await candidateCommands()({
      streamId: catalogMergeCandidateStreamId(candidateId),
      command: { type: "CreateCatalogMergeCandidate", candidateId, snapshot, createdAt: new Date().toISOString() },
      context,
    });
    return { candidateId, snapshot };
  }

  // The production composition of the bulk runtime's application ports.
  function ports(): CatalogMergeCandidateApplicationPorts {
    const commandHandler = candidateCommands();
    return {
      deps: {
        db: pool,
        eventStore: store,
        checkpointStore: createPostgresProjectionStore({ db: pool }),
        promotionTargetExclusion: createPostgresPromotionTargetExclusion({ pool, eventStore: store }),
      } as CatalogRuntimeDeps,
      referenceData: services.referenceData,
      profileVersions: services.providerIntegrationProfiles,
      rolloutControlPolicy: createCatalogIntegrationRolloutControlPolicyFromEnv({}),
      applyCandidateCommandAtVersion: async ({ candidateId, command, expectedVersion, context: commandContext }) =>
        (
          await commandHandler({
            streamId: catalogMergeCandidateStreamId(candidateId),
            command,
            expectedVersion,
            context: commandContext,
          })
        ).state,
    };
  }

  const apply = (candidateId: string, jobId = "job_time_spiral") =>
    applyCatalogMergeCandidatePromotion(ports(), {
      candidateId,
      jobId,
      unitId: candidateId,
      approvalReason: "Apply the reviewed Time Spiral candidate.",
      context,
    });

  async function eventCount(): Promise<number> {
    const result = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM event_store_events");
    return Number(result.rows[0]!.count);
  }

  async function itemCreations(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM event_store_events WHERE event_type = 'catalog.catalog-item.created'",
    );
    return Number(result.rows[0]!.count);
  }

  it("AC1: applies exactly one Item from the Scryfall member's facts with truthful id, mode and provenance", async () => {
    const { candidateId, snapshot } = await candidateFrom([
      magicObservation("mtgjson-card"),
      magicObservation("scryfall-card-print"),
    ]);
    expect(snapshot.membership.map((member) => member.providerKey)).toEqual(["mtgjson", "scryfall"]);
    const target = catalogMergeCandidateTargetId(candidateId);

    const result = await apply(candidateId);

    expect(result).toStrictEqual({
      candidateId,
      status: "promoted",
      catalogItemId: null,
      reason: null,
      appliedCatalogItemId: target,
      appliedMode: "create",
      approvalVersion: 2,
      planFingerprint: expect.any(String),
    });
    expect(await itemCreations()).toBe(1);

    // The bound plan pins only the Scryfall card-print profile and keeps the reviewed membership intact.
    const candidateEvents = await readCompleteStream(store, { streamId: catalogMergeCandidateStreamId(candidateId) });
    const planned = candidateEvents.find((event) => event.eventType === "catalog.merge-candidate.promotion-planned");
    const plan = (planned?.payload as { plan: CatalogMergeCandidatePromotionPlan }).plan;
    const scryfallCardPrint = registeredMagicProfile("scryfall-card-print");
    expect(plan.profiles).toEqual([
      {
        providerKey: "scryfall",
        profileKey: scryfallCardPrint.profileKey,
        profileVersion: scryfallCardPrint.profileVersion,
      },
    ]);
    expect(plan.membership).toEqual(snapshot.membership);
    expect(plan).toMatchObject({ catalogItemId: target, mode: "create", planFingerprint: result.planFingerprint });

    // The Item carries the Scryfall member's facts and the reviewed external references.
    const itemHistory = await readCompleteStream(store, { streamId: `catalog.item-${target}` });
    const item = itemHistory
      .map(createPassthroughDomainEventCodec<CatalogItemEvent>().decode)
      .reduce(evolveCatalogItem, initialCatalogItemState);
    const mapping = await loadCatalogItemPromotionProfile(
      {
        db: pool,
        eventStore: store,
        checkpointStore: createPostgresProjectionStore({ db: pool }),
      } as CatalogRuntimeDeps,
      scryfallCardPrint.profile,
    );
    expect(item).toMatchObject({ id: target, blueprintId: mapping.blueprintId, status: "draft" });
    expect(item.fieldValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldId: mapping.fieldIds.cardNumber, value: "157" }),
        expect.objectContaining({ fieldId: mapping.fieldIds.rarity, value: "uncommon" }),
      ]),
    );
    expect(item.externalCatalogItemReferences).toEqual(
      expect.arrayContaining(
        snapshot.proposedExternalCatalogItemReferences.map((reference) => expect.objectContaining(reference)),
      ),
    );

    // Recovering the applied candidate writes nothing; another unit skips it.
    const events = await eventCount();
    await expect(apply(candidateId)).resolves.toStrictEqual(result);
    await expect(apply(candidateId, "job_time_spiral_later")).resolves.toMatchObject({
      status: "skipped-not-eligible",
      reason: "Catalog Merge Candidate application is already complete.",
    });
    expect(await eventCount()).toBe(events);
    expect(await itemCreations()).toBe(1);
  });

  it("AC3: an optional rarity carried only by MTGJSON is omitted before the display-identity gate", async () => {
    const { candidateId } = await candidateFrom([
      magicObservation("mtgjson-card"),
      magicObservation("scryfall-card-print", { scryfallRarity: null }),
    ]);

    await expect(apply(candidateId)).rejects.toMatchObject({
      code: "promotion-plan-blocked:display-identity-unresolvable",
    });
    expect(await itemCreations()).toBe(0);
  });

  it.each(["uncommon", "rare", ["uncommon"], ["uncommon", "mythic"]].map((chosenValue) => ({ chosenValue })))(
    "applies or refuses a retained approval's chosen rarity $chosenValue before writing the existing Item",
    async ({ chosenValue }) => {
      const original = await candidateFrom([magicObservation("scryfall-card-print")]);
      const first = await apply(original.candidateId);
      const target = first.appliedCatalogItemId!;
      const candidateId = `${original.candidateId}_resolved`;
      const resolution = {
        conflictCode: "rarity-mismatch",
        fieldPath: "catalogItem.rarity",
        chosenValue,
        reason: "Use the operator's choice.",
        observationIds: original.snapshot.membership.map((member) => member.observationId),
      };
      const commandHandler = candidateCommands();
      await commandHandler({
        streamId: catalogMergeCandidateStreamId(candidateId),
        command: {
          type: "CreateCatalogMergeCandidate",
          candidateId,
          createdAt: new Date().toISOString(),
          snapshot: {
            ...original.snapshot,
            matches: { catalogItemId: target, productIds: [] },
            promotionIntent: "update-catalog-item",
            proposedCatalogItemFacts: { ...original.snapshot.proposedCatalogItemFacts, rarity: "rare" },
            conflicts: [
              {
                code: resolution.conflictCode,
                fieldPath: resolution.fieldPath,
                severity: "blocking",
                message: "Rarity differs.",
                observationIds: resolution.observationIds,
                existingValue: Array.isArray(chosenValue) ? chosenValue : ["uncommon"],
                proposedValue: "rare",
              },
            ],
          },
        },
        context,
      });
      await commandHandler({
        streamId: catalogMergeCandidateStreamId(candidateId),
        command: {
          type: "PromoteCatalogMergeCandidate",
          reason: resolution.reason,
          actor: { userId: null, accountId: null },
          promotedAt: new Date().toISOString(),
          conflictResolutions: [resolution],
        },
        context,
      });

      if (Array.isArray(chosenValue) && chosenValue.length > 1) {
        const events = await eventCount();
        await expect(apply(candidateId)).rejects.toMatchObject({
          code: "promotion-plan-blocked:ambiguous-conflict-resolution",
        });
        expect(await eventCount()).toBe(events);
        expect((await loadCandidateApplication(store, candidateId)).state.promotionPlan).toBeNull();
        return;
      }
      const expectedValue = Array.isArray(chosenValue) ? chosenValue[0] : chosenValue;
      const result = await apply(candidateId);

      expect(result).toMatchObject({ status: "promoted", appliedCatalogItemId: target, appliedMode: "refresh" });
      const itemHistory = await readCompleteStream(store, { streamId: `catalog.item-${target}` });
      const item = itemHistory
        .map(createPassthroughDomainEventCodec<CatalogItemEvent>().decode)
        .reduce(evolveCatalogItem, initialCatalogItemState);
      const mapping = await loadCatalogItemPromotionProfile(
        ports().deps,
        registeredMagicProfile("scryfall-card-print").profile,
      );
      expect(item.fieldValues).toContainEqual(
        expect.objectContaining({ fieldId: mapping.fieldIds.rarity, value: expectedValue }),
      );
      const { state } = await loadCandidateApplication(store, candidateId);
      expect(state.promotionPlan?.commands).toContainEqual({
        type: "SetCatalogItemFieldValue",
        fieldId: mapping.fieldIds.rarity,
        value: expectedValue,
      });
      await expect(apply(candidateId)).resolves.toEqual(result);
    },
  );

  it("AC2: an MTGJSON-only candidate with a Scryfall reference is reference-only with zero Item, Reference Record or candidate writes", async () => {
    const { candidateId, snapshot } = await candidateFrom([magicObservation("mtgjson-card")]);
    expect(snapshot.proposedExternalCatalogItemReferences.some((entry) => entry.providerKey === "scryfall")).toBe(true);
    const events = await eventCount();

    const result = await apply(candidateId);

    expect(result).toMatchObject({
      candidateId,
      status: "skipped-not-eligible",
      disposition: "reference-only",
      appliedCatalogItemId: null,
      appliedMode: null,
      approvalVersion: null,
      planFingerprint: null,
    });
    expect(result).not.toHaveProperty("diagnosticCode");
    expect(await eventCount()).toBe(events);
    expect(await itemCreations()).toBe(0);
  });
});

function reviewSnapshot(): CatalogMergeCandidateReviewSnapshot {
  return {
    identityFingerprint: "sha256:synthetic-identity",
    syncRunIds: [],
    identity: {
      scopeRecordId: "scope_synthetic",
      collectorNumber: "1",
      languageCode: "en",
      productForm: "single-card",
      variantKey: "standard",
      barcode: null,
    },
    membership: [
      {
        observationId: "obs_synthetic",
        syncRunId: null,
        providerKey: "tcgdex",
        externalKey: "synthetic-1",
        sourceRecordHash: "sha256:synthetic-record",
        sourceProfileKey: "pokemon-tcg",
        sourceProfileVersion: "2026.06.24",
        sourceMappingFingerprint: "sha256:synthetic-mapping",
        observedAt: "2026-10-11T00:00:00.000Z",
        addedAt: "2026-10-11T00:00:00.000Z",
      },
    ],
    matches: { catalogItemId: null, productIds: [] },
    proposedCatalogItemFacts: { name: "Synthetic review card" },
    proposedExternalCatalogItemReferences: [],
    proposedExternalProductReferences: [],
    conflicts: [],
    warnings: [],
    fieldProvenance: [],
    promotionIntent: "create-catalog-item",
  };
}
