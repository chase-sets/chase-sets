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
