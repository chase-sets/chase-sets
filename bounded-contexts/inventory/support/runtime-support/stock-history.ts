import { readCompleteStream, type CompleteStreamReader } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  inventoryHoldReleaseReasons,
  type InventoryHoldOrderSourceRef,
} from "@chase-sets/event-core/public-event-payloads";
import { InventoryDomainError } from "./common";

export type InventoryStockHold = Readonly<{
  holdId: string;
  accountId: string;
  itemId: string;
  quantity: number;
  active: boolean;
  purpose: "manual" | "checkout" | "order";
  sourceRef: InventoryHoldOrderSourceRef | null;
  committedAt: string;
}>;

type HoldStreamRow = { stream_id: string; total: string; current_version: string };
const pageSize = 250;

function requireHistory(condition: unknown): asserts condition {
  if (!condition) throw new InventoryDomainError("Inventory stock history is unavailable; reconciliation is required.");
}

export async function readInventoryStockHistory(eventStore: CompleteStreamReader, streamId: string) {
  try {
    return await readCompleteStream(eventStore, { streamId });
  } catch {
    throw new InventoryDomainError("Inventory stock history is unavailable; reconciliation is required.");
  }
}

function record(value: unknown): Record<string, unknown> {
  requireHistory(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function closed(value: Record<string, unknown>, keys: readonly string[]) {
  requireHistory(Object.keys(value).every((key) => keys.includes(key)));
}

function text(value: unknown): string {
  requireHistory(typeof value === "string" && value.trim().length > 0);
  return value;
}

function quantity(value: unknown): number {
  requireHistory(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  return value;
}

function instant(value: unknown): string {
  const source = text(value);
  requireHistory(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(source));
  requireHistory(Number.isFinite(Date.parse(source)));
  return source;
}

function orderSource(value: unknown): InventoryHoldOrderSourceRef {
  const source = record(value);
  requireHistory(Object.keys(source).length === 2);
  return { orderId: text(source.orderId), reservationRequestId: text(source.reservationRequestId) };
}

function assertEnvelope(events: readonly StoredEvent[], streamId: string, tenantId: string) {
  requireHistory(events.length > 0);
  const ids = new Set<string>();
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    requireHistory(event.streamId === streamId && event.tenantId === tenantId && event.streamVersion === index + 1);
    requireHistory(!ids.has(event.eventId));
    ids.add(event.eventId);
  }
}

export function validateInventoryItemStockHistory(input: {
  events: readonly StoredEvent[];
  itemId: string;
  accountId: string;
  tenantId: string;
  version: number;
  totalQuantity: number;
}) {
  const streamId = `inventory.item-${input.itemId}`;
  assertEnvelope(input.events, streamId, input.tenantId);
  requireHistory(input.events.length === input.version);
  let total = 0;
  for (let index = 0; index < input.events.length; index++) {
    const event = input.events[index];
    const payload = record(event.payload);
    requireHistory(payload.itemId === input.itemId);
    if (index === 0) {
      requireHistory(event.eventType === "inventory.item.created" && payload.accountId === input.accountId);
      total = quantity(payload.totalQuantity);
    } else {
      switch (event.eventType) {
        case "inventory.item.adjusted":
          requireHistory(typeof payload.quantityDelta === "number" && Number.isSafeInteger(payload.quantityDelta));
          text(payload.reason);
          total += payload.quantityDelta;
          break;
        case "inventory.item.stock-authority-claimed":
          quantity(payload.quantity);
          text(payload.authorityRef);
          requireHistory(payload.operation === "hold-placement" || payload.operation === "stock-reduction");
          break;
        case "inventory.item.offline-sale-recorded":
          quantity(payload.quantity);
          break;
        default:
          requireHistory(false);
      }
    }
    requireHistory(Number.isSafeInteger(total) && total >= 0);
  }
  requireHistory(total === input.totalQuantity);
}

export function foldInventoryStockHold(input: {
  events: readonly StoredEvent[];
  streamId: string;
  accountId: string;
  itemId: string;
  tenantId: string;
}): InventoryStockHold {
  assertEnvelope(input.events, input.streamId, input.tenantId);
  const first = input.events[0];
  const placed = record(first.payload);
  closed(placed, ["holdId", "accountId", "itemId", "quantity", "reason", "notes", "purpose", "sourceRef", "expiresAt"]);
  const holdId = text(placed.holdId);
  requireHistory(input.streamId === `inventory.hold-${holdId}` && first.eventType === "inventory.hold.placed");
  requireHistory(placed.accountId === input.accountId && placed.itemId === input.itemId);
  const heldQuantity = quantity(placed.quantity);
  text(placed.reason);
  requireHistory(placed.notes === null || placed.notes === undefined || typeof placed.notes === "string");
  const initialPurpose = placed.purpose;
  requireHistory(initialPurpose === "manual" || initialPurpose === "checkout" || initialPurpose === "order");
  let purpose: InventoryStockHold["purpose"] = initialPurpose;
  let sourceRef: InventoryHoldOrderSourceRef | null = null;
  let expiresAt: string | null = null;
  if (purpose === "order") {
    sourceRef = orderSource(placed.sourceRef);
    requireHistory(placed.expiresAt === null || placed.expiresAt === undefined);
  } else if (purpose === "checkout") {
    const source = record(placed.sourceRef);
    requireHistory(Object.keys(source).length === 2);
    text(source.checkoutSessionId);
    text(source.lineKey);
    expiresAt = instant(placed.expiresAt);
  } else {
    requireHistory(placed.sourceRef === null && (placed.expiresAt === null || placed.expiresAt === undefined));
  }
  let active = true;
  let extensionCount = 0;
  let committedAt = instant(first.recordedAt);
  for (const event of input.events.slice(1)) {
    requireHistory(active);
    const payload = record(event.payload);
    requireHistory(payload.holdId === holdId);
    switch (event.eventType) {
      case "inventory.hold.extended": {
        closed(payload, ["holdId", "extendedAt", "expiresAt", "extensionCount"]);
        instant(payload.extendedAt);
        requireHistory(purpose === "checkout" && expiresAt !== null && payload.extensionCount === extensionCount + 1);
        const nextExpiry = instant(payload.expiresAt);
        requireHistory(Date.parse(nextExpiry) > Date.parse(expiresAt));
        expiresAt = nextExpiry;
        extensionCount++;
        break;
      }
      case "inventory.hold.converted":
        closed(payload, ["holdId", "convertedAt", "purpose", "sourceRef", "expiresAt"]);
        requireHistory(purpose === "checkout" && payload.purpose === "order" && payload.expiresAt === null);
        instant(payload.convertedAt);
        sourceRef = orderSource(payload.sourceRef);
        purpose = "order";
        expiresAt = null;
        committedAt = instant(event.recordedAt);
        break;
      case "inventory.hold.released":
        closed(payload, ["holdId", "releasedAt", "releaseReason"]);
        instant(payload.releasedAt);
        requireHistory((inventoryHoldReleaseReasons as readonly unknown[]).includes(payload.releaseReason));
        active = false;
        break;
      case "inventory.hold.expired":
        closed(payload, ["holdId", "expiredAt"]);
        requireHistory(purpose === "checkout" && expiresAt !== null);
        requireHistory(Date.parse(instant(payload.expiredAt)) >= Date.parse(expiresAt));
        active = false;
        break;
      case "inventory.hold.consumed":
        closed(payload, ["holdId", "consumedAt", "consumptionReason", "sourceRef"]);
        requireHistory(purpose === "order" && sourceRef !== null);
        instant(payload.consumedAt);
        text(payload.consumptionReason);
        requireHistory(JSON.stringify(orderSource(payload.sourceRef)) === JSON.stringify(sourceRef));
        active = false;
        break;
      default:
        requireHistory(false);
    }
  }
  return {
    holdId,
    accountId: input.accountId,
    itemId: input.itemId,
    quantity: heldQuantity,
    active,
    purpose,
    sourceRef,
    committedAt,
  };
}

export async function loadInventoryStockHolds(input: {
  db: PgQueryable;
  eventStore: CompleteStreamReader;
  accountId: string;
  itemId: string;
  context: EventStoreContext;
}): Promise<readonly InventoryStockHold[]> {
  const holds: InventoryStockHold[] = [];
  let cursor = "";
  let expectedTotal: number | undefined;
  for (;;) {
    // DISTINCT enumerates streams only. No event, terminal or quantity is
    // removed from the complete history subsequently folded for each stream.
    const result = await input.db.query<HoldStreamRow>(
      `WITH candidates AS (
         SELECT DISTINCT stream_id FROM event_store_events
         WHERE tenant_id = $1 AND stream_context_name = 'inventory'
           AND stream_category = 'inventory.hold'
           AND (payload ->> 'itemId' = $3 OR
             NOT EXISTS (SELECT 1 FROM event_store_events AS placement
               WHERE placement.stream_id = event_store_events.stream_id
                 AND placement.event_type = 'inventory.hold.placed') OR
             (payload ->> 'accountId' = $2 AND event_type = 'inventory.hold.placed'
               AND NOT (payload ? 'itemId')))
       ), counted AS (SELECT stream_id, COUNT(*) OVER () AS total FROM candidates)
       SELECT counted.stream_id, total, stream.current_version FROM counted
       LEFT JOIN event_store_streams AS stream ON stream.stream_id = counted.stream_id
       WHERE counted.stream_id > $4 ORDER BY counted.stream_id LIMIT $5`,
      [input.context.tenantId, input.accountId, input.itemId, cursor, pageSize],
    );
    requireHistory(result.rows.length <= pageSize);
    for (const row of result.rows) {
      const total = Number(row.total);
      requireHistory(Number.isSafeInteger(total) && total > 0);
      if (expectedTotal === undefined) expectedTotal = total;
      requireHistory(total === expectedTotal && typeof row.stream_id === "string" && row.stream_id > cursor);
      cursor = row.stream_id;
      const events = await readInventoryStockHistory(input.eventStore, row.stream_id);
      requireHistory(
        Number.isSafeInteger(Number(row.current_version)) && events.length === Number(row.current_version),
      );
      holds.push(
        foldInventoryStockHold({
          events,
          streamId: row.stream_id,
          accountId: input.accountId,
          itemId: input.itemId,
          tenantId: input.context.tenantId,
        }),
      );
    }
    if (result.rows.length < pageSize) break;
  }
  requireHistory(holds.length === (expectedTotal ?? 0));
  return holds;
}
