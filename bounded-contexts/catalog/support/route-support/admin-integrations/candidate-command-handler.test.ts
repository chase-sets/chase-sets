import { describe, expect, it, vi } from "vitest";
import { handleCandidateCommand } from "./candidate-command-handler";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";

describe("merge-candidate entity command handler", () => {
  it("submits typed update merge-candidate bodies when the workbench preview generated them", async () => {
    const updateCatalogMergeCandidate = vi.fn(async () => ({ ok: true }));
    const formData = new FormData();
    formData.set("candidateId", "cand_1");
    formData.set(
      "mergeCandidateCommandBody",
      JSON.stringify({
        reason: "Update Product mapping from the scope-first Catalog sync workbench.",
        snapshot: { identityFingerprint: "sha256:cand_1" },
      }),
    );

    const result = await handleCandidateCommand({
      api: { updateCatalogMergeCandidate } as never,
      intent: "candidate.edit",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(updateCatalogMergeCandidate).toHaveBeenCalledWith("cand_1", {
      reason: "Update Product mapping from the scope-first Catalog sync workbench.",
      snapshot: { identityFingerprint: "sha256:cand_1" },
    });
    expect(result.feedback).toMatchObject({ status: "success", intent: "candidate.edit" });
  });

  it("submits typed split merge-candidate bodies when the workbench preview generated them", async () => {
    const splitCatalogMergeCandidate = vi.fn(async () => ({ ok: true }));
    const formData = new FormData();
    formData.set("candidateId", "cand_1");
    formData.set(
      "mergeCandidateCommandBody",
      JSON.stringify({
        reason: "Split candidate from the scope-first Catalog sync workbench.",
        remainingSnapshot: { identityFingerprint: "sha256:cand_1:remaining" },
        splitCandidateId: "cand_1__split__obs_2",
        splitSnapshot: { identityFingerprint: "sha256:cand_1:split" },
      }),
    );

    const result = await handleCandidateCommand({
      api: { splitCatalogMergeCandidate } as never,
      intent: "candidate.split",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(splitCatalogMergeCandidate).toHaveBeenCalledWith("cand_1", {
      reason: "Split candidate from the scope-first Catalog sync workbench.",
      remainingSnapshot: { identityFingerprint: "sha256:cand_1:remaining" },
      splitCandidateId: "cand_1__split__obs_2",
      splitSnapshot: { identityFingerprint: "sha256:cand_1:split" },
    });
    expect(result.feedback).toMatchObject({ status: "success", intent: "candidate.split" });
  });

  it("fails split/update closed when no typed body is posted", async () => {
    const updateCatalogMergeCandidate = vi.fn();
    const formData = new FormData();
    formData.set("candidateId", "cand_1");

    const result = await handleCandidateCommand({
      api: { updateCatalogMergeCandidate } as never,
      intent: "candidate.edit",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(updateCatalogMergeCandidate).not.toHaveBeenCalled();
    expect(result.feedback).toMatchObject({ status: "error", intent: "candidate.edit" });
  });

  it("applies a typed candidate edit onto the base snapshot with manual provenance", async () => {
    const updateCatalogMergeCandidate = vi.fn(async () => ({ ok: true }));
    const formData = new FormData();
    formData.set("candidateId", "cand_1");
    formData.set("candidateEditBaseSnapshot", JSON.stringify(editBaseSnapshot()));
    formData.set("candidateEditPromotionIntent", "create-catalog-item");
    formData.set("candidateEditFact.name", "Charmander - corrected");
    formData.set("reason", "Operator corrected the printed name.");

    const result = await handleCandidateCommand({
      api: { updateCatalogMergeCandidate } as never,
      intent: "candidate.edit",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(updateCatalogMergeCandidate).toHaveBeenCalledTimes(1);
    const [candidateId, body] = updateCatalogMergeCandidate.mock.calls[0] as unknown as [
      string,
      { reason: string; snapshot: { proposedCatalogItemFacts: Record<string, unknown>; fieldProvenance: unknown[] } },
    ];
    expect(candidateId).toBe("cand_1");
    expect(body.reason).toBe("Operator corrected the printed name.");
    expect(body.snapshot.proposedCatalogItemFacts.name).toBe("Charmander - corrected");
    expect(body.snapshot.fieldProvenance).toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldPath: "catalogItem.name", confidence: "manual" })]),
    );
    expect(result.feedback).toMatchObject({ status: "success", intent: "candidate.edit" });
  });

  it("requires a reason for a candidate edit", async () => {
    const updateCatalogMergeCandidate = vi.fn();
    const formData = new FormData();
    formData.set("candidateId", "cand_1");
    formData.set("candidateEditBaseSnapshot", JSON.stringify(editBaseSnapshot()));

    const result = await handleCandidateCommand({
      api: { updateCatalogMergeCandidate } as never,
      intent: "candidate.edit",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(updateCatalogMergeCandidate).not.toHaveBeenCalled();
    expect(result.feedback).toMatchObject({ status: "error", result: "reason-required" });
  });

  it("enqueues one scope promote job from the scope record alone, never a per-candidate request loop", async () => {
    const enqueueCatalogMergeCandidateBulkJob = vi.fn(async () => ({ jobId: "job_scope_promote" }));
    const promoteCatalogMergeCandidate = vi.fn();
    const formData = new FormData();
    formData.set("candidateSelection", "scope");
    formData.set("scopeRecordId", "scope_base_set");

    const result = await handleCandidateCommand({
      api: { enqueueCatalogMergeCandidateBulkJob, promoteCatalogMergeCandidate } as never,
      intent: "candidate.promote",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(enqueueCatalogMergeCandidateBulkJob).toHaveBeenCalledTimes(1);
    expect(enqueueCatalogMergeCandidateBulkJob).toHaveBeenCalledWith("merge-candidate-promote", "scope_base_set", null);
    expect(promoteCatalogMergeCandidate).not.toHaveBeenCalled();
    expect(result.feedback).toMatchObject({ status: "success", intent: "candidate.promote", result: "job-queued" });
    // The job reference rides the result context like other bulk review jobs.
    expect(result.context.jobId).toBe("job_scope_promote");
  });

  it("falls back to the route context scope record when the form omits it", async () => {
    const enqueueCatalogMergeCandidateBulkJob = vi.fn(async () => ({ jobId: "job_scope_promote" }));
    const formData = new FormData();
    formData.set("candidateSelection", "scope");

    await handleCandidateCommand({
      api: { enqueueCatalogMergeCandidateBulkJob } as never,
      intent: "candidate.promote",
      context: { ...commandContext(), scopeRecordId: "scope_from_route" },
      formData,
      selectedObservationIds: [],
    });

    expect(enqueueCatalogMergeCandidateBulkJob).toHaveBeenCalledWith(
      "merge-candidate-promote",
      "scope_from_route",
      null,
    );
  });

  it("fails a scope job closed when no scope record is known", async () => {
    const enqueueCatalogMergeCandidateBulkJob = vi.fn();
    const formData = new FormData();
    formData.set("candidateSelection", "scope");

    const result = await handleCandidateCommand({
      api: { enqueueCatalogMergeCandidateBulkJob } as never,
      intent: "candidate.promote",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(enqueueCatalogMergeCandidateBulkJob).not.toHaveBeenCalled();
    expect(result.feedback).toMatchObject({ status: "error", intent: "candidate.promote", result: "command-failed" });
  });

  it("enqueues one scope defer-remainder job with the operator reason", async () => {
    const enqueueCatalogMergeCandidateBulkJob = vi.fn(async () => ({ jobId: "job_scope_defer" }));
    const deferCatalogMergeCandidate = vi.fn();
    const formData = new FormData();
    formData.set("candidateSelection", "scope");
    formData.set("scopeRecordId", "scope_base_set");
    formData.set("reason", "Deferred pending conflict review.");

    const result = await handleCandidateCommand({
      api: { enqueueCatalogMergeCandidateBulkJob, deferCatalogMergeCandidate } as never,
      intent: "candidate.defer",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(enqueueCatalogMergeCandidateBulkJob).toHaveBeenCalledWith(
      "merge-candidate-defer",
      "scope_base_set",
      "Deferred pending conflict review.",
    );
    expect(deferCatalogMergeCandidate).not.toHaveBeenCalled();
    expect(result.feedback).toMatchObject({ status: "success", intent: "candidate.defer", result: "job-queued" });
  });

  it("requires a reason to defer the scope remainder", async () => {
    const enqueueCatalogMergeCandidateBulkJob = vi.fn();
    const formData = new FormData();
    formData.set("candidateSelection", "scope");
    formData.set("scopeRecordId", "scope_base_set");

    const result = await handleCandidateCommand({
      api: { enqueueCatalogMergeCandidateBulkJob } as never,
      intent: "candidate.defer",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(enqueueCatalogMergeCandidateBulkJob).not.toHaveBeenCalled();
    expect(result.feedback).toMatchObject({ status: "error", result: "reason-required" });
  });

  it("rejects scope selection for candidate verbs that have no scope job", async () => {
    const enqueueCatalogMergeCandidateBulkJob = vi.fn();
    const formData = new FormData();
    formData.set("candidateSelection", "scope");
    formData.set("scopeRecordId", "scope_base_set");
    formData.set("reason", "Ignore everything.");

    const result = await handleCandidateCommand({
      api: { enqueueCatalogMergeCandidateBulkJob } as never,
      intent: "candidate.ignore",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(enqueueCatalogMergeCandidateBulkJob).not.toHaveBeenCalled();
    expect(result.feedback).toMatchObject({ status: "error", result: "invalid-intent" });
  });
});

function editBaseSnapshot() {
  return {
    identityFingerprint: "sha256:cand",
    syncRunIds: ["run_1"],
    identity: {
      tcg: "pokemon",
      productLineName: "Pokemon",
      setName: "Base Set",
      printedProductName: "Charmander",
      collectorNumber: "004",
      languageCode: "en",
      productForm: "card",
      variantKey: null,
      barcode: null,
    },
    membership: [
      {
        observationId: "obs_1",
        syncRunId: "run_1",
        providerKey: "tcgplayer",
        externalKey: "tcgplayer:base1-004",
        sourceRecordHash: "sha256:record",
        sourceProfileKey: "tcgplayer-pokemon-card",
        sourceProfileVersion: "2026.06.24",
        sourceMappingFingerprint: "sha256:mapping",
        observedAt: "2026-06-24T09:00:00.000Z",
        addedAt: "2026-06-24T09:30:00.000Z",
      },
    ],
    matches: { catalogItemId: null, productIds: [] },
    proposedCatalogItemFacts: { name: "Charmander" },
    proposedExternalCatalogItemReferences: [],
    proposedExternalProductReferences: [],
    conflicts: [],
    warnings: [],
    fieldProvenance: [],
    promotionIntent: "create-catalog-item" as const,
  };
}

function commandContext(): CatalogIntegrationsCommandResult["context"] {
  return {
    section: "import-to-promotion",
    providerKey: "tcgdex",
    unitKey: "tcgdex:pokemon:card:import",
    scope: undefined,
    importScope: "en:3:base:base1",
    profileVersion: "2026.06.04",
    sourceObservationFilters: {},
    selectedObservationIds: [],
    reviewOffset: null,
    reviewLimit: null,
    jobId: null,
    promotionPreviewId: null,
    returnPath: null,
  };
}
