import { createHash } from "node:crypto";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { readMarketplaceRecoveryHistory } from "../domain/history";
import {
  canonicalMarketplaceRequest,
  marketplaceCanonicalRequest,
  type MarketplaceMutationRecoveryResult,
} from "../domain/contracts";
import { reportAttemptFactSchema } from "../../reports/api/attempt-result";

export async function validateReviewReportOutcome(
  store: Pick<EventStore, "readStream">,
  recovery: MarketplaceMutationRecoveryResult,
  result: unknown,
): Promise<void> {
  const kind = recovery.mutationKind;
  if (kind !== "review.submit" && kind !== "review.reply" && kind !== "review.report" && kind !== "listing.report")
    return;
  const value = result as { reviewId?: string; reportId?: string; replyId?: string; version: number };
  const report = kind.endsWith(".report");
  const streamId = report
    ? `marketplace.report-${kind === "listing.report" ? "listing" : "review"}-${recovery.target.id}-${recovery.actorBinding.accountId.startsWith("visitor:") ? recovery.actorBinding.accountId : `account:${hash(["account", recovery.actorBinding.accountId])}`}`.replace(
        /[^A-Za-z0-9_.:-]/g,
        "-",
      )
    : `marketplace.review-${value.reviewId}`;
  const history = await readMarketplaceRecoveryHistory<StoredEvent[]>(store, streamId, [], (events, event) => [
    ...events,
    event,
  ]);
  if (!history.complete) throw new Error("Incomplete business history.");
  const events = history.state;
  if (!events.length || value.version > events.length) throw new Error("Missing business outcome.");
  if (report) {
    if (events.length !== 1 || events[0]!.eventType !== "marketplace.report.submitted" || value.version !== 1)
      throw new Error("Invalid report outcome.");
    const fact = reportAttemptFactSchema.parse(events[0]!.payload);
    const accountId = recovery.actorBinding.accountId;
    const visitor = accountId.startsWith("visitor:");
    if (
      fact.reporterKind !== (visitor ? "visitor" : "account") ||
      fact.reporterKey !== (visitor ? accountId : `account:${hash(["account", accountId])}`) ||
      fact.reporterAccountId !== (visitor ? null : accountId) ||
      (visitor && fact.reporterUserId !== null)
    )
      throw new Error("Report reporter binding mismatch.");
    if (
      fact.reportId !== value.reportId ||
      fact.targetId !== recovery.target.id ||
      fact.targetType !== (kind === "listing.report" ? "listing" : "review") ||
      fact.recovery.mutationKind !== kind ||
      fact.recovery.target.kind !== recovery.target.kind ||
      fact.recovery.target.id !== recovery.target.id ||
      fact.recovery.ownerStatus !== "not-observed" ||
      fact.recovery.ownerReceipt !== undefined ||
      fact.recovery.attemptKeyFingerprint !== recovery.attemptKeyFingerprint ||
      fact.recovery.canonicalRequestHash !== recovery.canonicalRequestHash ||
      fact.recovery.actorBinding.accountId !== recovery.actorBinding.accountId ||
      events[0]!.forAccountId !== recovery.actorBinding.accountId ||
      hash(marketplaceCanonicalRequest(kind, fact)) !== recovery.canonicalRequestHash
    )
      throw new Error("Report outcome binding mismatch.");
    return;
  }
  const submitted = events.filter((event) => event.eventType === "marketplace.review.submitted");
  if (submitted.length !== 1 || submitted[0] !== events[0]) throw new Error("Invalid Review origin.");
  const origin = submitted[0]!.payload as Record<string, unknown>;
  if (origin.reviewId !== value.reviewId) throw new Error("Review identity mismatch.");
  if (kind === "review.submit") {
    if (
      origin.authorAccountId !== recovery.actorBinding.accountId ||
      origin.orderId !== recovery.target.id ||
      submitted[0]!.forAccountId !== recovery.actorBinding.accountId ||
      value.version !== 2 ||
      events[1]?.eventType !== "marketplace.csat-outcome-fact.v1" ||
      hash(marketplaceCanonicalRequest(kind, origin)) !== recovery.canonicalRequestHash
    )
      throw new Error("Review outcome binding mismatch.");
  } else {
    const replies = events.filter((event) => event.eventType === "marketplace.review.reply-submitted");
    const reply = replies[0];
    const fact = reply?.payload as Record<string, unknown> | undefined;
    if (
      replies.length !== 1 ||
      !reply ||
      !fact ||
      value.reviewId !== recovery.target.id ||
      origin.subjectAccountId !== recovery.actorBinding.accountId ||
      reply.forAccountId !== recovery.actorBinding.accountId ||
      fact.replyId !== value.replyId ||
      reply.streamVersion !== value.version ||
      hash(marketplaceCanonicalRequest(kind, { reviewId: value.reviewId, feedback: fact.feedback })) !==
        recovery.canonicalRequestHash
    )
      throw new Error("Response outcome binding mismatch.");
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalMarketplaceRequest(value)).digest("hex");
}
