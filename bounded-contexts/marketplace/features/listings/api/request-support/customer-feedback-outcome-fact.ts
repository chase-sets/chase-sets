import { createCsatOutcomeFactV1 } from "@chase-sets/customer-feedback/server";

export function createListingPublishedCsatOutcomeFact(input: Readonly<{ accountId: string; listingId: string }>) {
  return createCsatOutcomeFactV1({
    outcomeCode: "listing.published",
    sourceContext: "marketplace",
    subjectAccountId: input.accountId,
    subjectKind: "seller",
    subject: { entityType: "listing", entityId: input.listingId },
    outcomeOccurredAt: new Date().toISOString(),
    idempotencyKey: `marketplace:listing.published:${input.listingId}`,
  });
}
