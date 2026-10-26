import { randomUUID } from "node:crypto";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  inventoryDraftListingErrorCodes,
  inventoryDraftListingUnavailableDiagnostics,
  type InventoryDraftListingErrorCode,
  type InventoryDraftListingMessage,
  type InventoryDraftListingReceipt,
} from "@chase-sets/inventory-draft-listing";

export type InventoryDraftListingDelivery = Readonly<{
  accept(message: InventoryDraftListingMessage, context: EventStoreContext): Promise<InventoryDraftListingReceipt>;
}>;

export type InventoryDraftListingDeliveryMessage = InventoryDraftListingMessage;

export type InventoryDraftListingDeliveryResult = Readonly<
  | { outcome: "idle" }
  | { outcome: "accepted"; messageId: string; attempts: number }
  | { outcome: "lost"; messageId: string; attempts: number }
  | { outcome: "requeued"; messageId: string; attempts: number; code: string }
  | { outcome: "failed"; messageId: string; attempts: number; code: string }
>;

const MAX_ATTEMPTS = 8;
const CLAIM_TTL_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60 * 1_000;

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
  claimed_until timestamptz NULL,
  claim_token text NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_batch_id, import_row_id),
  CHECK (state IN ('pending', 'sending', 'accepted', 'failed'))
);
CREATE INDEX IF NOT EXISTS inventory_import_draft_listing_outbox_pending_idx
  ON inventory_import_draft_listing_outbox (state, next_attempt_at, claimed_until, created_at, message_id);
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
      message.snapshot.importBatchId,
      message.snapshot.importRowId,
      JSON.stringify(message),
    ],
  );
}

function classifyDeliveryError(error: unknown): Readonly<{ code: string; permanent: boolean }> {
  const candidate = error as { code?: unknown; diagnostic?: unknown } | null;
  const code = inventoryDraftListingErrorCodes.includes(candidate?.code as InventoryDraftListingErrorCode)
    ? (candidate?.code as InventoryDraftListingErrorCode)
    : "inventory-draft-unavailable";
  const diagnostic = inventoryDraftListingUnavailableDiagnostics.includes(candidate?.diagnostic as never)
    ? String(candidate?.diagnostic)
    : "unexpected-failure";
  return { code: `${code}:${diagnostic}`, permanent: code === "inventory-draft-conflict" };
}

function retryDelayMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.max(0, attempts - 1));
}

export async function processNextInventoryDraftListingDelivery(
  db: PgQueryable,
  delivery: InventoryDraftListingDelivery | undefined,
): Promise<InventoryDraftListingDeliveryResult> {
  if (!delivery) return { outcome: "idle" };
  const claimToken = randomUUID();
  const claimed = await db.query<{
    message_id: string;
    tenant_id: string;
    account_id: string;
    performed_by_user_id: string;
    message: InventoryDraftListingDeliveryMessage;
    attempts: number | string;
  }>(
    `WITH next_message AS (
       SELECT message_id FROM inventory_import_draft_listing_outbox
       WHERE next_attempt_at <= now()
         AND (state = 'pending' OR (state = 'sending' AND claimed_until <= now()))
       ORDER BY created_at, message_id
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE inventory_import_draft_listing_outbox AS outbox
     SET state = 'sending', attempts = attempts + 1, claimed_at = now(),
         claimed_until = now() + ($2::text || ' milliseconds')::interval,
         claim_token = $1, updated_at = now()
     FROM next_message
     WHERE outbox.message_id = next_message.message_id
     RETURNING outbox.message_id, outbox.tenant_id, outbox.account_id,
       outbox.performed_by_user_id, outbox.message, outbox.attempts`,
    [claimToken, CLAIM_TTL_MS],
  );
  const row = claimed.rows[0];
  if (!row) return { outcome: "idle" };
  const attempts = Number(row.attempts);
  const context: EventStoreContext = {
    tenantId: row.tenant_id as EventStoreContext["tenantId"],
    audit: {
      forAccountId: row.account_id as EventStoreContext["audit"]["forAccountId"],
      performedByUserId: row.performed_by_user_id as EventStoreContext["audit"]["performedByUserId"],
    },
  };

  let receipt: InventoryDraftListingReceipt;
  try {
    receipt = await delivery.accept(row.message, context);
  } catch (error) {
    const classified = classifyDeliveryError(error);
    const terminal = classified.permanent || attempts >= MAX_ATTEMPTS;
    const update = await db.query(
      `UPDATE inventory_import_draft_listing_outbox
       SET state = CASE WHEN $3::boolean THEN 'failed' ELSE 'pending' END,
           last_error = $4, next_attempt_at = CASE WHEN $3::boolean THEN now()
             ELSE now() + ($5::text || ' milliseconds')::interval END,
           claimed_until = NULL, claim_token = NULL, updated_at = now()
       WHERE message_id = $1 AND state = 'sending' AND claim_token = $2`,
      [row.message_id, claimToken, terminal, classified.code, retryDelayMs(attempts)],
    );
    if (Number(update.rowCount ?? 0) !== 1) return { outcome: "lost", messageId: row.message_id, attempts };
    return {
      outcome: terminal ? "failed" : "requeued",
      messageId: row.message_id,
      attempts,
      code: classified.code,
    };
  }

  const ack = await db.query(
    `UPDATE inventory_import_draft_listing_outbox
     SET state = 'accepted', receipt = $3::jsonb, accepted_at = COALESCE(accepted_at, now()),
         claimed_until = NULL, claim_token = NULL, next_attempt_at = now(), updated_at = now()
     WHERE message_id = $1 AND state = 'sending' AND claim_token = $2`,
    [row.message_id, claimToken, JSON.stringify(receipt)],
  );
  if (Number(ack.rowCount ?? 0) !== 1) return { outcome: "lost", messageId: row.message_id, attempts };
  return { outcome: "accepted", messageId: row.message_id, attempts };
}
