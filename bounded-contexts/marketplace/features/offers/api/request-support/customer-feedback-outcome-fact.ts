import { createCsatOutcomeFactV1 } from "@chase-sets/customer-feedback/server";

export function createOfferAcceptedCsatOutcomeFact(
  input: Readonly<{ sellerAccountId: string; offerId: string; acceptedAt: string }>,
) {
  return createCsatOutcomeFactV1({
    outcomeCode: "offer.accepted",
    sourceContext: "marketplace",
    subjectAccountId: input.sellerAccountId,
    subjectKind: "seller",
    subject: { entityType: "offer", entityId: input.offerId },
    outcomeOccurredAt: input.acceptedAt,
    idempotencyKey: `marketplace:offer.accepted:${input.offerId}`,
  });
}
