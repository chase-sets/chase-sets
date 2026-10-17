import type { CompleteStreamReader } from "@chase-sets/event-core/complete-stream";
import { EVENT_STORE_READ_PAGE_SIZE_MAX, type ReadStreamInput, type StoredEvent } from "@chase-sets/event-core/storage";
import type {
  OrderingInventoryCleanupAuthorityPort,
  OrderingInventoryHoldAuthority,
  OrderingInventoryHoldSourceLookup,
  OrderingInventoryReservationAuthority,
} from "../../features/orders/api/cleanup-authority";

/**
 * Fixtures for the cleanup-authority suites.
 *
 * Stored events are built literally rather than appended through the shared
 * in-memory store, because these suites must control `recordedAt`, stream
 * version gaps, duplicate versions, and tenant ids exactly -- the very fields
 * the fold's causality and identity rules depend on.
 */

export const TEST_TENANT_ID = "tnt_cleanup";
export const OTHER_TENANT_ID = "tnt_other";
export const BUYER_ACCOUNT_ID = "acc_buyer";
export const SELLER_ACCOUNT_ID = "acc_seller";
export const ORDER_ID = "ord_cleanup_1";
export const WINDOW_OPENED_AT = "2026-08-01T00:00:00.000Z";

export type EventSpec = Readonly<{
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  recordedAt?: string;
  streamVersion?: number;
  tenantId?: string;
}>;

let globalPositionCounter = 0;

export function resetGlobalPositions(): void {
  globalPositionCounter = 0;
}

export function buildStoredEvents(streamId: string, specs: readonly EventSpec[]): StoredEvent[] {
  return specs.map((spec, index) => {
    globalPositionCounter += 1;
    const streamVersion = spec.streamVersion ?? index + 1;
    return {
      eventId: `evt_${streamId}_${streamVersion}_${globalPositionCounter}`,
      streamId,
      streamVersion,
      globalPosition: String(globalPositionCounter),
      tenantId: spec.tenantId ?? TEST_TENANT_ID,
      eventType: spec.eventType,
      payload: spec.payload,
      metadata: {},
      occurredAt: spec.recordedAt ?? "2026-08-02T00:00:00.000Z",
      recordedAt: spec.recordedAt ?? "2026-08-02T00:00:00.000Z",
      performedByUserId: "usr_test",
      forAccountId: BUYER_ACCOUNT_ID,
    } as unknown as StoredEvent;
  });
}

export type RecordingStreamReader = CompleteStreamReader &
  Readonly<{
    calls: ReadStreamInput[];
    streamIds: () => readonly string[];
  }>;

/**
 * Mirrors the Postgres store's read contract: `fromVersion` is inclusive and
 * `limit` bounds one page. It records every request so a suite can prove the
 * exact read inputs the production caller used.
 */
export function createRecordingStreamReader(streams: Readonly<Record<string, readonly StoredEvent[]>>) {
  const calls: ReadStreamInput[] = [];
  const reader: RecordingStreamReader = {
    calls,
    streamIds: () => calls.map((call) => String(call.streamId)),
    readStream: async (input) => {
      calls.push(input);
      const limit = input.limit ?? EVENT_STORE_READ_PAGE_SIZE_MAX;
      const fromVersion = input.fromVersion ?? 1;
      return (streams[String(input.streamId)] ?? [])
        .filter((event) => event.streamVersion >= fromVersion)
        .slice(0, limit);
    },
  };
  return reader;
}

export type StubInventoryAuthorityConfig = Readonly<{
  reservations?: Readonly<Record<string, OrderingInventoryReservationAuthority>>;
  holds?: Readonly<Record<string, OrderingInventoryHoldAuthority>>;
  lookup?: OrderingInventoryHoldSourceLookup;
  reservationSequence?: Readonly<Record<string, readonly OrderingInventoryReservationAuthority[]>>;
  holdSequence?: Readonly<Record<string, readonly OrderingInventoryHoldAuthority[]>>;
}>;

export type StubInventoryAuthority = OrderingInventoryCleanupAuthorityPort &
  Readonly<{
    reservationCalls: string[];
    holdCalls: string[];
    lookupCalls: string[];
    tenantIds: string[];
  }>;

/**
 * Stands in for the Inventory-owned authority. Ordering's fold must treat an
 * `unavailable` answer as a conflict and must never substitute a projection
 * or a default, so the stub only ever returns the port's own union.
 */
export function createStubInventoryAuthority(config: StubInventoryAuthorityConfig): StubInventoryAuthority {
  const reservationCalls: string[] = [];
  const holdCalls: string[] = [];
  const lookupCalls: string[] = [];
  const tenantIds: string[] = [];
  const reservationCallCounts = new Map<string, number>();
  const holdCallCounts = new Map<string, number>();

  return {
    reservationCalls,
    holdCalls,
    lookupCalls,
    tenantIds,
    readReservationAuthority: async ({ tenantId, reservationRequestId }) => {
      reservationCalls.push(reservationRequestId);
      tenantIds.push(tenantId);
      const sequence = config.reservationSequence?.[reservationRequestId];
      if (sequence) {
        const index = reservationCallCounts.get(reservationRequestId) ?? 0;
        reservationCallCounts.set(reservationRequestId, index + 1);
        return sequence[Math.min(index, sequence.length - 1)]!;
      }
      return (
        config.reservations?.[reservationRequestId] ?? {
          kind: "unavailable",
          reservationRequestId,
          detail: "reservation-stream-missing",
        }
      );
    },
    readHoldAuthority: async ({ tenantId, holdId }) => {
      holdCalls.push(holdId);
      tenantIds.push(tenantId);
      const sequence = config.holdSequence?.[holdId];
      if (sequence) {
        const index = holdCallCounts.get(holdId) ?? 0;
        holdCallCounts.set(holdId, index + 1);
        return sequence[Math.min(index, sequence.length - 1)]!;
      }
      return config.holds?.[holdId] ?? { kind: "unavailable", holdId, detail: "hold-stream-missing" };
    },
    lookupOrderHoldIds: async ({ tenantId, orderId }) => {
      lookupCalls.push(orderId);
      tenantIds.push(tenantId);
      return config.lookup ?? { kind: "lookup", holdIds: [] };
    },
  };
}

export type ReservationDeclarationFixture = Readonly<{
  reservationRequestId: string;
  inventoryItemId: string;
  sellerAccountId: string;
  quantity: number;
  holdId?: string | null;
}>;

export function orderCreatedPayload(
  overrides: Readonly<{
    orderId?: string;
    buyerAccountId?: string;
    sourceType?: string;
    sourceReferenceId?: string | null;
    reservationRequests?: readonly ReservationDeclarationFixture[];
    lines?: readonly Readonly<{ lineId: string; lineTotalAmount: string }>[];
  }> = {},
): Readonly<Record<string, unknown>> {
  return {
    orderId: overrides.orderId ?? ORDER_ID,
    buyerAccountId: overrides.buyerAccountId ?? BUYER_ACCOUNT_ID,
    sellerAccountId: SELLER_ACCOUNT_ID,
    sourceType: overrides.sourceType ?? "cart-checkout",
    sourceReferenceId: overrides.sourceReferenceId === undefined ? "chk_1" : overrides.sourceReferenceId,
    lines: overrides.lines ?? [{ lineId: "oli_1", lineTotalAmount: "20.00" }],
    reservationRequests: overrides.reservationRequests ?? [
      {
        reservationRequestId: "rsv_1",
        inventoryItemId: "inv_1",
        sellerAccountId: SELLER_ACCOUNT_ID,
        quantity: 1,
        holdId: null,
      },
    ],
  };
}

export function confirmedReservation(
  overrides: Partial<Extract<OrderingInventoryReservationAuthority, { kind: "confirmed" }>> = {},
): OrderingInventoryReservationAuthority {
  return {
    kind: "confirmed",
    reservationRequestId: "rsv_1",
    orderId: ORDER_ID,
    sellerAccountId: SELLER_ACCOUNT_ID,
    inventoryItemId: "inv_1",
    quantity: 1,
    holdId: "hld_1",
    released: null,
    streamVersion: 1,
    ...overrides,
  };
}

export function rejectedReservation(
  overrides: Partial<Extract<OrderingInventoryReservationAuthority, { kind: "rejected" }>> = {},
): OrderingInventoryReservationAuthority {
  return {
    kind: "rejected",
    reservationRequestId: "rsv_1",
    orderId: ORDER_ID,
    sellerAccountId: SELLER_ACCOUNT_ID,
    inventoryItemId: "inv_1",
    quantity: 1,
    reason: "insufficient-available-quantity",
    streamVersion: 1,
    ...overrides,
  };
}

export function holdAuthority(
  overrides: Partial<Extract<OrderingInventoryHoldAuthority, { kind: "hold" }>> = {},
): OrderingInventoryHoldAuthority {
  return {
    kind: "hold",
    holdId: "hld_1",
    sellerAccountId: SELLER_ACCOUNT_ID,
    inventoryItemId: "inv_1",
    quantity: 1,
    origin: "placed",
    sourceOrderId: ORDER_ID,
    sourceReservationRequestId: "rsv_1",
    status: "active",
    releaseReason: null,
    releasedRecordedAt: null,
    streamVersion: 1,
    ...overrides,
  };
}
