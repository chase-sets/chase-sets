import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type {
  InventoryAdjustmentReason,
  InventoryHoldPurpose,
  InventoryHoldSourceRef,
  InventoryOfflineSaleChannel,
} from "@chase-sets/event-core/public-event-payloads";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type LedgerKind =
  | "created"
  | "adjusted"
  | "offline-sale"
  | "hold-placed"
  | "hold-converted"
  | "hold-consumed"
  | "hold-released"
  | "hold-expired"
  | "restock-decision";

type HoldLookup = Readonly<{
  hold_id: string;
  account_id: string;
  item_id: string;
  quantity: number;
  reason: string;
  purpose: InventoryHoldPurpose;
  source_ref: InventoryHoldSourceRef;
}>;

type HoldLedgerLookup = Readonly<{
  account_id: string;
  item_id: string;
  hold_quantity: number | null;
  reason: string;
  purpose: InventoryHoldPurpose | null;
  source_ref: InventoryHoldSourceRef;
}>;

export function buildInventoryItemLedgerProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "inventory.item.created": async (event) => {
      const data = event.data as {
        itemId: string;
        accountId: string;
        totalQuantity: number;
      };

      await insertLedgerEntry(db, {
        event,
        itemId: data.itemId,
        accountId: data.accountId,
        kind: "created",
        quantityDelta: data.totalQuantity,
        holdQuantity: null,
        purpose: null,
        reason: "Inventory item created",
        reasonCode: null,
        note: null,
        sourceRef: null,
        actor: actorFromAudit(event.audit),
      });
    },
    "inventory.item.adjusted": async (event) => {
      const data = event.data as {
        itemId: string;
        quantityDelta: number;
        reason: string;
        reasonCode?: InventoryAdjustmentReason;
        note?: string | null;
        sourceRef?: InventoryHoldSourceRef;
      };
      const accountId = accountIdFromAudit(event.audit);

      await insertLedgerEntry(db, {
        event,
        itemId: data.itemId,
        accountId,
        kind: "adjusted",
        quantityDelta: data.quantityDelta,
        holdQuantity: null,
        purpose: null,
        reason: data.reason,
        reasonCode: data.reasonCode ?? null,
        note: data.note ?? null,
        sourceRef: data.sourceRef ?? null,
        actor: actorFromAudit(event.audit),
      });
    },
    "inventory.item.offline-sale-recorded": async (event) => {
      const data = event.data as {
        itemId: string;
        quantity: number;
        salePriceAmount: string | null;
        channel: InventoryOfflineSaleChannel;
      };

      await insertLedgerEntry(db, {
        event,
        itemId: data.itemId,
        accountId: accountIdFromAudit(event.audit),
        kind: "offline-sale",
        quantityDelta: -data.quantity,
        holdQuantity: null,
        purpose: null,
        reason: "Offline sale",
        reasonCode: null,
        note: null,
        salePriceAmount: data.salePriceAmount,
        channel: data.channel,
        sourceRef: null,
        actor: actorFromAudit(event.audit),
      });
    },
    "inventory.hold.placed": async (event) => {
      const data = event.data as {
        holdId: string;
        accountId: string;
        itemId: string;
        quantity: number;
        reason: string;
        purpose?: InventoryHoldPurpose;
        sourceRef?: InventoryHoldSourceRef;
      };

      await insertLedgerEntry(db, {
        event,
        itemId: data.itemId,
        accountId: data.accountId,
        kind: "hold-placed",
        quantityDelta: null,
        holdQuantity: data.quantity,
        purpose: data.purpose ?? "manual",
        reason: data.reason,
        reasonCode: null,
        note: null,
        sourceRef: data.sourceRef ?? null,
        actor: (data.purpose ?? "manual") === "manual" ? actorFromAudit(event.audit) : "system",
      });
    },
    "inventory.hold.converted": async (event) => {
      await insertHoldTerminalLedgerEntry(db, event, "hold-converted", "Hold converted");
    },
    "inventory.hold.consumed": async (event) => {
      const hold = await findHoldForLifecycleEvent(db, event);
      if (!hold) {
        return;
      }

      await insertLedgerEntry(db, {
        event,
        itemId: hold.item_id,
        accountId: hold.account_id,
        kind: "hold-consumed",
        quantityDelta: -hold.quantity,
        holdQuantity: hold.quantity,
        purpose: hold.purpose,
        reason: reasonFromData(event.data, "Sale recorded"),
        reasonCode: null,
        note: null,
        sourceRef: sourceRefFromData(event.data) ?? hold.source_ref,
        actor: "system",
      });
    },
    "inventory.hold.released": async (event) => {
      await insertHoldTerminalLedgerEntry(db, event, "hold-released", "Hold released");
    },
    "inventory.hold.expired": async (event) => {
      await insertHoldTerminalLedgerEntry(db, event, "hold-expired", "Hold expired");
    },
    "inventory.restock-decision.recorded": async (event) => {
      const data = event.data as {
        accountId: string;
        itemId: string;
        quantity: number;
        outcome: string;
        reason: string;
        sourceRef?: InventoryHoldSourceRef;
      };

      await insertLedgerEntry(db, {
        event,
        itemId: data.itemId,
        accountId: data.accountId,
        kind: "restock-decision",
        quantityDelta: null,
        holdQuantity: data.quantity,
        purpose: "order",
        reason: data.reason || data.outcome,
        reasonCode: null,
        note: null,
        sourceRef: data.sourceRef ?? null,
        actor: "seller",
      });
    },
  };
}

async function insertHoldTerminalLedgerEntry(
  db: PgQueryable,
  event: Parameters<NonNullable<ProjectorHandlerMap[string]>>[0],
  kind: LedgerKind,
  fallbackReason: string,
) {
  const hold = await findHoldForLifecycleEvent(db, event);
  if (!hold) {
    return;
  }

  await insertLedgerEntry(db, {
    event,
    itemId: hold.item_id,
    accountId: hold.account_id,
    kind,
    quantityDelta: null,
    holdQuantity: hold.quantity,
    purpose: hold.purpose,
    reason: reasonFromData(event.data, fallbackReason),
    reasonCode: null,
    note: null,
    sourceRef: sourceRefFromData(event.data) ?? hold.source_ref,
    actor: kind === "hold-released" && hold.purpose === "manual" ? actorFromAudit(event.audit) : "system",
  });
}

async function findHoldForLifecycleEvent(
  db: PgQueryable,
  event: Parameters<NonNullable<ProjectorHandlerMap[string]>>[0],
): Promise<HoldLookup | null> {
  const data = event.data as {
    holdId?: unknown;
    accountId?: unknown;
    itemId?: unknown;
    quantity?: unknown;
    reason?: unknown;
    purpose?: unknown;
    sourceRef?: unknown;
  };
  const holdId = typeof data.holdId === "string" ? data.holdId : "";
  if (!holdId) {
    return null;
  }

  const ledgerResult = await db.query<HoldLedgerLookup>(
    `SELECT account_id, item_id, hold_quantity, reason, purpose, source_ref
     FROM inventory_item_ledger
     WHERE stream_id = $1
       AND kind = 'hold-placed'
     ORDER BY stream_version DESC
     LIMIT 1`,
    [event.streamId],
  );
  const ledgerRow = ledgerResult.rows[0] ?? null;
  if (ledgerRow && ledgerRow.hold_quantity !== null && ledgerRow.purpose) {
    return {
      hold_id: holdId,
      account_id: ledgerRow.account_id,
      item_id: ledgerRow.item_id,
      quantity: ledgerRow.hold_quantity,
      reason: ledgerRow.reason,
      purpose: ledgerRow.purpose,
      source_ref: ledgerRow.source_ref,
    };
  }

  const result = await db.query<HoldLookup>(
    `SELECT hold_id, account_id, item_id, quantity, reason, purpose, source_ref
     FROM inventory_holds
     WHERE hold_id = $1
     LIMIT 1`,
    [holdId],
  );
  const row = result.rows[0] ?? null;
  if (row) {
    return row;
  }

  if (
    typeof data.accountId === "string" &&
    typeof data.itemId === "string" &&
    typeof data.quantity === "number" &&
    Number.isInteger(data.quantity)
  ) {
    return {
      hold_id: holdId,
      account_id: data.accountId,
      item_id: data.itemId,
      quantity: data.quantity,
      reason: typeof data.reason === "string" ? data.reason : "",
      purpose: isInventoryHoldPurpose(data.purpose) ? data.purpose : "manual",
      source_ref: isInventoryHoldSourceRef(data.sourceRef) ? data.sourceRef : null,
    };
  }

  return null;
}

async function insertLedgerEntry(
  db: PgQueryable,
  input: Readonly<{
    event: Parameters<NonNullable<ProjectorHandlerMap[string]>>[0];
    itemId: string;
    accountId: string;
    kind: LedgerKind;
    quantityDelta: number | null;
    holdQuantity: number | null;
    purpose: InventoryHoldPurpose | null;
    reason: string;
    reasonCode: InventoryAdjustmentReason | null;
    note: string | null;
    salePriceAmount?: string | null;
    channel?: InventoryOfflineSaleChannel | null;
    sourceRef: InventoryHoldSourceRef;
    actor: "seller" | "system";
  }>,
) {
  await db.query(
    `INSERT INTO inventory_item_ledger (
       ledger_entry_id,
       item_id,
       account_id,
       occurred_at,
       kind,
       quantity_delta,
       hold_quantity,
       purpose,
       reason,
       reason_code,
       note,
       sale_price_amount,
       channel,
       source_ref,
       actor,
       event_type,
       stream_id,
       stream_version,
       recorded_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     ON CONFLICT (ledger_entry_id) DO NOTHING`,
    [
      `${input.event.streamId}:${input.event.streamVersion}`,
      input.itemId,
      input.accountId,
      input.event.timing.occurredAt,
      input.kind,
      input.quantityDelta,
      input.holdQuantity,
      input.purpose,
      input.reason,
      input.reasonCode,
      input.note,
      input.salePriceAmount ?? null,
      input.channel ?? null,
      input.sourceRef ? JSON.stringify(input.sourceRef) : null,
      input.actor,
      input.event.type,
      input.event.streamId,
      input.event.streamVersion,
      input.event.timing.recordedAt,
    ],
  );
}

function accountIdFromAudit(audit: unknown): string {
  return typeof audit === "object" &&
    audit !== null &&
    typeof (audit as { forAccountId?: unknown }).forAccountId === "string"
    ? (audit as { forAccountId: string }).forAccountId
    : "";
}

function actorFromAudit(audit: unknown): "seller" | "system" {
  if (typeof audit !== "object" || audit === null) {
    return "system";
  }

  const userId = (audit as { performedByUserId?: unknown }).performedByUserId;
  if (typeof userId !== "string") {
    return "system";
  }

  return userId.includes("_system") ? "system" : "seller";
}

function reasonFromData(data: unknown, fallback: string): string {
  if (typeof data !== "object" || data === null) {
    return fallback;
  }

  const record = data as Record<string, unknown>;
  for (const key of ["reason", "releaseReason", "consumptionReason", "expirationReason"]) {
    if (typeof record[key] === "string" && record[key].trim().length > 0) {
      return record[key];
    }
  }

  return fallback;
}

function sourceRefFromData(data: unknown): InventoryHoldSourceRef | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const sourceRef = (data as { sourceRef?: unknown }).sourceRef;
  return isInventoryHoldSourceRef(sourceRef) ? sourceRef : null;
}

function isInventoryHoldPurpose(value: unknown): value is InventoryHoldPurpose {
  return ["order", "manual", "checkout", "pos", "channel", "transfer"].includes(String(value));
}

function isInventoryHoldSourceRef(value: unknown): value is NonNullable<InventoryHoldSourceRef> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { orderId?: unknown }).orderId === "string" &&
    typeof (value as { reservationRequestId?: unknown }).reservationRequestId === "string"
  );
}
