import { createCsatOutcomeFactV1 } from "@chase-sets/customer-feedback/server";

export function createPayoutCompletedCsatOutcomeFact(
  input: Readonly<{ accountId: string; payoutId: string; completedAt: string }>,
) {
  return createCsatOutcomeFactV1({
    outcomeCode: "payout.completed",
    sourceContext: "settlement",
    subjectAccountId: input.accountId,
    subjectKind: "seller",
    subject: { entityType: "payout", entityId: input.payoutId },
    outcomeOccurredAt: input.completedAt,
    idempotencyKey: `settlement:payout.completed:${input.payoutId}`,
  });
}
