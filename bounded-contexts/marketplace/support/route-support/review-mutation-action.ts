import {
  marketplaceAttemptIdSchema,
  marketplaceMutationRecoveryResultSchema,
  marketplaceCanonicalRequest,
  marketplaceRecoveryTargetKind,
  type MarketplaceMutationKind,
} from "../../features/mutation-recovery/domain/contracts";
import { marketplaceRequestHash } from "../../features/mutation-recovery/api/client";
import { t } from "@chase-sets/localization";
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
    return { attemptId, mutationPhase: "failed-safe", error: t("marketplace.reviewRecovery.notSent") };
  if (String(input.formData.get("intent") ?? "").startsWith("confirm:")) {
    try {
      if (input.replay) return { result: await input.replay() };
      const requestHash = await marketplaceRequestHash(marketplaceCanonicalRequest(input.kind, input.request));
      const observed = marketplaceMutationRecoveryResultSchema.parse(
        await input.lookup(attemptId, input.kind, input.target, requestHash),
      );
      const fingerprint = await marketplaceRequestHash([
        observed.actorBinding.accountId,
        input.kind,
        observed.target,
        attemptId,
      ]);
      if (
        observed.mutationKind !== input.kind ||
        observed.attemptKeyFingerprint !== fingerprint ||
        observed.target.kind !== marketplaceRecoveryTargetKind(input.kind) ||
        observed.target.id !== input.target ||
        observed.canonicalRequestHash !== requestHash
      )
        return { attemptId, mutationPhase: "ambiguous", error: t("marketplace.reviewRecovery.unconfirmed") };
      if (observed.ownerStatus === "conflict")
        return { attemptId, mutationPhase: "conflict", error: t("marketplace.reviewRecovery.changedRequest") };
      if (
        observed.mutationKind === input.kind &&
        observed.target.kind === marketplaceRecoveryTargetKind(input.kind) &&
        observed.target.id === input.target &&
        observed.canonicalRequestHash === requestHash &&
        observed.ownerStatus === "committed" &&
        observed.ownerReceipt
      )
        return { result: observed.ownerReceipt };
      if (observed.ownerStatus === "not-observed")
        return { attemptId, mutationPhase: "failed-safe", error: t("marketplace.reviewRecovery.notObserved") };
    } catch (error) {
      if (input.code(error) === "attempt_conflict")
        return { attemptId, mutationPhase: "conflict", error: t("marketplace.reviewRecovery.changedRequest") };
    }
    return { attemptId, mutationPhase: "ambiguous", error: t("marketplace.reviewRecovery.unconfirmed") };
  }
  try {
    return { result: await input.send() };
  } catch (error) {
    if (!input.isResponse(error)) return { attemptId, mutationPhase: "confirming" };
    if (input.code(error) === "attempt_conflict")
      return { attemptId, mutationPhase: "conflict", error: t("marketplace.reviewRecovery.changedRequest") };
    if (input.code(error) === "history_incomplete")
      return { attemptId, mutationPhase: "ambiguous", error: t("marketplace.reviewRecovery.unconfirmed") };
    throw error;
  }
}
