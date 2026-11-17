import { marketplaceAttemptIdSchema, marketplaceMutationRecoveryResultSchema, marketplaceCanonicalRequest, marketplaceRecoveryTargetKind, type MarketplaceMutationKind } from "../../features/mutation-recovery/domain/contracts";
import { marketplaceRequestHash } from "../../features/mutation-recovery/api/client";
import type { ReviewMutationActionState } from "../../features/reviews/ui/review-mutation-form";

export async function runReviewMutation<T>(input: {
  formData: FormData;
  kind: MarketplaceMutationKind;
  target: string;
  request: Record<string, unknown>;
  send: () => Promise<T>;
  lookup: (attemptId: string, kind: MarketplaceMutationKind, target: string, requestHash: string) => Promise<unknown>;
  isResponse: (error: unknown) => boolean;
  code: (error: unknown) => string | null;
  replay?: () => Promise<T>;
}): Promise<{ result: T | { id: string; version: number } } | ReviewMutationActionState> {
  const attemptId = String(input.formData.get("attemptId") ?? "");
  if (!marketplaceAttemptIdSchema.safeParse(attemptId).success)
    return { attemptId, mutationPhase: "failed-safe", error: "The request was not sent. Reload the form before submitting." };
  if (String(input.formData.get("intent") ?? "").startsWith("confirm:")) {
    try {
      if (input.replay) return { result: await input.replay() };
      const requestHash = await marketplaceRequestHash(marketplaceCanonicalRequest(input.kind, input.request));
      const observed = marketplaceMutationRecoveryResultSchema.parse(await input.lookup(attemptId, input.kind, input.target, requestHash));
      if (observed.ownerStatus === "conflict") return { attemptId, mutationPhase: "conflict", error: "This attempt was used for a different request." };
      if (observed.mutationKind === input.kind && observed.target.kind === marketplaceRecoveryTargetKind(input.kind) &&
          observed.target.id === input.target && observed.canonicalRequestHash === requestHash &&
          observed.ownerStatus === "committed" && observed.ownerReceipt) return { result: observed.ownerReceipt };
      if (observed.ownerStatus === "not-observed") return { attemptId, mutationPhase: "failed-safe", error: "No committed result was found. Your work is still here." };
    } catch (error) {
      if (input.code(error) === "attempt_conflict") return { attemptId, mutationPhase: "conflict", error: "This attempt was used for a different request." };
    }
    return { attemptId, mutationPhase: "ambiguous", error: "The first result could not be confirmed. Do not submit again." };
  }
  try { return { result: await input.send() }; }
  catch (error) {
    if (!input.isResponse(error)) return { attemptId, mutationPhase: "confirming" };
    if (input.code(error) === "attempt_conflict") return { attemptId, mutationPhase: "conflict", error: "This attempt was used for a different request." };
    if (input.code(error) === "history_incomplete") return { attemptId, mutationPhase: "ambiguous", error: "The first result could not be confirmed. Do not submit again." };
    throw error;
  }
}
