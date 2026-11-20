import { describe, expect, it, vi } from "vitest";
import type { createCatalogRequestApiClient } from "../../request-support/api-client";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/ui/primary-workbench-route-context";
import { buildCatalogAliasCandidate } from "../../../features/alias-equivalence/domain/alias";
import {
  decideCatalogAlias,
  evolveCatalogAlias,
  initialCatalogAliasState,
} from "../../../features/alias-equivalence/domain/domain";
import { planPromotionAliases } from "../../../features/source-observations/api/promotion/provider-promotion-alias-planner";
import {
  commandFeedbackDescription,
  commandSuccessTitle,
} from "../../../features/source-observations/ui/primary-workbench-command-feedback";
import { handleAliasReviewCommand } from "./alias-review-command-handler";

const context = parseCatalogPrimaryWorkbenchRouteContext("https://admin.example/catalog/integrations");

function promotedCandidate() {
  const intake = buildCatalogAliasCandidate({
    target: { kind: "catalog-item", targetId: null, targetKey: "name" },
    aliasText: "Sprigatito",
    aliasLanguageCode: "en",
    sourceLanguageCode: "ja",
    aliasType: "official-equivalent",
    confidence: "high",
    reviewStatus: "pending",
    provenance: {
      providerKey: "tcgdex",
      observationId: "obs_1",
      sourceCategory: "provider-same-id-localized-endpoint",
      sourceProfileKey: "pokemon-tcg",
      sourceProfileVersion: "1",
      mappingFingerprint: "fp",
    },
    evidence: { sharedId: "sv1a-001" },
  });
  const action = planPromotionAliases({
    candidates: [intake],
    resolution: { catalogItemId: "cat_1", referenceRecordIdsByTypeKey: {} },
  }).actions[0];
  if (action?.kind !== "propose") throw new Error("Expected resolved proposal");
  return action.candidate;
}

describe("integrations alias review command handler", () => {
  it.each(["accept", "reject", "revoke"] as const)(
    "binds alias.%s to the promoted hash and preserves reasons",
    async (intent) => {
      const candidate = promotedCandidate();
      const dispatchCatalogAliasReviewCommand = vi.fn().mockResolvedValue({});
      const formData = new FormData();
      formData.set("aliasHashes", `${candidate.aliasHash},${candidate.aliasHash}`);
      formData.set("reason", "Reviewed evidence");
      const result = await handleAliasReviewCommand({
        api: { dispatchCatalogAliasReviewCommand } as unknown as ReturnType<typeof createCatalogRequestApiClient>,
        intent: `alias.${intent}`,
        context,
        formData,
      });
      expect(result.feedback.status).toBe("success");
      expect(result.feedback.result).toBe(
        { accept: "alias-accepted", reject: "alias-rejected", revoke: "alias-revoked" }[intent],
      );
      expect(commandSuccessTitle(result.feedback.result)).toBe(
        { accept: "Alias accepted", reject: "Alias rejected", revoke: "Alias revoked" }[intent],
      );
      expect(dispatchCatalogAliasReviewCommand).toHaveBeenCalledExactlyOnceWith({
        intent,
        aliasHashes: [candidate.aliasHash],
        reason: "Reviewed evidence",
      });
      expect(candidate.target.targetId).toBe("cat_1");
    },
  );

  it("alias.defer is repeatable, dispatches zero times, and reloads pending the next day", async () => {
    const candidate = promotedCandidate();
    const events = decideCatalogAlias(initialCatalogAliasState, {
      type: "ProposeCatalogAlias",
      candidate,
      actor: "system",
    });
    const reload = () => events.reduce(evolveCatalogAlias, initialCatalogAliasState);
    const dispatchCatalogAliasReviewCommand = vi.fn();
    const formData = new FormData();
    formData.set("aliasHashes", candidate.aliasHash);
    for (let day = 0; day < 2; day += 1) {
      const result = await handleAliasReviewCommand({
        api: { dispatchCatalogAliasReviewCommand } as unknown as ReturnType<typeof createCatalogRequestApiClient>,
        intent: "alias.defer",
        context,
        formData,
      });
      expect(result.feedback).toMatchObject({ status: "success", result: "alias-deferred" });
      expect(commandSuccessTitle(result.feedback.result)).toBe("Left for later");
      expect(commandFeedbackDescription(result.feedback)).toBe(
        "The selected candidates stay pending for a later review. Nothing was recorded.",
      );
      expect(reload()).toMatchObject({
        aliasHash: candidate.aliasHash,
        target: candidate.target,
        reviewStatus: "pending",
      });
    }
    expect(dispatchCatalogAliasReviewCommand).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });
});
