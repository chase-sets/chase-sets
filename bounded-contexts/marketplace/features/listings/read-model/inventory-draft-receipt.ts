import { inventoryDraftListingReceiptSchema } from "@chase-sets/inventory-draft-listing";

export type InventoryDraftReceiptRow = Readonly<{
  message_id: string;
  tenant_id: string;
  account_id: string;
  performed_by_user_id: string;
  listing_id: string;
  intent_hash: string;
  receipt: unknown;
  accepted_at: string | Date;
}>;

export function parseInventoryDraftReceiptRow(row: InventoryDraftReceiptRow) {
  const parsed = inventoryDraftListingReceiptSchema.safeParse(row.receipt);
  if (!parsed.success) return null;
  const receipt = parsed.data;
  const acceptedAt = new Date(row.accepted_at);
  if (
    receipt.messageId !== row.message_id ||
    receipt.tenantId !== row.tenant_id ||
    receipt.accountId !== row.account_id ||
    receipt.performedByUserId !== row.performed_by_user_id ||
    receipt.listingId !== row.listing_id ||
    receipt.intentHash !== row.intent_hash ||
    !Number.isFinite(acceptedAt.getTime()) ||
    receipt.acceptedAt !== acceptedAt.toISOString()
  )
    return null;
  return receipt;
}
