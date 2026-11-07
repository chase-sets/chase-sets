import { describe, expect, it, vi } from "vitest";
import { ApiError as CatalogApiError } from "../../shell-support/api/client";
import { handleCandidateCommand } from "./candidate-command-handler";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";

describe("merge-candidate entity command handler", () => {
  it("updates a candidate with the version the page read and an empty edit from the row's update button", async () => {
    const updateCatalogMergeCandidate = vi.fn(async () => ({ ok: true }));
    const formData = new FormData();
    formData.set("candidateId", "cand_1");
    formData.set("candidateVersion", "4");
    formData.set("reason", "Update Product mapping from the scope-first Catalog sync workbench.");

    const result = await handleCandidateCommand({
      api: { updateCatalogMergeCandidate } as never,
      intent: "candidate.edit",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(updateCatalogMergeCandidate).toHaveBeenCalledWith("cand_1", {
      reason: "Update Product mapping from the scope-first Catalog sync workbench.",
      expectedVersion: 4,
      edit: {
        factOverrides: [],
        droppedExternalCatalogItemReferenceIndexes: [],
        droppedExternalProductReferenceIndexes: [],
      },
    });
    expect(result.feedback).toMatchObject({ status: "success", intent: "candidate.edit" });
  });

  it("splits off the named Source Observations at the version the page read", async () => {
    const splitCatalogMergeCandidate = vi.fn(async () => ({ ok: true }));
    const formData = new FormData();
    formData.set("candidateId", "cand_1");
    formData.set("candidateVersion", "4");
    formData.set("splitObservationIds", "obs_2");
    formData.set("reason", "Split candidate from the scope-first Catalog sync workbench.");

    const result = await handleCandidateCommand({
      api: { splitCatalogMergeCandidate } as never,
      intent: "candidate.split",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(splitCatalogMergeCandidate).toHaveBeenCalledWith("cand_1", {
      reason: "Split candidate from the scope-first Catalog sync workbench.",
      expectedVersion: 4,
      splitObservationIds: ["obs_2"],
    });
    expect(result.feedback).toMatchObject({ status: "success", intent: "candidate.split" });
  });

  it("fails split/update closed without the candidate version, or a split without observations", async () => {
    const updateCatalogMergeCandidate = vi.fn();
    const splitCatalogMergeCandidate = vi.fn();
    const unversioned = new FormData();
    unversioned.set("candidateId", "cand_1");
    unversioned.set("reason", "Correct it.");
    const unnamedSplit = new FormData();
    unnamedSplit.set("candidateId", "cand_1");
    unnamedSplit.set("candidateVersion", "4");
    unnamedSplit.set("reason", "Split it.");

    const update = await handleCandidateCommand({
      api: { updateCatalogMergeCandidate } as never,
      intent: "candidate.edit",
      context: commandContext(),
      formData: unversioned,
      selectedObservationIds: [],
    });
    const split = await handleCandidateCommand({
      api: { splitCatalogMergeCandidate } as never,
      intent: "candidate.split",
      context: commandContext(),
      formData: unnamedSplit,
      selectedObservationIds: [],
    });

    expect(updateCatalogMergeCandidate).not.toHaveBeenCalled();
    expect(splitCatalogMergeCandidate).not.toHaveBeenCalled();
    expect(update.feedback).toMatchObject({ status: "error", intent: "candidate.edit", result: "command-failed" });
    expect(split.feedback).toMatchObject({ status: "error", intent: "candidate.split", result: "command-failed" });
  });

  it("sends the operator's typed edit, with only the facts changed from what the page showed", async () => {
    const updateCatalogMergeCandidate = vi.fn(async () => ({ ok: true }));
    const formData = new FormData();
    formData.set("candidateId", "cand_1");
    formData.set("candidateVersion", "4");
    formData.set("candidateEditPromotionIntent", "create-catalog-item");
    formData.set("candidateEditCatalogItemId", "");
    formData.set("candidateEditProductIds", "");
    formData.set("candidateEditFact.name", "Charmander - corrected");
    formData.set("candidateEditFactShown.name", "Charmander");
    formData.set("candidateEditFact.rarity", "Common");
    formData.set("candidateEditFactShown.rarity", "Common");
    formData.set("reason", "Operator corrected the printed name.");

    const result = await handleCandidateCommand({
      api: { updateCatalogMergeCandidate } as never,
      intent: "candidate.edit",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(updateCatalogMergeCandidate).toHaveBeenCalledWith("cand_1", {
      reason: "Operator corrected the printed name.",
      expectedVersion: 4,
      edit: {
        promotionIntent: "create-catalog-item",
        catalogItemId: null,
        productIds: [],
        factOverrides: [{ key: "name", value: "Charmander - corrected" }],
        droppedExternalCatalogItemReferenceIndexes: [],
        droppedExternalProductReferenceIndexes: [],
      },
    });
    expect(result.feedback).toMatchObject({ status: "success", intent: "candidate.edit" });
  });

  it("says the candidate changed when the Catalog API refuses a stale version", async () => {
    const updateCatalogMergeCandidate = vi.fn(async () => {
      throw new CatalogApiError(409, {
        error: { code: "stale_merge_candidate", message: "The candidate changed after this page read it." },
      });
    });
    const formData = new FormData();
    formData.set("candidateId", "cand_1");
    formData.set("candidateVersion", "4");
    formData.set("reason", "Correct it.");

    const result = await handleCandidateCommand({
      api: { updateCatalogMergeCandidate } as never,
      intent: "candidate.edit",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(result.feedback).toMatchObject({ status: "error", intent: "candidate.edit", result: "candidate-stale" });
  });

  it("requires a reason for a candidate edit", async () => {
    const updateCatalogMergeCandidate = vi.fn();
    const formData = new FormData();
    formData.set("candidateId", "cand_1");
    formData.set("candidateVersion", "4");

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
