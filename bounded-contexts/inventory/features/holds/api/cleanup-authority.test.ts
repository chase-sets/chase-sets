import { describe, expect, it, vi } from "vitest";
import { EVENT_STORE_READ_PAGE_SIZE_MAX, type ReadStreamInput, type StoredEvent } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  INVENTORY_HOLD_AUTHORITY_MAX_EVENTS,
  INVENTORY_HOLD_SOURCE_LOOKUP_FETCH_ROWS,
  INVENTORY_HOLD_SOURCE_LOOKUP_MAX_HOLDS,
  INVENTORY_HOLD_SOURCE_LOOKUP_SQL,
  INVENTORY_RESERVATION_AUTHORITY_MAX_EVENTS,
  createInventoryHoldCleanupAuthority,
  inventoryHoldIdFromStreamId,
} from "./cleanup-authority";

const TENANT_ID = "tnt_cleanup";
const OTHER_TENANT_ID = "tnt_other";
const ORDER_ID = "ord_cleanup_1";
const SELLER_ACCOUNT_ID = "acc_seller";
const HOLD_ID = "hld_1";
const RESERVATION_REQUEST_ID = "rsv_1";

type EventSpec = Readonly<{
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  recordedAt?: string;
  tenantId?: string;
  streamVersion?: number;
}>;

function storedEvents(streamId: string, specs: readonly EventSpec[]): StoredEvent[] {
  return specs.map((spec, index) => {
    const streamVersion = spec.streamVersion ?? index + 1;
    return {
      eventId: `evt_${streamId}_${streamVersion}`,
      streamId,
      streamVersion,
      globalPosition: String(index + 1),
      tenantId: spec.tenantId ?? TENANT_ID,
      eventType: spec.eventType,
      payload: spec.payload,
      metadata: {},
      occurredAt: spec.recordedAt ?? "2026-08-02T00:00:00.000Z",
      recordedAt: spec.recordedAt ?? "2026-08-02T00:00:00.000Z",
      performedByUserId: "usr_test",
      forAccountId: SELLER_ACCOUNT_ID,
    } as unknown as StoredEvent;
  });
}

function createReader(streams: Readonly<Record<string, readonly StoredEvent[]>>) {
  const calls: ReadStreamInput[] = [];
  return {
    calls,
    readStream: async (input: ReadStreamInput) => {
      calls.push(input);
      const limit = input.limit ?? EVENT_STORE_READ_PAGE_SIZE_MAX;
      const fromVersion = input.fromVersion ?? 1;
      return (streams[String(input.streamId)] ?? [])
        .filter((event) => event.streamVersion >= fromVersion)
        .slice(0, limit);
    },
  };
}

type LookupRow = Readonly<{ stream_id: string; first_global_position: string }>;

function createLookupDb(rows: readonly LookupRow[] | Error) {
  const query = vi.fn(async () => {
    if (rows instanceof Error) {
      throw rows;
    }
    return { rows, rowCount: rows.length };
  });
  return { db: { query } as unknown as PgQueryable, query };
}

function authorityFor(
  streams: Readonly<Record<string, readonly StoredEvent[]>>,
  rows: readonly LookupRow[] | Error = [],
) {
  const reader = createReader(streams);
  const lookup = createLookupDb(rows);
  return {
    reader,
    query: lookup.query,
    authority: createInventoryHoldCleanupAuthority({ eventStore: reader, db: lookup.db }),
  };
}

const reservationStreamId = `inventory.reservation-${RESERVATION_REQUEST_ID}`;
const holdStreamId = `inventory.hold-${HOLD_ID}`;

const CONFIRMED_EVENT: EventSpec = {
  eventType: "inventory.reservation.confirmed",
  payload: {
    reservationRequestId: RESERVATION_REQUEST_ID,
    orderId: ORDER_ID,
    sellerAccountId: SELLER_ACCOUNT_ID,
    inventoryItemId: "inv_1",
    quantity: 1,
    holdId: HOLD_ID,
  },
};

const RELEASED_EVENT: EventSpec = {
  eventType: "inventory.reservation.released",
  payload: {
    reservationRequestId: RESERVATION_REQUEST_ID,
    orderId: ORDER_ID,
    holdId: HOLD_ID,
    sellerAccountId: SELLER_ACCOUNT_ID,
    releasedAt: "2026-08-03T00:00:05.000Z",
    releaseReason: "order-cancelled",
  },
};

const PLACED_ORDER_HOLD: EventSpec = {
  eventType: "inventory.hold.placed",
  payload: {
    holdId: HOLD_ID,
    accountId: SELLER_ACCOUNT_ID,
    itemId: "inv_1",
    quantity: 1,
    reason: "Ordering commitment",
    notes: null,
    purpose: "order",
    sourceRef: { orderId: ORDER_ID, reservationRequestId: RESERVATION_REQUEST_ID },
    expiresAt: null,
  },
};

const PLACED_CHECKOUT_HOLD: EventSpec = {
  eventType: "inventory.hold.placed",
  payload: {
    holdId: HOLD_ID,
    accountId: SELLER_ACCOUNT_ID,
    itemId: "inv_1",
    quantity: 1,
    reason: "Checkout reservation",
    notes: null,
    purpose: "checkout",
    sourceRef: { checkoutSessionId: "chk_1", lineKey: "line_1" },
    expiresAt: "2026-08-02T01:00:00.000Z",
  },
};

function extended(extensionCount: number): EventSpec {
  return {
    eventType: "inventory.hold.extended",
    payload: {
      holdId: HOLD_ID,
      extendedAt: "2026-08-02T00:30:00.000Z",
      expiresAt: `2026-08-02T0${extensionCount + 1}:00:00.000Z`,
      extensionCount,
    },
  };
}

const CONVERTED: EventSpec = {
  eventType: "inventory.hold.converted",
  payload: {
    holdId: HOLD_ID,
    convertedAt: "2026-08-02T00:45:00.000Z",
    purpose: "order",
    sourceRef: { orderId: ORDER_ID, reservationRequestId: RESERVATION_REQUEST_ID },
    expiresAt: null,
  },
};

function releasedHold(releaseReason = "order-cancelled", recordedAt = "2026-08-03T00:00:05.000Z"): EventSpec {
  return {
    eventType: "inventory.hold.released",
    payload: { holdId: HOLD_ID, releasedAt: recordedAt, releaseReason },
    recordedAt,
  };
}

describe("cleanup-authority-complete-read-bounds", () => {
  it("reads reservation and Hold streams with only streamId and maxEvents", async () => {
    const { reader, authority } = authorityFor({
      [reservationStreamId]: storedEvents(reservationStreamId, [CONFIRMED_EVENT]),
      [holdStreamId]: storedEvents(holdStreamId, [PLACED_ORDER_HOLD]),
    });

    await authority.readReservationAuthority({ tenantId: TENANT_ID, reservationRequestId: RESERVATION_REQUEST_ID });
    await authority.readHoldAuthority({ tenantId: TENANT_ID, holdId: HOLD_ID });

    expect(reader.calls).toHaveLength(2);
    for (const call of reader.calls) {
      expect(Object.keys(call).sort()).toEqual(["fromVersion", "limit", "streamId"]);
      expect(call.limit).toBe(EVENT_STORE_READ_PAGE_SIZE_MAX);
      expect(call).not.toHaveProperty("pageSize");
    }
    expect(reader.calls.map((call) => String(call.streamId))).toEqual([reservationStreamId, holdStreamId]);
  });

  it("accepts a two-event reservation history and refuses a third", async () => {
    expect(INVENTORY_RESERVATION_AUTHORITY_MAX_EVENTS).toBe(2);

    const atBound = authorityFor({
      [reservationStreamId]: storedEvents(reservationStreamId, [CONFIRMED_EVENT, RELEASED_EVENT]),
    });
    const atBoundAuthority = await atBound.authority.readReservationAuthority({
      tenantId: TENANT_ID,
      reservationRequestId: RESERVATION_REQUEST_ID,
    });
    expect(atBoundAuthority.kind).toBe("confirmed");

    const overBound = authorityFor({
      [reservationStreamId]: storedEvents(reservationStreamId, [CONFIRMED_EVENT, RELEASED_EVENT, RELEASED_EVENT]),
    });
    expect(
      await overBound.authority.readReservationAuthority({
        tenantId: TENANT_ID,
        reservationRequestId: RESERVATION_REQUEST_ID,
      }),
    ).toEqual({
      kind: "unavailable",
      reservationRequestId: RESERVATION_REQUEST_ID,
      detail: "reservation-stream-unreadable",
    });
  });

  it("accepts a 64-event Hold history and refuses 65", async () => {
    expect(INVENTORY_HOLD_AUTHORITY_MAX_EVENTS).toBe(64);

    const extensions = (count: number) => Array.from({ length: count }, (_unused, index) => extended(index + 1));
    const atBound = authorityFor({
      [holdStreamId]: storedEvents(holdStreamId, [
        PLACED_CHECKOUT_HOLD,
        ...extensions(INVENTORY_HOLD_AUTHORITY_MAX_EVENTS - 2),
        CONVERTED,
      ]),
    });
    const atBoundAuthority = await atBound.authority.readHoldAuthority({ tenantId: TENANT_ID, holdId: HOLD_ID });
    expect(atBoundAuthority.kind).toBe("hold");

    const overBound = authorityFor({
      [holdStreamId]: storedEvents(holdStreamId, [
        PLACED_CHECKOUT_HOLD,
        ...extensions(INVENTORY_HOLD_AUTHORITY_MAX_EVENTS - 1),
        CONVERTED,
      ]),
    });
    expect(await overBound.authority.readHoldAuthority({ tenantId: TENANT_ID, holdId: HOLD_ID })).toEqual({
      kind: "unavailable",
      holdId: HOLD_ID,
      detail: "hold-stream-unreadable",
    });
  });
});

describe("cleanup-authority-history-validation", () => {
  it("returns a complete v1 confirmation with an optional v2 that omits item and quantity", async () => {
    const { authority } = authorityFor({
      [reservationStreamId]: storedEvents(reservationStreamId, [CONFIRMED_EVENT, RELEASED_EVENT]),
    });

    const result = await authority.readReservationAuthority({
      tenantId: TENANT_ID,
      reservationRequestId: RESERVATION_REQUEST_ID,
    });
    expect(result).toEqual({
      kind: "confirmed",
      reservationRequestId: RESERVATION_REQUEST_ID,
      orderId: ORDER_ID,
      sellerAccountId: SELLER_ACCOUNT_ID,
      inventoryItemId: "inv_1",
      quantity: 1,
      holdId: HOLD_ID,
      released: {
        reservationRequestId: RESERVATION_REQUEST_ID,
        orderId: ORDER_ID,
        sellerAccountId: SELLER_ACCOUNT_ID,
        holdId: HOLD_ID,
        releasedAt: "2026-08-03T00:00:05.000Z",
        releaseReason: "order-cancelled",
      },
      streamVersion: 2,
    });
    if (result.kind !== "confirmed" || result.released === null) {
      throw new Error("expected a released confirmation");
    }
    expect(result.released).not.toHaveProperty("inventoryItemId");
    expect(result.released).not.toHaveProperty("quantity");
  });

  it("refuses a missing, non-terminal, mixed, repeated, or identity-mismatched reservation history", async () => {
    const cases: readonly Readonly<{ label: string; specs: readonly EventSpec[]; detail: string }>[] = [
      { label: "missing", specs: [], detail: "reservation-stream-missing" },
      {
        label: "release-without-confirmation",
        specs: [RELEASED_EVENT],
        detail: "reservation-v1-malformed",
      },
      { label: "repeated-confirmation", specs: [CONFIRMED_EVENT, CONFIRMED_EVENT], detail: "reservation-v2-invalid" },
      {
        label: "rejection-followed-by-event",
        specs: [
          {
            eventType: "inventory.reservation.rejected",
            payload: {
              reservationRequestId: RESERVATION_REQUEST_ID,
              orderId: ORDER_ID,
              sellerAccountId: SELLER_ACCOUNT_ID,
              inventoryItemId: "inv_1",
              quantity: 1,
              reason: "insufficient-available-quantity",
            },
          },
          RELEASED_EVENT,
        ],
        detail: "reservation-terminal-followed-by-event",
      },
      {
        label: "v2-identity-mismatch",
        specs: [CONFIRMED_EVENT, { ...RELEASED_EVENT, payload: { ...RELEASED_EVENT.payload, holdId: "hld_other" } }],
        detail: "reservation-v2-identity-mismatch",
      },
      {
        label: "v1-request-mismatch",
        specs: [{ ...CONFIRMED_EVENT, payload: { ...CONFIRMED_EVENT.payload, reservationRequestId: "rsv_other" } }],
        detail: "reservation-v1-malformed",
      },
      {
        label: "not-from-first-version",
        specs: [{ ...CONFIRMED_EVENT, streamVersion: 2 }],
        detail: "reservation-stream-unreadable",
      },
    ];

    for (const testCase of cases) {
      const { authority } = authorityFor({
        [reservationStreamId]: storedEvents(reservationStreamId, testCase.specs),
      });
      expect({
        label: testCase.label,
        ...(await authority.readReservationAuthority({
          tenantId: TENANT_ID,
          reservationRequestId: RESERVATION_REQUEST_ID,
        })),
      }).toEqual({
        label: testCase.label,
        kind: "unavailable",
        reservationRequestId: RESERVATION_REQUEST_ID,
        detail: testCase.detail,
      });
    }
  });

  it("folds a direct Order Hold and a converted checkout Hold to the same order ownership", async () => {
    const direct = authorityFor({ [holdStreamId]: storedEvents(holdStreamId, [PLACED_ORDER_HOLD]) });
    expect(await direct.authority.readHoldAuthority({ tenantId: TENANT_ID, holdId: HOLD_ID })).toEqual({
      kind: "hold",
      holdId: HOLD_ID,
      sellerAccountId: SELLER_ACCOUNT_ID,
      inventoryItemId: "inv_1",
      quantity: 1,
      origin: "placed",
      sourceOrderId: ORDER_ID,
      sourceReservationRequestId: RESERVATION_REQUEST_ID,
      status: "active",
      releaseReason: null,
      releasedRecordedAt: null,
      streamVersion: 1,
    });

    const converted = authorityFor({
      [holdStreamId]: storedEvents(holdStreamId, [PLACED_CHECKOUT_HOLD, extended(1), extended(2), CONVERTED]),
    });
    expect(await converted.authority.readHoldAuthority({ tenantId: TENANT_ID, holdId: HOLD_ID })).toEqual({
      kind: "hold",
      holdId: HOLD_ID,
      sellerAccountId: SELLER_ACCOUNT_ID,
      inventoryItemId: "inv_1",
      quantity: 1,
      origin: "converted",
      sourceOrderId: ORDER_ID,
      sourceReservationRequestId: RESERVATION_REQUEST_ID,
      status: "active",
      releaseReason: null,
      releasedRecordedAt: null,
      streamVersion: 4,
    });
  });

  it("reports each Hold terminal exactly once and refuses anything after it", async () => {
    const released = authorityFor({
      [holdStreamId]: storedEvents(holdStreamId, [PLACED_ORDER_HOLD, releasedHold()]),
    });
    const releasedAuthority = await released.authority.readHoldAuthority({ tenantId: TENANT_ID, holdId: HOLD_ID });
    expect(releasedAuthority).toMatchObject({
      status: "released",
      releaseReason: "order-cancelled",
      releasedRecordedAt: "2026-08-03T00:00:05.000Z",
    });

    const consumed = authorityFor({
      [holdStreamId]: storedEvents(holdStreamId, [
        PLACED_ORDER_HOLD,
        {
          eventType: "inventory.hold.consumed",
          payload: {
            holdId: HOLD_ID,
            consumedAt: "2026-08-03T00:00:00.000Z",
            consumptionReason: "dispatched",
            sourceRef: { orderId: ORDER_ID, reservationRequestId: RESERVATION_REQUEST_ID },
          },
        },
      ]),
    });
    expect(await consumed.authority.readHoldAuthority({ tenantId: TENANT_ID, holdId: HOLD_ID })).toMatchObject({
      status: "consumed",
      releaseReason: null,
    });

    const expired = authorityFor({
      [holdStreamId]: storedEvents(holdStreamId, [
        PLACED_CHECKOUT_HOLD,
        CONVERTED,
        { eventType: "inventory.hold.expired", payload: { holdId: HOLD_ID, expiredAt: "2026-08-03T00:00:00.000Z" } },
      ]),
    });
    expect(await expired.authority.readHoldAuthority({ tenantId: TENANT_ID, holdId: HOLD_ID })).toMatchObject({
      status: "expired",
    });

    const afterTerminal = authorityFor({
      [holdStreamId]: storedEvents(holdStreamId, [PLACED_ORDER_HOLD, releasedHold(), releasedHold()]),
    });
    expect(await afterTerminal.authority.readHoldAuthority({ tenantId: TENANT_ID, holdId: HOLD_ID })).toEqual({
      kind: "unavailable",
      holdId: HOLD_ID,
      detail: "hold-event-after-terminal",
    });
  });

  it("refuses a Hold history that is not an Order-owned lifecycle", async () => {
    const cases: readonly Readonly<{ label: string; specs: readonly EventSpec[]; detail: string }>[] = [
      { label: "missing", specs: [], detail: "hold-stream-missing" },
      { label: "no-placement", specs: [releasedHold()], detail: "hold-placement-missing" },
      {
        label: "identity-mismatch",
        specs: [{ ...PLACED_ORDER_HOLD, payload: { ...PLACED_ORDER_HOLD.payload, holdId: "hld_other" } }],
        detail: "hold-identity-mismatch",
      },
      {
        label: "order-purpose-without-source",
        specs: [{ ...PLACED_ORDER_HOLD, payload: { ...PLACED_ORDER_HOLD.payload, sourceRef: null } }],
        detail: "hold-order-source-missing",
      },
      {
        label: "manual-purpose",
        specs: [
          {
            ...PLACED_ORDER_HOLD,
            payload: { ...PLACED_ORDER_HOLD.payload, purpose: "manual", sourceRef: null },
          },
        ],
        detail: "hold-purpose-not-order-capable",
      },
      { label: "checkout-never-converted", specs: [PLACED_CHECKOUT_HOLD], detail: "hold-not-order-owned" },
      {
        label: "conversion-of-order-hold",
        specs: [PLACED_ORDER_HOLD, CONVERTED],
        detail: "hold-conversion-invalid",
      },
      {
        label: "extension-out-of-sequence",
        specs: [PLACED_CHECKOUT_HOLD, extended(2)],
        detail: "hold-extension-not-increasing",
      },
      {
        label: "conversion-source-missing",
        specs: [PLACED_CHECKOUT_HOLD, { ...CONVERTED, payload: { ...CONVERTED.payload, sourceRef: null } }],
        detail: "hold-order-source-missing",
      },
      {
        label: "conversion-wrong-purpose",
        specs: [PLACED_CHECKOUT_HOLD, { ...CONVERTED, payload: { ...CONVERTED.payload, purpose: "checkout" } }],
        detail: "hold-conversion-purpose-invalid",
      },
      {
        label: "unexpected-event",
        specs: [PLACED_ORDER_HOLD, { eventType: "inventory.hold.invented", payload: { holdId: HOLD_ID } }],
        detail: "hold-unexpected-event",
      },
    ];

    for (const testCase of cases) {
      const { authority } = authorityFor({ [holdStreamId]: storedEvents(holdStreamId, testCase.specs) });
      expect({
        label: testCase.label,
        ...(await authority.readHoldAuthority({ tenantId: TENANT_ID, holdId: HOLD_ID })),
      }).toEqual({ label: testCase.label, kind: "unavailable", holdId: HOLD_ID, detail: testCase.detail });
    }
  });

  it("refuses a stream whose events belong to another tenant", async () => {
    const foreignReservation = authorityFor({
      [reservationStreamId]: storedEvents(reservationStreamId, [{ ...CONFIRMED_EVENT, tenantId: OTHER_TENANT_ID }]),
    });
    expect(
      await foreignReservation.authority.readReservationAuthority({
        tenantId: TENANT_ID,
        reservationRequestId: RESERVATION_REQUEST_ID,
      }),
    ).toEqual({
      kind: "unavailable",
      reservationRequestId: RESERVATION_REQUEST_ID,
      detail: "reservation-stream-wrong-tenant",
    });

    const foreignHold = authorityFor({
      [holdStreamId]: storedEvents(holdStreamId, [{ ...PLACED_ORDER_HOLD, tenantId: OTHER_TENANT_ID }]),
    });
    expect(await foreignHold.authority.readHoldAuthority({ tenantId: TENANT_ID, holdId: HOLD_ID })).toEqual({
      kind: "unavailable",
      holdId: HOLD_ID,
      detail: "hold-stream-wrong-tenant",
    });
  });
});

describe("cleanup-authority-inventory-source-lookup", () => {
  it("queries exact tenant, both source-bearing event types, and the sourceRef order id", async () => {
    const { authority, query } = authorityFor({}, [{ stream_id: holdStreamId, first_global_position: "7" }]);
    const result = await authority.lookupOrderHoldIds({ tenantId: TENANT_ID, orderId: ORDER_ID });

    expect(result).toEqual({ kind: "lookup", holdIds: [HOLD_ID] });
    expect(query).toHaveBeenCalledWith(INVENTORY_HOLD_SOURCE_LOOKUP_SQL, [TENANT_ID, ORDER_ID]);
    expect(INVENTORY_HOLD_SOURCE_LOOKUP_SQL).toContain("tenant_id = $1");
    expect(INVENTORY_HOLD_SOURCE_LOOKUP_SQL).toContain("'inventory.hold.placed'");
    expect(INVENTORY_HOLD_SOURCE_LOOKUP_SQL).toContain("'inventory.hold.converted'");
    expect(INVENTORY_HOLD_SOURCE_LOOKUP_SQL).toContain("payload -> 'sourceRef' ->> 'orderId' = $2");
    expect(INVENTORY_HOLD_SOURCE_LOOKUP_SQL).toContain("ORDER BY first_global_position ASC, stream_id ASC");
    expect(INVENTORY_HOLD_SOURCE_LOOKUP_SQL).toContain(`LIMIT ${INVENTORY_HOLD_SOURCE_LOOKUP_FETCH_ROWS}`);
    // The UNLOGGED projection is never the authority for this question.
    expect(INVENTORY_HOLD_SOURCE_LOOKUP_SQL).not.toContain("inventory_reservation_pages");
    expect(INVENTORY_HOLD_SOURCE_LOOKUP_SQL).not.toContain("inventory_holds");
  });

  it("preserves the query's own ordering and maps stream ids to Hold ids", async () => {
    const { authority } = authorityFor({}, [
      { stream_id: "inventory.hold-hld_a", first_global_position: "3" },
      { stream_id: "inventory.hold-hld_b", first_global_position: "9" },
    ]);
    expect(await authority.lookupOrderHoldIds({ tenantId: TENANT_ID, orderId: ORDER_ID })).toEqual({
      kind: "lookup",
      holdIds: ["hld_a", "hld_b"],
    });
  });

  it("accepts 64 distinct streams and refuses 65", async () => {
    const rowsFor = (count: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        stream_id: `inventory.hold-hld_${index}`,
        first_global_position: String(index + 1),
      }));

    const atBound = authorityFor({}, rowsFor(INVENTORY_HOLD_SOURCE_LOOKUP_MAX_HOLDS));
    const atBoundResult = await atBound.authority.lookupOrderHoldIds({ tenantId: TENANT_ID, orderId: ORDER_ID });
    expect(atBoundResult).toMatchObject({ kind: "lookup" });
    if (atBoundResult.kind !== "lookup") {
      throw new Error("expected a lookup");
    }
    expect(atBoundResult.holdIds).toHaveLength(64);

    const overBound = authorityFor({}, rowsFor(INVENTORY_HOLD_SOURCE_LOOKUP_FETCH_ROWS));
    expect(await overBound.authority.lookupOrderHoldIds({ tenantId: TENANT_ID, orderId: ORDER_ID })).toEqual({
      kind: "unavailable",
      detail: "hold-lookup-over-bound",
    });
  });

  it("refuses a foreign stream id, an empty tenant or Order id, and an unreadable query", async () => {
    const foreign = authorityFor({}, [{ stream_id: "inventory.reservation-rsv_1", first_global_position: "1" }]);
    expect(await foreign.authority.lookupOrderHoldIds({ tenantId: TENANT_ID, orderId: ORDER_ID })).toEqual({
      kind: "unavailable",
      detail: "hold-lookup-foreign-stream",
    });

    const missingTenant = authorityFor({}, []);
    expect(await missingTenant.authority.lookupOrderHoldIds({ tenantId: "", orderId: ORDER_ID })).toEqual({
      kind: "unavailable",
      detail: "hold-lookup-tenant-required",
    });
    expect(await missingTenant.authority.lookupOrderHoldIds({ tenantId: TENANT_ID, orderId: " " })).toEqual({
      kind: "unavailable",
      detail: "hold-lookup-order-id-required",
    });

    const unreadable = authorityFor({}, new Error("connection reset"));
    expect(await unreadable.authority.lookupOrderHoldIds({ tenantId: TENANT_ID, orderId: ORDER_ID })).toEqual({
      kind: "unavailable",
      detail: "hold-lookup-unreadable",
    });
  });

  it("returns an empty set for an Order with no source-bearing Hold events", async () => {
    const { authority } = authorityFor({}, []);
    expect(await authority.lookupOrderHoldIds({ tenantId: TENANT_ID, orderId: ORDER_ID })).toEqual({
      kind: "lookup",
      holdIds: [],
    });
  });

  it("maps Hold stream ids through one shared grammar", () => {
    expect(inventoryHoldIdFromStreamId("inventory.hold-hld_1")).toBe("hld_1");
    expect(inventoryHoldIdFromStreamId("inventory.hold-")).toBeNull();
    expect(inventoryHoldIdFromStreamId("ordering.order-ord_1")).toBeNull();
  });
});
