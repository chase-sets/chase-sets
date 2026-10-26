import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

/** The producer-side port is deliberately narrower than Marketplace's implementation. */
export type InventoryDraftListingDelivery = Readonly<{
  accept(message: unknown, context: EventStoreContext): Promise<unknown>;
  readReceipt(messageId: string, context: EventStoreContext): Promise<unknown | null>;
}>;

export type InventoryDraftListingDeliveryMessage = Readonly<{
  schemaVersion: "inventory-draft-listing/v1";
  messageId: string;
  authority: Readonly<{ tenantId: string; accountId: string; performedByUserId: string }>;
  snapshot: Readonly<Record<string, unknown>>;
}>;

export const inventoryDraftListingOutboxSchemaSql = `
CREATE TABLE IF NOT EXISTS inventory_import_draft_listing_outbox (
  message_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  performed_by_user_id text NOT NULL,
  import_batch_id text NOT NULL,
  import_row_id text NOT NULL,
  message jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  receipt jsonb NULL,
  last_error text NULL,
  claimed_at timestamptz NULL,
  accepted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_batch_id, import_row_id),
  CHECK (state IN ('pending', 'sending', 'accepted', 'failed'))
);
CREATE INDEX IF NOT EXISTS inventory_import_draft_listing_outbox_pending_idx
  ON inventory_import_draft_listing_outbox (state, created_at, message_id);
`;

export async function enqueueInventoryDraftListingMessage(
  db: PgQueryable,
  message: InventoryDraftListingDeliveryMessage,
): Promise<void> {
  await db.query(
    `INSERT INTO inventory_import_draft_listing_outbox
       (message_id, tenant_id, account_id, performed_by_user_id, import_batch_id, import_row_id, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (message_id) DO NOTHING`,
    [
      message.messageId,
      message.authority.tenantId,
      message.authority.accountId,
      message.authority.performedByUserId,
      String(message.snapshot.importBatchId),
      String(message.snapshot.importRowId),
      JSON.stringify(message),
    ],
  );
}

export async function processNextInventoryDraftListingDelivery(
  db: PgQueryable,
  delivery: InventoryDraftListingDelivery | undefined,
): Promise<number> {
  if (!delivery) return 0;
  const claimed = await db.query<{
    message_id: string;
    tenant_id: string;
    account_id: string;
    performed_by_user_id: string;
    message: InventoryDraftListingDeliveryMessage;
  }>(
    `WITH next_message AS (
       SELECT message_id FROM inventory_import_draft_listing_outbox
       WHERE state = 'pending'
       ORDER BY created_at, message_id
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE inventory_import_draft_listing_outbox AS outbox
     SET state = 'sending', attempts = attempts + 1, claimed_at = now(), updated_at = now()
     FROM next_message
     WHERE outbox.message_id = next_message.message_id
     RETURNING outbox.message_id, outbox.tenant_id, outbox.account_id,
       outbox.performed_by_user_id, outbox.message`,
  );
  const row = claimed.rows[0];
  if (!row) return 0;
  const context = {
    tenantId: row.tenant_id,
    audit: { forAccountId: row.account_id, performedByUserId: row.performed_by_user_id },
  } as EventStoreContext;
  try {
    const receipt = await delivery.accept(row.message, context);
    await db.query(
      `UPDATE inventory_import_draft_listing_outbox
       SET state = 'accepted', receipt = $2::jsonb, accepted_at = COALESCE(accepted_at, now()), updated_at = now()
       WHERE message_id = $1 AND state = 'sending'`,
      [row.message_id, JSON.stringify(receipt)],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "draft listing delivery failed";
    await db.query(
      `UPDATE inventory_import_draft_listing_outbox
       SET state = CASE WHEN attempts >= 8 THEN 'failed' ELSE 'pending' END,
           last_error = $2, updated_at = now()
       WHERE message_id = $1 AND state = 'sending'`,
      [row.message_id, message],
    );
  }
  return 1;
}
