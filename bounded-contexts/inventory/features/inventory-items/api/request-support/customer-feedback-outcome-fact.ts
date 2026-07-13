import { createCsatOutcomeFactV1 } from "@chase-sets/customer-feedback/server";

export function createInventoryItemAdjustedCsatOutcomeFact(
  input: Readonly<{ accountId: string; itemId: string; idempotencyKey: string }>,
) {
  return createCsatOutcomeFactV1({
    outcomeCode: "inventory.item-adjusted",
    sourceContext: "inventory",
    subjectAccountId: input.accountId,
    subjectKind: "seller",
    subject: { entityType: "inventory-item", entityId: input.itemId },
    outcomeOccurredAt: new Date().toISOString(),
    idempotencyKey: input.idempotencyKey,
  });
}
