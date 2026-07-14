import { describe, expect, it, vi } from "vitest";
import { handleDailyCommand } from "./daily-command-handler";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";

describe("daily Catalog integrations command handler", () => {
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

    const result = await handleDailyCommand({
      api: { updateCatalogMergeCandidate } as never,
      intent: "update-merge-candidate",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(updateCatalogMergeCandidate).toHaveBeenCalledWith("cand_1", {
      reason: "Update Product mapping from the scope-first Catalog sync workbench.",
      snapshot: { identityFingerprint: "sha256:cand_1" },
    });
    expect(result.feedback).toMatchObject({ status: "success", intent: "update-merge-candidate" });
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

    const result = await handleDailyCommand({
      api: { splitCatalogMergeCandidate } as never,
      intent: "split-merge-candidate",
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
    expect(result.feedback).toMatchObject({ status: "success", intent: "split-merge-candidate" });
  });

  it("fails split/update closed when no typed body is posted", async () => {
    const updateCatalogMergeCandidate = vi.fn();
    const formData = new FormData();
    formData.set("candidateId", "cand_1");

    const result = await handleDailyCommand({
      api: { updateCatalogMergeCandidate } as never,
      intent: "update-merge-candidate",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(updateCatalogMergeCandidate).not.toHaveBeenCalled();
    expect(result.feedback).toMatchObject({ status: "error", intent: "update-merge-candidate" });
  });

  it("applies a typed candidate edit onto the base snapshot with manual provenance", async () => {
    const updateCatalogMergeCandidate = vi.fn(async () => ({ ok: true }));
    const formData = new FormData();
    formData.set("candidateId", "cand_1");
    formData.set("candidateEditBaseSnapshot", JSON.stringify(editBaseSnapshot()));
    formData.set("candidateEditPromotionIntent", "create-catalog-item");
    formData.set("candidateEditFact.name", "Charmander - corrected");
    formData.set("reason", "Operator corrected the printed name.");

    const result = await handleDailyCommand({
      api: { updateCatalogMergeCandidate } as never,
      intent: "update-merge-candidate",
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
    expect(result.feedback).toMatchObject({ status: "success", intent: "update-merge-candidate" });
  });

  it("requires a reason for a candidate edit", async () => {
    const updateCatalogMergeCandidate = vi.fn();
    const formData = new FormData();
    formData.set("candidateId", "cand_1");
    formData.set("candidateEditBaseSnapshot", JSON.stringify(editBaseSnapshot()));

    const result = await handleDailyCommand({
      api: { updateCatalogMergeCandidate } as never,
      intent: "update-merge-candidate",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(updateCatalogMergeCandidate).not.toHaveBeenCalled();
    expect(result.feedback).toMatchObject({ status: "error", result: "reason-required" });
  });

  it("bulk-promotes exactly the ready candidate IDs the read model classified", async () => {
    const promoteCatalogMergeCandidate = vi.fn(async () => ({ ok: true }));
    const formData = new FormData();
    formData.set("bulkCandidateIds", "cand_1,cand_2,cand_1");

    const result = await handleDailyCommand({
      api: { promoteCatalogMergeCandidate } as never,
      intent: "bulk-promote-merge-candidates",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(promoteCatalogMergeCandidate).toHaveBeenCalledTimes(2);
    expect(promoteCatalogMergeCandidate).toHaveBeenNthCalledWith(
      1,
      "cand_1",
      expect.objectContaining({ reason: expect.any(String) }),
    );
    expect(promoteCatalogMergeCandidate).toHaveBeenNthCalledWith(
      2,
      "cand_2",
      expect.objectContaining({ reason: expect.any(String) }),
    );
    expect(result.feedback).toMatchObject({ status: "success", intent: "bulk-promote-merge-candidates" });
  });

  it("fails a bulk promote closed when no candidate IDs are posted", async () => {
    const promoteCatalogMergeCandidate = vi.fn();
    const result = await handleDailyCommand({
      api: { promoteCatalogMergeCandidate } as never,
      intent: "bulk-promote-merge-candidates",
      context: commandContext(),
      formData: new FormData(),
      selectedObservationIds: [],
    });

    expect(promoteCatalogMergeCandidate).not.toHaveBeenCalled();
    expect(result.feedback).toMatchObject({ status: "error", intent: "bulk-promote-merge-candidates" });
  });

  it("bulk-defers the remainder with the operator reason", async () => {
    const deferCatalogMergeCandidate = vi.fn(async () => ({ ok: true }));
    const formData = new FormData();
    formData.set("bulkCandidateIds", "cand_3,cand_4");
    formData.set("reason", "Deferred pending conflict review.");

    const result = await handleDailyCommand({
      api: { deferCatalogMergeCandidate } as never,
      intent: "bulk-defer-merge-candidates",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(deferCatalogMergeCandidate).toHaveBeenCalledTimes(2);
    expect(deferCatalogMergeCandidate).toHaveBeenNthCalledWith(1, "cand_3", {
      reason: "Deferred pending conflict review.",
    });
    expect(result.feedback).toMatchObject({ status: "success", intent: "bulk-defer-merge-candidates" });
  });

  it("requires a reason to bulk-defer the remainder", async () => {
    const deferCatalogMergeCandidate = vi.fn();
    const formData = new FormData();
    formData.set("bulkCandidateIds", "cand_3");

    const result = await handleDailyCommand({
      api: { deferCatalogMergeCandidate } as never,
      intent: "bulk-defer-merge-candidates",
      context: commandContext(),
      formData,
      selectedObservationIds: [],
    });

    expect(deferCatalogMergeCandidate).not.toHaveBeenCalled();
    expect(result.feedback).toMatchObject({ status: "error", result: "reason-required" });
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
