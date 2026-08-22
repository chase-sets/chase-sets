import { readCompleteStream, type CompleteStreamReader } from "@chase-sets/event-core/complete-stream";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { INVENTORY_HOLD_SOURCE_ORDER_INDEX_NAME } from "../read-model/schema";

/**
 * Inventory-owned cleanup authority (#7222, Decision #7221 option B).
 *
 * Ordering may not read Inventory storage, so Inventory answers three
 * questions about its own complete source streams and nothing else:
 *
 * 1. what is the complete authority for one Order reservation request,
 * 2. what is the complete lifecycle of one Hold, and
 * 3. which Hold streams carry this Order id in their source reference.
 *
 * Every answer comes from complete event-stream histories. The UNLOGGED
 * `inventory_reservation_pages` / `inventory_holds` projections are never
 * consulted, no command is issued, and no event is appended.
 */

/** Inclusive complete-read bound for one reservation stream: v1 plus optional v2. */
export const INVENTORY_RESERVATION_AUTHORITY_MAX_EVENTS = 2;
/** Inclusive complete-read bound for one Hold stream. */
export const INVENTORY_HOLD_AUTHORITY_MAX_EVENTS = 64;
/** Largest Hold set an Order may legitimately own. */
export const INVENTORY_HOLD_SOURCE_LOOKUP_MAX_HOLDS = 64;
/**
 * Rows the lookup query fetches: one past the bound, so an over-bound Order is
 * detected rather than silently truncated to a plausible-looking set. A read
 * page size, not a business policy value.
 */
export const INVENTORY_HOLD_SOURCE_LOOKUP_FETCH_ROWS = INVENTORY_HOLD_SOURCE_LOOKUP_MAX_HOLDS + 1;

export { INVENTORY_HOLD_SOURCE_ORDER_INDEX_NAME };

/**
 * Reverse Hold lookup over Inventory's own source events.
 *
 * Exact tenant, both source-bearing event types, ordered by first matching
 * global position then stream id, and bounded at one row past the maximum so
 * an over-bound Order is visible. Backed by
 * `event_store_events_inventory_hold_source_order_idx`.
 */
export const INVENTORY_HOLD_SOURCE_LOOKUP_SQL = `SELECT stream_id, MIN(global_position) AS first_global_position
     FROM event_store_events
     WHERE tenant_id = $1
       AND event_type IN ('inventory.hold.placed', 'inventory.hold.converted')
       AND payload -> 'sourceRef' ->> 'orderId' = $2
     GROUP BY stream_id
     ORDER BY first_global_position ASC, stream_id ASC
     LIMIT ${INVENTORY_HOLD_SOURCE_LOOKUP_FETCH_ROWS}`;

export type InventoryReservationReleaseAuthority = Readonly<{
  reservationRequestId: string;
  orderId: string;
  sellerAccountId: string;
  holdId: string;
  releasedAt: string;
  releaseReason: string;
}>;

export type InventoryReservationAuthority =
  | Readonly<{
      kind: "confirmed";
      reservationRequestId: string;
      orderId: string;
      sellerAccountId: string;
      inventoryItemId: string;
      quantity: number;
      holdId: string;
      released: InventoryReservationReleaseAuthority | null;
      streamVersion: number;
    }>
  | Readonly<{
      kind: "rejected";
      reservationRequestId: string;
      orderId: string;
      sellerAccountId: string;
      inventoryItemId: string;
      quantity: number;
      reason: string;
      streamVersion: number;
    }>
  | Readonly<{ kind: "unavailable"; reservationRequestId: string; detail: string }>;

export type InventoryHoldCleanupStatus = "active" | "released" | "consumed" | "expired";

export type InventoryHoldCleanupAuthority =
  | Readonly<{
      kind: "hold";
      holdId: string;
      sellerAccountId: string;
      inventoryItemId: string;
      quantity: number;
      origin: "placed" | "converted";
      sourceOrderId: string;
      sourceReservationRequestId: string;
      status: InventoryHoldCleanupStatus;
      releaseReason: string | null;
      releasedRecordedAt: string | null;
      streamVersion: number;
    }>
  | Readonly<{ kind: "unavailable"; holdId: string; detail: string }>;

export type InventoryHoldSourceLookup =
  | Readonly<{ kind: "lookup"; holdIds: readonly string[] }>
  | Readonly<{ kind: "unavailable"; detail: string }>;

export type InventoryHoldCleanupAuthorityServices = Readonly<{
  readReservationAuthority: (
    input: Readonly<{ tenantId: string; reservationRequestId: string }>,
  ) => Promise<InventoryReservationAuthority>;
  readHoldAuthority: (input: Readonly<{ tenantId: string; holdId: string }>) => Promise<InventoryHoldCleanupAuthority>;
  lookupOrderHoldIds: (input: Readonly<{ tenantId: string; orderId: string }>) => Promise<InventoryHoldSourceLookup>;
}>;

export type InventoryHoldCleanupAuthorityDeps = Readonly<{
  eventStore: CompleteStreamReader;
  db: PgQueryable;
}>;

type HoldSourceLookupRow = Readonly<{ stream_id: string; first_global_position: string | number | bigint }>;

function payloadOf(event: StoredEvent): Readonly<Record<string, unknown>> {
  const payload = event.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

function nonEmptyString(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function positiveInteger(payload: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nestedObject(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | null {
  const value = payload[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function sameTenant(events: readonly StoredEvent[], tenantId: string): boolean {
  return events.every((event) => String(event.tenantId) === tenantId);
}

function reservationUnavailable(reservationRequestId: string, detail: string): InventoryReservationAuthority {
  return { kind: "unavailable", reservationRequestId, detail };
}

function holdUnavailable(holdId: string, detail: string): InventoryHoldCleanupAuthority {
  return { kind: "unavailable", holdId, detail };
}

/**
 * Folds one complete reservation stream.
 *
 * Valid authority is exactly a v1 `confirmed` or `rejected`, optionally
 * followed by a v2 `released` that may only follow a confirmation. The v2
 * payload carries request, order, seller, and Hold -- not item or quantity --
 * so this fold validates exactly the fields it carries and no more. Missing,
 * over-bound, malformed, mixed, repeated, or non-terminal histories are
 * unavailable.
 */
function foldReservationAuthority(
  reservationRequestId: string,
  events: readonly StoredEvent[],
): InventoryReservationAuthority {
  if (events.length === 0) {
    return reservationUnavailable(reservationRequestId, "reservation-stream-missing");
  }

  const first = events[0]!;
  if (first.streamVersion !== 1) {
    return reservationUnavailable(reservationRequestId, "reservation-stream-not-from-first-version");
  }

  const firstPayload = payloadOf(first);
  const declaredRequestId = nonEmptyString(firstPayload, "reservationRequestId");
  const orderId = nonEmptyString(firstPayload, "orderId");
  const sellerAccountId = nonEmptyString(firstPayload, "sellerAccountId");
  const inventoryItemId = nonEmptyString(firstPayload, "inventoryItemId");
  const quantity = positiveInteger(firstPayload, "quantity");
  if (
    declaredRequestId !== reservationRequestId ||
    orderId === null ||
    sellerAccountId === null ||
    inventoryItemId === null ||
    quantity === null
  ) {
    return reservationUnavailable(reservationRequestId, "reservation-v1-malformed");
  }

  if (first.eventType === "inventory.reservation.rejected") {
    if (events.length !== 1) {
      return reservationUnavailable(reservationRequestId, "reservation-terminal-followed-by-event");
    }
    const reason = nonEmptyString(firstPayload, "reason");
    if (reason === null) {
      return reservationUnavailable(reservationRequestId, "reservation-v1-malformed");
    }
    return {
      kind: "rejected",
      reservationRequestId,
      orderId,
      sellerAccountId,
      inventoryItemId,
      quantity,
      reason,
      streamVersion: first.streamVersion,
    };
  }

  if (first.eventType !== "inventory.reservation.confirmed") {
    return reservationUnavailable(reservationRequestId, "reservation-v1-not-terminal");
  }

  const holdId = nonEmptyString(firstPayload, "holdId");
  if (holdId === null) {
    return reservationUnavailable(reservationRequestId, "reservation-v1-malformed");
  }

  if (events.length === 1) {
    return {
      kind: "confirmed",
      reservationRequestId,
      orderId,
      sellerAccountId,
      inventoryItemId,
      quantity,
      holdId,
      released: null,
      streamVersion: first.streamVersion,
    };
  }

  if (events.length !== 2) {
    return reservationUnavailable(reservationRequestId, "reservation-stream-over-bound");
  }

  const second = events[1]!;
  if (second.eventType !== "inventory.reservation.released" || second.streamVersion !== 2) {
    return reservationUnavailable(reservationRequestId, "reservation-v2-invalid");
  }

  const secondPayload = payloadOf(second);
  const releasedRequestId = nonEmptyString(secondPayload, "reservationRequestId");
  const releasedOrderId = nonEmptyString(secondPayload, "orderId");
  const releasedSellerAccountId = nonEmptyString(secondPayload, "sellerAccountId");
  const releasedHoldId = nonEmptyString(secondPayload, "holdId");
  const releasedAt = nonEmptyString(secondPayload, "releasedAt");
  const releaseReason = nonEmptyString(secondPayload, "releaseReason");
  if (
    releasedRequestId === null ||
    releasedOrderId === null ||
    releasedSellerAccountId === null ||
    releasedHoldId === null ||
    releasedAt === null ||
    releaseReason === null
  ) {
    return reservationUnavailable(reservationRequestId, "reservation-v2-malformed");
  }
  if (
    releasedRequestId !== reservationRequestId ||
    releasedOrderId !== orderId ||
    releasedSellerAccountId !== sellerAccountId ||
    releasedHoldId !== holdId
  ) {
    return reservationUnavailable(reservationRequestId, "reservation-v2-identity-mismatch");
  }

  return {
    kind: "confirmed",
    reservationRequestId,
    orderId,
    sellerAccountId,
    inventoryItemId,
    quantity,
    holdId,
    released: {
      reservationRequestId: releasedRequestId,
      orderId: releasedOrderId,
      sellerAccountId: releasedSellerAccountId,
      holdId: releasedHoldId,
      releasedAt,
      releaseReason,
    },
    streamVersion: second.streamVersion,
  };
}

type HoldFoldState = {
  origin: "placed" | "converted" | null;
  purpose: string | null;
  sellerAccountId: string | null;
  inventoryItemId: string | null;
  quantity: number | null;
  sourceOrderId: string | null;
  sourceReservationRequestId: string | null;
  status: InventoryHoldCleanupStatus;
  releaseReason: string | null;
  releasedRecordedAt: string | null;
  extensionCount: number;
  terminalSeen: boolean;
};

/**
 * Folds one complete Hold stream.
 *
 * A direct Order Hold is `placed` at version 1 with purpose `order` and an
 * exact `{orderId, reservationRequestId}` source. A converted checkout Hold is
 * `placed` with purpose `checkout`, then zero or more strictly increasing
 * `extended` events, then exactly one `converted` to purpose `order` with the
 * exact source. At most one `released|consumed|expired` terminal may follow,
 * and nothing may follow it.
 */
function foldHoldAuthority(holdId: string, events: readonly StoredEvent[]): InventoryHoldCleanupAuthority {
  if (events.length === 0) {
    return holdUnavailable(holdId, "hold-stream-missing");
  }

  const first = events[0]!;
  if (first.eventType !== "inventory.hold.placed" || first.streamVersion !== 1) {
    return holdUnavailable(holdId, "hold-placement-missing");
  }

  const placedPayload = payloadOf(first);
  if (nonEmptyString(placedPayload, "holdId") !== holdId) {
    return holdUnavailable(holdId, "hold-identity-mismatch");
  }
  const accountId = nonEmptyString(placedPayload, "accountId");
  const itemId = nonEmptyString(placedPayload, "itemId");
  const quantity = positiveInteger(placedPayload, "quantity");
  const purpose = nonEmptyString(placedPayload, "purpose");
  if (accountId === null || itemId === null || quantity === null || purpose === null) {
    return holdUnavailable(holdId, "hold-placement-malformed");
  }

  const state: HoldFoldState = {
    origin: null,
    purpose,
    sellerAccountId: accountId,
    inventoryItemId: itemId,
    quantity,
    sourceOrderId: null,
    sourceReservationRequestId: null,
    status: "active",
    releaseReason: null,
    releasedRecordedAt: null,
    extensionCount: 0,
    terminalSeen: false,
  };

  if (purpose === "order") {
    const sourceRef = nestedObject(placedPayload, "sourceRef");
    const sourceOrderId = sourceRef ? nonEmptyString(sourceRef, "orderId") : null;
    const sourceReservationRequestId = sourceRef ? nonEmptyString(sourceRef, "reservationRequestId") : null;
    if (sourceOrderId === null || sourceReservationRequestId === null) {
      return holdUnavailable(holdId, "hold-order-source-missing");
    }
    state.origin = "placed";
    state.sourceOrderId = sourceOrderId;
    state.sourceReservationRequestId = sourceReservationRequestId;
  } else if (purpose !== "checkout") {
    return holdUnavailable(holdId, "hold-purpose-not-order-capable");
  }

  for (let index = 1; index < events.length; index += 1) {
    const event = events[index]!;
    if (state.terminalSeen) {
      return holdUnavailable(holdId, "hold-event-after-terminal");
    }
    const payload = payloadOf(event);
    if (nonEmptyString(payload, "holdId") !== holdId) {
      return holdUnavailable(holdId, "hold-identity-mismatch");
    }

    switch (event.eventType) {
      case "inventory.hold.extended": {
        if (state.origin !== null || state.purpose !== "checkout") {
          return holdUnavailable(holdId, "hold-extension-not-checkout");
        }
        const extensionCount = positiveInteger(payload, "extensionCount");
        if (extensionCount === null || extensionCount !== state.extensionCount + 1) {
          return holdUnavailable(holdId, "hold-extension-not-increasing");
        }
        state.extensionCount = extensionCount;
        break;
      }
      case "inventory.hold.converted": {
        if (state.origin !== null || state.purpose !== "checkout") {
          return holdUnavailable(holdId, "hold-conversion-invalid");
        }
        if (nonEmptyString(payload, "purpose") !== "order") {
          return holdUnavailable(holdId, "hold-conversion-purpose-invalid");
        }
        const sourceRef = nestedObject(payload, "sourceRef");
        const sourceOrderId = sourceRef ? nonEmptyString(sourceRef, "orderId") : null;
        const sourceReservationRequestId = sourceRef ? nonEmptyString(sourceRef, "reservationRequestId") : null;
        if (sourceOrderId === null || sourceReservationRequestId === null) {
          return holdUnavailable(holdId, "hold-order-source-missing");
        }
        state.origin = "converted";
        state.purpose = "order";
        state.sourceOrderId = sourceOrderId;
        state.sourceReservationRequestId = sourceReservationRequestId;
        break;
      }
      case "inventory.hold.released": {
        const releaseReason = nonEmptyString(payload, "releaseReason");
        if (releaseReason === null) {
          return holdUnavailable(holdId, "hold-release-malformed");
        }
        state.status = "released";
        state.releaseReason = releaseReason;
        state.releasedRecordedAt = String(event.recordedAt);
        state.terminalSeen = true;
        break;
      }
      case "inventory.hold.consumed": {
        state.status = "consumed";
        state.terminalSeen = true;
        break;
      }
      case "inventory.hold.expired": {
        state.status = "expired";
        state.terminalSeen = true;
        break;
      }
      default:
        return holdUnavailable(holdId, "hold-unexpected-event");
    }
  }

  if (state.origin === null || state.sourceOrderId === null || state.sourceReservationRequestId === null) {
    return holdUnavailable(holdId, "hold-not-order-owned");
  }

  return {
    kind: "hold",
    holdId,
    sellerAccountId: state.sellerAccountId!,
    inventoryItemId: state.inventoryItemId!,
    quantity: state.quantity!,
    origin: state.origin,
    sourceOrderId: state.sourceOrderId,
    sourceReservationRequestId: state.sourceReservationRequestId,
    status: state.status,
    releaseReason: state.releaseReason,
    releasedRecordedAt: state.releasedRecordedAt,
    streamVersion: events[events.length - 1]!.streamVersion,
  };
}

export function inventoryHoldIdFromStreamId(streamId: string): string | null {
  const prefix = "inventory.hold-";
  if (!streamId.startsWith(prefix)) {
    return null;
  }
  const holdId = streamId.slice(prefix.length);
  return holdId.length > 0 ? holdId : null;
}

export function createInventoryHoldCleanupAuthority(
  deps: InventoryHoldCleanupAuthorityDeps,
): InventoryHoldCleanupAuthorityServices {
  return {
    readReservationAuthority: async ({ tenantId, reservationRequestId }) => {
      if (typeof reservationRequestId !== "string" || reservationRequestId.trim().length === 0) {
        return reservationUnavailable(String(reservationRequestId), "reservation-request-id-required");
      }
      let events: readonly StoredEvent[];
      try {
        events = await readCompleteStream(deps.eventStore, {
          streamId: `inventory.reservation-${reservationRequestId}`,
          maxEvents: INVENTORY_RESERVATION_AUTHORITY_MAX_EVENTS,
        });
      } catch {
        return reservationUnavailable(reservationRequestId, "reservation-stream-unreadable");
      }
      if (!sameTenant(events, tenantId)) {
        return reservationUnavailable(reservationRequestId, "reservation-stream-wrong-tenant");
      }
      return foldReservationAuthority(reservationRequestId, events);
    },

    readHoldAuthority: async ({ tenantId, holdId }) => {
      if (typeof holdId !== "string" || holdId.trim().length === 0) {
        return holdUnavailable(String(holdId), "hold-id-required");
      }
      let events: readonly StoredEvent[];
      try {
        events = await readCompleteStream(deps.eventStore, {
          streamId: `inventory.hold-${holdId}`,
          maxEvents: INVENTORY_HOLD_AUTHORITY_MAX_EVENTS,
        });
      } catch {
        return holdUnavailable(holdId, "hold-stream-unreadable");
      }
      if (!sameTenant(events, tenantId)) {
        return holdUnavailable(holdId, "hold-stream-wrong-tenant");
      }
      return foldHoldAuthority(holdId, events);
    },

    lookupOrderHoldIds: async ({ tenantId, orderId }) => {
      if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
        return { kind: "unavailable", detail: "hold-lookup-tenant-required" };
      }
      if (typeof orderId !== "string" || orderId.trim().length === 0) {
        return { kind: "unavailable", detail: "hold-lookup-order-id-required" };
      }

      let rows: readonly HoldSourceLookupRow[];
      try {
        const result = await deps.db.query<HoldSourceLookupRow>(INVENTORY_HOLD_SOURCE_LOOKUP_SQL, [tenantId, orderId]);
        rows = result.rows;
      } catch {
        return { kind: "unavailable", detail: "hold-lookup-unreadable" };
      }

      if (rows.length > INVENTORY_HOLD_SOURCE_LOOKUP_MAX_HOLDS) {
        return { kind: "unavailable", detail: "hold-lookup-over-bound" };
      }

      const holdIds: string[] = [];
      for (const row of rows) {
        const holdId = inventoryHoldIdFromStreamId(String(row.stream_id));
        if (holdId === null) {
          return { kind: "unavailable", detail: "hold-lookup-foreign-stream" };
        }
        holdIds.push(holdId);
      }

      return { kind: "lookup", holdIds };
    },
  };
}
