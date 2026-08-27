import { createHash } from "node:crypto";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type {
  InventoryAdjustmentReason,
  InventoryAdjustmentSourceRef,
  InventoryOfflineSaleChannel,
} from "@chase-sets/event-core/public-event-payloads";
import type { InventoryRuntimeDeps } from "./index";

export type InventoryAdjustmentCommandFingerprintInput = Readonly<{
  accountId: string;
  itemId: string;
  quantityDelta: number;
  reason: string;
  reasonCode?: InventoryAdjustmentReason;
  note?: string | null;
  sourceRef?: InventoryAdjustmentSourceRef;
  salePriceAmount?: string | null;
  channel?: InventoryOfflineSaleChannel;
  collisionMode?: "protect-orders" | "honor-offline";
}>;

export type InventoryAdjustmentIdempotencyRow<TCollision = unknown> = Readonly<{
  inserted: boolean;
  command_fingerprint: string;
  status: "in_progress" | "completed";
  result_item_id: string | null;
  result_version: string | number | null;
  result_collision: TCollision | null;
  created_at: string | Date;
}>;

export function normalizeInventoryIdempotencyKey(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function normalizeInventoryAdjustmentNote(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function inventoryAdjustmentCommandFingerprint(input: InventoryAdjustmentCommandFingerprintInput): string {
  const extendedReason =
    input.reasonCode !== undefined || input.note !== undefined
      ? {
          reasonCode: input.reasonCode ?? null,
          note: input.note === undefined ? null : normalizeInventoryAdjustmentNote(input.note),
        }
      : {};
  const sale =
    input.salePriceAmount !== undefined || input.channel !== undefined || input.collisionMode !== undefined
      ? {
          salePriceAmount: input.salePriceAmount ?? null,
          channel: input.channel ?? null,
          collisionMode: input.collisionMode ?? "protect-orders",
        }
      : {};

  return createHash("sha256")
    .update(
      JSON.stringify({
        accountId: input.accountId,
        itemId: input.itemId,
        quantityDelta: input.quantityDelta,
        reason: input.reason.trim(),
        sourceRef: input.sourceRef ?? null,
        ...extendedReason,
        ...sale,
      }),
    )
    .digest("hex");
}

export async function claimInventoryAdjustmentIdempotency<TCollision = unknown>(
  db: InventoryRuntimeDeps["db"],
  input: Readonly<{
    idempotencyKey: string;
    accountId: string;
    itemId: string;
    commandFingerprint: string;
  }>,
): Promise<InventoryAdjustmentIdempotencyRow<TCollision> | null> {
  const result = await db.query<InventoryAdjustmentIdempotencyRow<TCollision>>(
    `WITH inserted AS (
       INSERT INTO inventory_item_adjustment_idempotency (
         idempotency_key,
         account_id,
         item_id,
         command_fingerprint,
         status,
         created_at
       ) VALUES ($1, $2, $3, $4, 'in_progress', now())
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING true AS inserted, command_fingerprint, status, result_item_id, result_version, result_collision, created_at
     )
     SELECT inserted, command_fingerprint, status, result_item_id, result_version, result_collision, created_at
     FROM inserted
     UNION ALL
     SELECT false AS inserted, command_fingerprint, status, result_item_id, result_version, result_collision, created_at
     FROM inventory_item_adjustment_idempotency
     WHERE idempotency_key = $1
       AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`,
    [input.idempotencyKey, input.accountId, input.itemId, input.commandFingerprint],
  );
  const row = result.rows[0] ?? null;
  return row?.inserted ? null : row;
}

export async function recoverInventoryAdjustmentIdempotency(
  deps: InventoryRuntimeDeps,
  input: Readonly<{
    existing: InventoryAdjustmentIdempotencyRow;
    idempotencyKey: string;
    commandFingerprint: string;
    accountId: string;
    itemId: string;
    quantityDelta: number;
    reason: string;
    reasonCode?: InventoryAdjustmentReason;
    note?: string | null;
    sourceRef?: InventoryAdjustmentSourceRef;
  }>,
): Promise<{ itemId: string; version: number } | null> {
  const createdAt = new Date(input.existing.created_at).getTime();
  const normalizedReason = input.reason.trim();
  const events = await readCompleteStream(deps.eventStore, { streamId: `inventory.item-${input.itemId}` });
  const committed = [...events].reverse().find((event) => {
    if (event.eventType !== "inventory.item.adjusted") {
      return false;
    }
    if (Number.isFinite(createdAt) && new Date(event.recordedAt).getTime() < createdAt) {
      return false;
    }

    const payload = event.payload as {
      itemId?: unknown;
      quantityDelta?: unknown;
      reason?: unknown;
      reasonCode?: unknown;
      note?: unknown;
      sourceRef?: unknown;
    };
    const extendedReasonMatches =
      input.reasonCode === undefined && input.note === undefined
        ? true
        : (payload.reasonCode ?? null) === (input.reasonCode ?? null) &&
          (payload.note ?? null) === (input.note === undefined ? null : normalizeInventoryAdjustmentNote(input.note));
    return (
      payload.itemId === input.itemId &&
      payload.quantityDelta === input.quantityDelta &&
      payload.reason === normalizedReason &&
      extendedReasonMatches &&
      JSON.stringify(payload.sourceRef ?? null) === JSON.stringify(input.sourceRef ?? null) &&
      event.forAccountId === input.accountId
    );
  });
  if (!committed) {
    return null;
  }

  const version = Number(committed.streamVersion);
  const completed = await completeInventoryAdjustmentIdempotency(deps.db, {
    idempotencyKey: input.idempotencyKey,
    commandFingerprint: input.commandFingerprint,
    resultItemId: input.itemId,
    resultVersion: version,
    resultCollision: null,
  });
  return completed ? { itemId: input.itemId, version } : null;
}

export async function completeInventoryAdjustmentIdempotency<TCollision>(
  db: InventoryRuntimeDeps["db"],
  input: Readonly<{
    idempotencyKey: string;
    commandFingerprint: string;
    resultItemId: string;
    resultVersion: number;
    resultCollision: TCollision | null;
  }>,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE inventory_item_adjustment_idempotency
     SET status = 'completed',
         result_item_id = $3,
         result_version = $4,
         result_collision = $5::jsonb,
         completed_at = now()
     WHERE idempotency_key = $1
       AND status = 'in_progress'
       AND command_fingerprint = $2`,
    [
      input.idempotencyKey,
      input.commandFingerprint,
      input.resultItemId,
      input.resultVersion,
      JSON.stringify(input.resultCollision),
    ],
  );
  return result.rowCount !== 0;
}

export async function releaseInventoryAdjustmentIdempotency(
  db: InventoryRuntimeDeps["db"],
  idempotencyKey: string,
): Promise<void> {
  await db.query(
    `DELETE FROM inventory_item_adjustment_idempotency
     WHERE idempotency_key = $1
       AND status = 'in_progress'`,
    [idempotencyKey],
  );
}
