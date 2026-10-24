import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import {
  decideCatalogMergeCandidate,
  evolveCatalogMergeCandidate,
  initialCatalogMergeCandidateState,
  type CatalogMergeCandidateEvent,
  type CatalogMergeCandidatePromotionPlan,
  type CatalogMergeCandidateReviewSnapshot,
} from "../../domain/catalog-merge-candidate";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../provider-integration-profiles";
import { catalogMergeCandidateStreamId } from "../source-observation-stream-identity";
import {
  applyCatalogMergeCandidatePromotion,
  catalogMergeCandidateTargetId,
  loadCandidateApplication,
  requirePinnedProfileEligible,
  type CatalogMergeCandidateApplicationPorts,
} from "./catalog-merge-candidate-application";

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
