import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { createCatalogIntegrationRolloutControlPolicyFromEnv } from "../governance/catalog-integration-rollout-controls";
import { loadCatalogItemPromotionProfile } from "../source-observation-promotion-execution";
import { createPostgresPromotionTargetExclusion } from "./promotion-target-exclusion";
import {
  magicCandidate,
  magicObservation,
  observationRow,
  registeredMagicProfile,
  registeredMagicProfiles,
} from "../../tests/magic-provider-role-fixture";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../provider-integration-profiles";
import { catalogProviderProfileVersionIngestionUnitKey } from "../providers/registry";
import { catalogMergeCandidateStreamId, sourceObservationStreamId } from "../source-observation-stream-identity";
import {
  applyCatalogMergeCandidatePromotion,
  catalogMergeCandidateTargetId,
  loadCandidateApplication,
  requirePinnedProfileEligible,
  snapshotWithAuthoredFacts,
  type CatalogMergeCandidateApplicationPorts,
} from "./catalog-merge-candidate-application";
import { applyCatalogMergeCandidateEdit } from "./catalog-merge-candidate-edit";
import type { CatalogProviderSourceObservationInput } from "./provider-source-observation-normalizer";

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

  const withoutScryfallReference = (snapshot: CatalogMergeCandidateReviewSnapshot) =>
    applyCatalogMergeCandidateEdit(snapshot, {
      promotionIntent: snapshot.promotionIntent,
      catalogItemId: null,
      productIds: [],
      factOverrides: [],
      droppedExternalCatalogItemReferenceIndexes: snapshot.proposedExternalCatalogItemReferences.flatMap(
        (entry, index) => (entry.providerKey === "scryfall" ? [index] : []),
      ),
      droppedExternalProductReferenceIndexes: [],
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

  it("AC3: a reviewer's correction is reviewed authority, not reference facts", async () => {
    const arranged = arrange(mixed({ scryfallRarity: null }), (snapshot) =>
      applyCatalogMergeCandidateEdit(snapshot, {
        promotionIntent: snapshot.promotionIntent,
        catalogItemId: null,
        productIds: [],
        factOverrides: [{ key: "rarity", value: "uncommon" }],
        droppedExternalCatalogItemReferenceIndexes: [],
        droppedExternalProductReferenceIndexes: [],
      }),
    );

    const { error, touched } = await apply(arranged);

    expect(error).toMatchObject({ message: "unexpected-database" });
    expect(touched).toEqual(["database"]);
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

  it("AC3: an optional rarity carried only by MTGJSON is omitted from the Item", async () => {
    const { candidateId } = await candidateFrom([
      magicObservation("mtgjson-card"),
      magicObservation("scryfall-card-print", { scryfallRarity: null }),
    ]);

    const result = await apply(candidateId);
    expect(result.status).toBe("promoted");

    const target = catalogMergeCandidateTargetId(candidateId);
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
      registeredMagicProfile("scryfall-card-print").profile,
    );
    expect(item.fieldValues).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldId: mapping.fieldIds.rarity })]),
    );
  });

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
