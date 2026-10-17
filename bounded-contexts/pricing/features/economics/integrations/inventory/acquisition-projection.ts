import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AcquisitionOccurrence } from "@chase-sets/event-core/public-event-payloads";
import { requirePositiveInteger, requireRfc3339Instant } from "../../domain/contracts";

export type InventoryAcquisitionProjectionEvent = Readonly<{
  id: string;
  streamVersion: number;
  data: Record<string, unknown>;
  timing: Readonly<{ occurredAt: string; recordedAt: string }>;
}>;

/**
 * Called by the existing pricing-inventory-input-projection handlers. Keeping
 * the write in this feature lets the source projection retain its one canonical
 * subscription while Economics owns the occurrence validation and table shape.
 */
export async function projectInventoryAcquisitionLot(
  db: PgQueryable,
  event: InventoryAcquisitionProjectionEvent,
  eventType: "inventory.item.created" | "inventory.item.adjusted",
): Promise<void> {
  if (!Number.isSafeInteger(event.streamVersion) || event.streamVersion < 1) {
    throw new Error("Inventory acquisition projection requires a positive stream version.");
  }
  const eventId = identity(event.id, "source event id");
  const recordedAt = requireRfc3339Instant(event.timing.recordedAt, "source event recordedAt");
  const itemId = identity(event.data.itemId, "itemId");
  const quantity =
    eventType === "inventory.item.created"
      ? requirePositiveInteger(event.data.totalQuantity, "totalQuantity", Number.MAX_SAFE_INTEGER)
      : adjustedQuantity(event.data.quantityDelta);
  if (quantity === null) return;

  const occurrence = parseAcquisitionOccurrence(event.data.acquisitionOccurrence, event.timing.occurredAt);
  const columns = occurrence.kind === "occurred" ? [occurrence.occurredAt, occurrence.source] : [null, null];

  if (eventType === "inventory.item.created") {
    const accountId = identity(event.data.accountId, "accountId");
    await insertKnownAccountLot(db, {
      accountId,
      itemId,
      streamVersion: event.streamVersion,
      quantity,
      occurrence,
      acquiredAt: columns[0],
      occurrenceSource: columns[1],
      eventId,
      recordedAt,
    });
    return;
  }

  const result = await db.query<{ binding_count: string; persisted_count: string }>(
    `WITH account_binding AS (
       SELECT pricing_inventory_item_inputs.seller_account_id AS account_id
       FROM pricing_inventory_item_inputs
       WHERE pricing_inventory_item_inputs.item_id = $1
     ), persisted AS (
       INSERT INTO pricing_inventory_acquisition_lots (
         account_id,
         inventory_item_id,
         event_stream_version,
         quantity,
         occurrence_kind,
         acquired_at,
         occurrence_source,
         last_source_event_id,
         last_source_event_recorded_at
       )
       SELECT account_binding.account_id, $1, $2, $3, $4, $5, $6, $7, $8
       FROM account_binding
       ON CONFLICT (account_id, inventory_item_id, event_stream_version) DO UPDATE
       SET quantity = pricing_inventory_acquisition_lots.quantity
       WHERE pricing_inventory_acquisition_lots.quantity = EXCLUDED.quantity
         AND pricing_inventory_acquisition_lots.occurrence_kind = EXCLUDED.occurrence_kind
         AND pricing_inventory_acquisition_lots.acquired_at IS NOT DISTINCT FROM EXCLUDED.acquired_at
         AND pricing_inventory_acquisition_lots.occurrence_source IS NOT DISTINCT FROM EXCLUDED.occurrence_source
         AND pricing_inventory_acquisition_lots.last_source_event_id = EXCLUDED.last_source_event_id
         AND pricing_inventory_acquisition_lots.last_source_event_recorded_at = EXCLUDED.last_source_event_recorded_at
       RETURNING 1
     )
     SELECT
       (SELECT COUNT(*)::text FROM account_binding) AS binding_count,
       (SELECT COUNT(*)::text FROM persisted) AS persisted_count`,
    [itemId, event.streamVersion, quantity, occurrence.kind, columns[0], columns[1], eventId, recordedAt],
  );
  const outcome = result.rows[0];
  if (!outcome || outcome.binding_count !== "1") {
    throw new Error("A positive Inventory adjustment requires exactly one account-qualified item binding.");
  }
  if (outcome.persisted_count !== "1") {
    throw new Error("An Inventory acquisition lot stream version conflicts with a different source event.");
  }
}

type LotInsert = Readonly<{
  accountId: string;
  itemId: string;
  streamVersion: number;
  quantity: number;
  occurrence: AcquisitionOccurrence;
  acquiredAt: string | null;
  occurrenceSource: string | null;
  eventId: string;
  recordedAt: string;
}>;

async function insertKnownAccountLot(db: PgQueryable, input: LotInsert): Promise<void> {
  const result = await db.query<{ persisted_count: string }>(
    `WITH persisted AS (
       INSERT INTO pricing_inventory_acquisition_lots (
         account_id,
         inventory_item_id,
         event_stream_version,
         quantity,
         occurrence_kind,
         acquired_at,
         occurrence_source,
         last_source_event_id,
         last_source_event_recorded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (account_id, inventory_item_id, event_stream_version) DO UPDATE
       SET quantity = pricing_inventory_acquisition_lots.quantity
       WHERE pricing_inventory_acquisition_lots.quantity = EXCLUDED.quantity
         AND pricing_inventory_acquisition_lots.occurrence_kind = EXCLUDED.occurrence_kind
         AND pricing_inventory_acquisition_lots.acquired_at IS NOT DISTINCT FROM EXCLUDED.acquired_at
         AND pricing_inventory_acquisition_lots.occurrence_source IS NOT DISTINCT FROM EXCLUDED.occurrence_source
         AND pricing_inventory_acquisition_lots.last_source_event_id = EXCLUDED.last_source_event_id
         AND pricing_inventory_acquisition_lots.last_source_event_recorded_at = EXCLUDED.last_source_event_recorded_at
       RETURNING 1
     )
     SELECT COUNT(*)::text AS persisted_count
     FROM persisted`,
    [
      input.accountId,
      input.itemId,
      input.streamVersion,
      input.quantity,
      input.occurrence.kind,
      input.acquiredAt,
      input.occurrenceSource,
      input.eventId,
      input.recordedAt,
    ],
  );
  if (result.rows[0]?.persisted_count !== "1") {
    throw new Error("An Inventory acquisition lot stream version conflicts with a different source event.");
  }
}

function parseAcquisitionOccurrence(raw: unknown, commandOccurredAt: string): AcquisitionOccurrence {
  // Retained events emitted before acquisition occurrence was captured have
  // no occurrence field. Their history remains readable and explicitly unknown.
  if (raw === undefined) return { kind: "unknown" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("acquisitionOccurrence must be an object.");
  }
  const occurrence = raw as Record<string, unknown>;
  if (occurrence.kind === "unknown") {
    assertKeys(occurrence, ["kind"]);
    return { kind: "unknown" };
  }
  if (occurrence.kind !== "occurred") throw new Error("acquisitionOccurrence kind is unknown.");
  assertKeys(occurrence, ["kind", "occurredAt", "source"]);
  const occurredAt = requireRfc3339Instant(occurrence.occurredAt, "acquisitionOccurrence.occurredAt");
  const commandAt = requireRfc3339Instant(commandOccurredAt, "command occurredAt");
  if (Date.parse(occurredAt) > Date.parse(commandAt)) {
    throw new Error("acquisitionOccurrence cannot be later than the Inventory command occurrence.");
  }
  if (occurrence.source !== "seller-supplied" && occurrence.source !== "import-supplied") {
    throw new Error("acquisitionOccurrence source is unknown.");
  }
  return { kind: "occurred", occurredAt, source: occurrence.source };
}

function adjustedQuantity(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("quantityDelta must be a safe integer.");
  }
  return value > 0 ? value : null;
}

function assertKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`acquisitionOccurrence must contain exactly: ${sortedExpected.join(", ")}.`);
  }
}

function identity(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${name} must be non-empty and already trimmed.`);
  }
  return value;
}
