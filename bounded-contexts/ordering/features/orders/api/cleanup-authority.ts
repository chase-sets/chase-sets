import { readCompleteStream, type CompleteStreamReader } from "@chase-sets/event-core/complete-stream";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import type { OrderSourceType, OrderStatus } from "../domain/common";
import type { OrderStatusBeforeCancellation } from "../domain/domain";

/**
 * Read-only cleanup authority for an Ordering Order.
 *
 * The calculation answers one question -- "may this Order's inventory
 * commitment be treated as cleaned up?" -- from complete event-stream
 * histories only. It never reads a projection or readiness marker, never
 * calls a provider, and never appends an event: a lagging Ordering
 * projection returning 404 must never be mistaken for cleanup success, and
 * an Inventory Hold that exists without an Order-recorded confirmation --
 * Inventory can commit the Hold and the confirmation atomically after
 * Ordering has already cancelled -- must never be silently discharged.
 *
 * Option B reads complete Inventory reservation authority plus an
 * Inventory-owned reverse Hold lookup through {@link
 * OrderingInventoryCleanupAuthorityPort}. `cleanup-indeterminate` is an
 * Option-A-only state and is deliberately not representable here.
 */

/** Inclusive complete-read bound for the Order stream. */
export const ORDER_CLEANUP_AUTHORITY_ORDER_MAX_EVENTS = 500;
/** Largest Hold set an Order may legitimately own. */
export const ORDER_CLEANUP_AUTHORITY_MAX_HOLDS = 64;
/** Largest Order-id membership the evidence-window source adapter accepts. */
export const ORDER_CLEANUP_AUTHORITY_MAX_SOURCE_ORDER_IDS = 64;

export const ORDER_CLEANUP_AUTHORITY_SCHEMA_VERSION = "ordering-cleanup-authority/v1";

/**
 * Governed Hold/reservation release reasons for an Order cancellation. A
 * cancellation whose reason is `payment-deadline` releases with
 * `payment-deadline`; every other cancellation reason releases with
 * `order-cancelled`. Any other release reason on a real terminal is a
 * blocked cleanup, never a completion.
 */
export function governedOrderReleaseReason(cancellationReason: string): "payment-deadline" | "order-cancelled" {
  return cancellationReason === "payment-deadline" ? "payment-deadline" : "order-cancelled";
}

export type OrderingInventoryReservationReleaseAuthority = Readonly<{
  reservationRequestId: string;
  orderId: string;
  sellerAccountId: string;
  holdId: string;
  releasedAt: string;
  releaseReason: string;
}>;

/**
 * One complete Inventory reservation authority. `unavailable` covers every
 * structural refusal Inventory can report -- missing stream, more than two
 * events, malformed, mixed, repeated, or non-terminal -- and is always a
 * conflict for the caller, never a permission to complete.
 */
export type OrderingInventoryReservationAuthority =
  | Readonly<{
      kind: "confirmed";
      reservationRequestId: string;
      orderId: string;
      sellerAccountId: string;
      inventoryItemId: string;
      quantity: number;
      holdId: string;
      /** Optional v2, valid only after a v1 confirmation. */
      released: OrderingInventoryReservationReleaseAuthority | null;
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

export type OrderingInventoryHoldStatus = "active" | "released" | "consumed" | "expired";

export type OrderingInventoryHoldAuthority =
  | Readonly<{
      kind: "hold";
      holdId: string;
      sellerAccountId: string;
      inventoryItemId: string;
      quantity: number;
      /** `placed` for a direct Order Hold, `converted` for a checkout Hold converted to purpose `order`. */
      origin: "placed" | "converted";
      sourceOrderId: string;
      sourceReservationRequestId: string;
      status: OrderingInventoryHoldStatus;
      releaseReason: string | null;
      /** StoredEvent `recordedAt` of the release terminal, for causality against the Order cancellation. */
      releasedRecordedAt: string | null;
      streamVersion: number;
    }>
  | Readonly<{ kind: "unavailable"; holdId: string; detail: string }>;

/**
 * Reverse Hold lookup over Inventory's own source events, ordered by first
 * matching global position then stream id. `unavailable` covers an
 * over-bound (>64 distinct streams) or otherwise unusable result.
 */
export type OrderingInventoryHoldSourceLookup =
  | Readonly<{ kind: "lookup"; holdIds: readonly string[] }>
  | Readonly<{ kind: "unavailable"; detail: string }>;

/**
 * Inventory-owned authority Ordering consumes through a host capability.
 * Ordering never reaches into Inventory storage and never imports Inventory
 * code: the composition root binds Inventory's implementation to this
 * Ordering-owned interface, so a payload or identity drift is a typecheck
 * error rather than a runtime throw.
 */
export type OrderingInventoryCleanupAuthorityPort = Readonly<{
  readReservationAuthority: (
    input: Readonly<{ tenantId: string; reservationRequestId: string }>,
  ) => Promise<OrderingInventoryReservationAuthority>;
  readHoldAuthority: (input: Readonly<{ tenantId: string; holdId: string }>) => Promise<OrderingInventoryHoldAuthority>;
  lookupOrderHoldIds: (
    input: Readonly<{ tenantId: string; orderId: string }>,
  ) => Promise<OrderingInventoryHoldSourceLookup>;
}>;

/**
 * Required Ordering host capability. Both variants are explicit: a host
 * either mounts the Inventory authority or states that it does not. There is
 * no optional, defaulted, or `undefined` form -- an unsupplied nonoptional
 * port would otherwise read as "mounted" and hide a boot/runtime defect.
 */
export type OrderingInventoryCleanupAuthorityCapability =
  | Readonly<{ kind: "available"; port: OrderingInventoryCleanupAuthorityPort }>
  | Readonly<{ kind: "not-mounted" }>;

export function assertOrderingInventoryCleanupAuthorityCapability(
  value: OrderingInventoryCleanupAuthorityCapability | undefined,
): OrderingInventoryCleanupAuthorityCapability {
  if (value === undefined) {
    throw new Error(
      "Ordering requires an inventoryCleanupAuthority host capability; supply { kind: 'available', port } or { kind: 'not-mounted' }.",
    );
  }
  if (value.kind === "available") {
    if (
      typeof value.port?.readReservationAuthority !== "function" ||
      typeof value.port?.readHoldAuthority !== "function" ||
      typeof value.port?.lookupOrderHoldIds !== "function"
    ) {
      throw new Error("Ordering inventoryCleanupAuthority 'available' capability must supply a complete port.");
    }
    return value;
  }
  if (value.kind === "not-mounted") {
    return value;
  }
  throw new Error("Ordering inventoryCleanupAuthority capability must be 'available' or 'not-mounted'.");
}

/**
 * The five Option B states. `cleanup-indeterminate` belongs to Option A only
 * and is intentionally absent: under B an incomplete Inventory authority is a
 * conflict, not a business terminal.
 */
export type OrderCleanupAuthorityState =
  | "live-cancelable"
  | "captured-remedy-required"
  | "cancelled-release-pending"
  | "cancelled-cleanup-blocked"
  | "cleanup-complete";

export type OrderCleanupAuthorityHoldCounts = Readonly<{
  total: number;
  active: number;
  released: number;
  consumed: number;
  expired: number;
}>;

export type OrderCleanupAuthorityReport = Readonly<{
  schemaVersion: typeof ORDER_CLEANUP_AUTHORITY_SCHEMA_VERSION;
  state: OrderCleanupAuthorityState;
  retryable: boolean;
  orderStatus: OrderStatus;
  cancellationStatusBefore: OrderStatusBeforeCancellation | null;
  holdCounts: OrderCleanupAuthorityHoldCounts;
  orderStreamVersion: number;
  holdStreamVersions: readonly number[];
}>;

/**
 * `reason` is an internal diagnostic code. It is never rendered into an HTTP
 * response: 400/401/404/409 bodies carry a fixed localized message only, and
 * no response repeats the supplied Order id.
 */
export type OrderCleanupAuthorityObservation =
  | Readonly<{ outcome: "observed"; report: OrderCleanupAuthorityReport }>
  | Readonly<{ outcome: "invalid-request"; reason: string }>
  | Readonly<{ outcome: "not-found" }>
  | Readonly<{ outcome: "conflict"; reason: string }>;

export type OrderCleanupAuthoritySourceIdentity = Readonly<{
  sourceType: OrderSourceType;
  sourceReferenceId: string;
}>;

export type OrderCleanupAuthorityInput = Readonly<{
  orderId: string;
  windowOpenedAt: string;
  expectedBuyerAccountId: string;
  expectedSource: OrderCleanupAuthoritySourceIdentity | null;
  tenantId: string;
}>;

export type OrderCleanupAuthorityDeps = Readonly<{
  eventStore: CompleteStreamReader;
  inventory: OrderingInventoryCleanupAuthorityPort;
}>;

const RFC3339_UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

const ORDER_SOURCE_TYPES: readonly OrderSourceType[] = ["cart-checkout", "buy-now", "offer-acceptance"];

export function isStrictUtcInstant(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = RFC3339_UTC_INSTANT.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
  return day >= 1 && day <= daysInMonth[month - 1]!;
}

function conflict(reason: string): OrderCleanupAuthorityObservation {
  return { outcome: "conflict", reason };
}

function invalidRequest(reason: string): OrderCleanupAuthorityObservation {
  return { outcome: "invalid-request", reason };
}

type ReservationDeclaration = Readonly<{
  reservationRequestId: string;
  inventoryItemId: string;
  sellerAccountId: string;
  quantity: number;
  holdId: string | null;
}>;

type DeclarationOutcome = "pending" | "confirmed" | "rejected";
type OrderRecordedReservationOutcome = Readonly<{
  outcome: DeclarationOutcome;
  holdId: string | null;
  rejectionReason: string | null;
}>;

type OrderHistoryFold = Readonly<{
  orderId: string;
  buyerAccountId: string;
  sourceType: string;
  sourceReferenceId: string | null;
  declarations: readonly ReservationDeclaration[];
  orderRecordedOutcomes: ReadonlyMap<string, OrderRecordedReservationOutcome>;
  status: OrderStatus;
  statusBeforeCancellation: OrderStatusBeforeCancellation | null;
  cancellationReason: string | null;
  cancelledRecordedAt: string | null;
  captured: boolean;
  cleanupEligible: boolean;
  streamVersion: number;
}>;

type OrderHistoryResult =
  | Readonly<{ kind: "fold"; fold: OrderHistoryFold }>
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "conflict"; reason: string }>;

function readPayload(event: StoredEvent): Readonly<Record<string, unknown>> {
  const payload = event.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

function readString(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readOptionalString(payload: Readonly<Record<string, unknown>>, key: string): string | null | undefined {
  const value = payload[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readPositiveInteger(payload: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function recordedAtMillis(event: StoredEvent): number {
  return Date.parse(String(event.recordedAt));
}

function isCleanupEligibleStatus(status: OrderStatusBeforeCancellation | null): boolean {
  return status === "pending-reservation" || status === "pending-payment";
}

const CANCELLATION_RESERVATION_KEYS = [
  "holdId",
  "inventoryItemId",
  "quantity",
  "rejectionReason",
  "releasedAt",
  "reservationRequestId",
  "sellerAccountId",
  "status",
] as const;

function cancellationReservationSnapshotMatches(
  value: unknown,
  declarations: readonly ReservationDeclaration[],
  outcomes: ReadonlyMap<string, OrderRecordedReservationOutcome>,
): boolean {
  if (!Array.isArray(value) || value.length !== declarations.length) {
    return false;
  }

  return declarations.every((declaration, index) => {
    const raw = value[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return false;
    }
    const snapshot = raw as Readonly<Record<string, unknown>>;
    if (Object.keys(snapshot).sort().join("|") !== [...CANCELLATION_RESERVATION_KEYS].sort().join("|")) {
      return false;
    }
    const outcome = outcomes.get(declaration.reservationRequestId);
    if (!outcome) {
      return false;
    }
    const expectedHoldId = outcome.outcome === "confirmed" ? outcome.holdId : declaration.holdId;

    return (
      snapshot["reservationRequestId"] === declaration.reservationRequestId &&
      snapshot["inventoryItemId"] === declaration.inventoryItemId &&
      snapshot["sellerAccountId"] === declaration.sellerAccountId &&
      snapshot["quantity"] === declaration.quantity &&
      snapshot["holdId"] === expectedHoldId &&
      snapshot["status"] === outcome.outcome &&
      snapshot["rejectionReason"] === outcome.rejectionReason &&
      snapshot["releasedAt"] === null
    );
  });
}

/**
 * Rehydrates the Order's complete literal history.
 *
 * Every rule the body's Order-history table states is enforced here: exactly
 * one creation at version 1, an at-most-once additive line-amount fact
 * immediately after creation, unique declarations, at most one Order-recorded
 * terminal per declaration, at most one pending-payment/capture/cancellation,
 * and a release that references a confirmed request and Hold after
 * cancellation. Anything else is a conflict; the fold never accepts a prefix.
 */
function foldOrderHistory(events: readonly StoredEvent[], input: OrderCleanupAuthorityInput): OrderHistoryResult {
  if (events.length === 0) {
    return { kind: "not-found" };
  }

  // The stream-keyed read carries no tenant filter, so the request tenant is
  // verified here. A foreign tenant is indistinguishable from a missing Order.
  if (events.some((event) => String(event.tenantId) !== input.tenantId)) {
    return { kind: "not-found" };
  }

  const creation = events[0]!;
  if (creation.eventType !== "ordering.order.created" || creation.streamVersion !== 1) {
    return { kind: "conflict", reason: "order-creation-missing" };
  }

  const creationPayload = readPayload(creation);
  const creationOrderId = readString(creationPayload, "orderId");
  if (creationOrderId !== input.orderId) {
    return { kind: "conflict", reason: "order-identity-mismatch" };
  }

  const buyerAccountId = readString(creationPayload, "buyerAccountId");
  if (buyerAccountId === null) {
    return { kind: "conflict", reason: "order-buyer-missing" };
  }
  // A foreign buyer and a missing Order are deliberately indistinguishable.
  if (buyerAccountId !== input.expectedBuyerAccountId) {
    return { kind: "not-found" };
  }

  const sourceType = readString(creationPayload, "sourceType");
  if (sourceType === null) {
    return { kind: "conflict", reason: "order-source-type-missing" };
  }
  const sourceReferenceId = readOptionalString(creationPayload, "sourceReferenceId") ?? null;
  if (input.expectedSource !== null) {
    if (
      sourceType !== input.expectedSource.sourceType ||
      sourceReferenceId !== input.expectedSource.sourceReferenceId
    ) {
      return { kind: "conflict", reason: "order-source-identity-mismatch" };
    }
  }

  const windowOpenedAtMillis = Date.parse(input.windowOpenedAt);
  if (!(recordedAtMillis(creation) >= windowOpenedAtMillis)) {
    return { kind: "conflict", reason: "order-created-before-window" };
  }

  const rawRequests = creationPayload["reservationRequests"];
  if (!Array.isArray(rawRequests) || rawRequests.length === 0) {
    return { kind: "conflict", reason: "order-reservation-requests-missing" };
  }

  const declarations: ReservationDeclaration[] = [];
  const declarationIds = new Set<string>();
  for (const raw of rawRequests) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { kind: "conflict", reason: "order-reservation-request-malformed" };
    }
    const request = raw as Readonly<Record<string, unknown>>;
    const reservationRequestId = readString(request, "reservationRequestId");
    const inventoryItemId = readString(request, "inventoryItemId");
    const sellerAccountId = readString(request, "sellerAccountId");
    const quantity = readPositiveInteger(request, "quantity");
    const rawHoldId = request["holdId"];
    const holdId = rawHoldId === undefined || rawHoldId === null ? null : readString(request, "holdId");
    if (reservationRequestId === null || inventoryItemId === null || sellerAccountId === null || quantity === null) {
      return { kind: "conflict", reason: "order-reservation-request-malformed" };
    }
    if (rawHoldId !== undefined && rawHoldId !== null && holdId === null) {
      return { kind: "conflict", reason: "order-reservation-request-malformed" };
    }
    if (declarationIds.has(reservationRequestId)) {
      return { kind: "conflict", reason: "order-reservation-request-duplicate" };
    }
    declarationIds.add(reservationRequestId);
    declarations.push({ reservationRequestId, inventoryItemId, sellerAccountId, quantity, holdId });
  }

  if (declarations.length > ORDER_CLEANUP_AUTHORITY_MAX_HOLDS) {
    return { kind: "conflict", reason: "order-reservation-requests-over-bound" };
  }

  const outcomes = new Map<string, OrderRecordedReservationOutcome>();
  for (const declaration of declarations) {
    outcomes.set(declaration.reservationRequestId, {
      outcome: "pending",
      holdId: declaration.holdId,
      rejectionReason: null,
    });
  }

  const rawCreationLines = creationPayload["lines"];
  if (!Array.isArray(rawCreationLines) || rawCreationLines.length === 0) {
    return { kind: "conflict", reason: "order-lines-malformed" };
  }
  const creationLineAmounts = new Map<string, string>();
  for (const rawLine of rawCreationLines) {
    if (!rawLine || typeof rawLine !== "object" || Array.isArray(rawLine)) {
      return { kind: "conflict", reason: "order-lines-malformed" };
    }
    const line = rawLine as Readonly<Record<string, unknown>>;
    const lineId = readString(line, "lineId");
    const lineTotalAmount = readString(line, "lineTotalAmount");
    if (lineId === null || lineTotalAmount === null || creationLineAmounts.has(lineId)) {
      return { kind: "conflict", reason: "order-lines-malformed" };
    }
    creationLineAmounts.set(lineId, lineTotalAmount);
  }

  const confirmedHoldIds = new Set<string>();
  const releasedRequestIds = new Set<string>();
  let status: OrderStatus = "pending-reservation";
  let statusBeforeCancellation: OrderStatusBeforeCancellation | null = null;
  let cancellationReason: string | null = null;
  let cancelledRecordedAt: string | null = null;
  let lineAmountsSeen = false;
  let reservationOutcomeSeen = false;
  let pendingPaymentSeen = false;
  let capturedSeen = false;
  let cancelledSeen = false;

  for (let index = 1; index < events.length; index += 1) {
    const event = events[index]!;
    const payload = readPayload(event);
    const payloadOrderId = readString(payload, "orderId");
    if (payloadOrderId !== input.orderId) {
      return { kind: "conflict", reason: "order-event-identity-mismatch" };
    }

    switch (event.eventType) {
      case "ordering.order.created":
        return { kind: "conflict", reason: "order-creation-repeated" };

      case "ordering.order.line-item-amounts-published": {
        if (lineAmountsSeen || index !== 1 || reservationOutcomeSeen) {
          return { kind: "conflict", reason: "order-line-amounts-out-of-order" };
        }
        const lineItems = payload["lineItems"];
        if (!Array.isArray(lineItems)) {
          return { kind: "conflict", reason: "order-line-amounts-malformed" };
        }
        if (lineItems.length !== creationLineAmounts.size) {
          return { kind: "conflict", reason: "order-line-amounts-mismatch" };
        }
        const publishedLineIds = new Set<string>();
        for (const entry of lineItems) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return { kind: "conflict", reason: "order-line-amounts-malformed" };
          }
          const lineItem = entry as Readonly<Record<string, unknown>>;
          const lineId = readString(lineItem, "lineId");
          const amount = readString(lineItem, "amount");
          if (
            lineId === null ||
            amount === null ||
            publishedLineIds.has(lineId) ||
            creationLineAmounts.get(lineId) !== amount
          ) {
            return { kind: "conflict", reason: "order-line-amounts-mismatch" };
          }
          publishedLineIds.add(lineId);
        }
        lineAmountsSeen = true;
        break;
      }

      case "ordering.order.reservation-confirmed": {
        if (cancelledSeen) {
          return { kind: "conflict", reason: "order-reservation-outcome-after-cancellation" };
        }
        const reservationRequestId = readString(payload, "reservationRequestId");
        const holdId = readString(payload, "holdId");
        if (reservationRequestId === null || holdId === null) {
          return { kind: "conflict", reason: "order-reservation-confirmation-malformed" };
        }
        const declaration = declarations.find((entry) => entry.reservationRequestId === reservationRequestId);
        const outcome = outcomes.get(reservationRequestId);
        if (!declaration || !outcome) {
          return { kind: "conflict", reason: "order-reservation-confirmation-unknown-request" };
        }
        if (outcome.outcome !== "pending") {
          return { kind: "conflict", reason: "order-reservation-terminal-repeated" };
        }
        if (
          readString(payload, "inventoryItemId") !== declaration.inventoryItemId ||
          readString(payload, "sellerAccountId") !== declaration.sellerAccountId ||
          readPositiveInteger(payload, "quantity") !== declaration.quantity
        ) {
          return { kind: "conflict", reason: "order-reservation-confirmation-mismatch" };
        }
        if (confirmedHoldIds.has(holdId)) {
          return { kind: "conflict", reason: "order-reservation-hold-reused" };
        }
        confirmedHoldIds.add(holdId);
        outcomes.set(reservationRequestId, { outcome: "confirmed", holdId, rejectionReason: null });
        reservationOutcomeSeen = true;
        break;
      }

      case "ordering.order.reservation-rejected": {
        if (cancelledSeen) {
          return { kind: "conflict", reason: "order-reservation-outcome-after-cancellation" };
        }
        const reservationRequestId = readString(payload, "reservationRequestId");
        const rejectionReason = readString(payload, "reason");
        if (reservationRequestId === null || rejectionReason === null) {
          return { kind: "conflict", reason: "order-reservation-rejection-malformed" };
        }
        const declaration = declarations.find((entry) => entry.reservationRequestId === reservationRequestId);
        const outcome = outcomes.get(reservationRequestId);
        if (!declaration || !outcome) {
          return { kind: "conflict", reason: "order-reservation-rejection-unknown-request" };
        }
        if (outcome.outcome !== "pending") {
          return { kind: "conflict", reason: "order-reservation-terminal-repeated" };
        }
        outcomes.set(reservationRequestId, {
          outcome: "rejected",
          holdId: declaration.holdId,
          rejectionReason,
        });
        reservationOutcomeSeen = true;
        break;
      }

      case "ordering.order.pending-payment-recorded": {
        if (pendingPaymentSeen || status !== "pending-reservation") {
          return { kind: "conflict", reason: "order-pending-payment-out-of-order" };
        }
        const stillPending = [...outcomes.values()].some((entry) => entry.outcome === "pending");
        if (stillPending) {
          return { kind: "conflict", reason: "order-pending-payment-before-reservation-outcomes" };
        }
        pendingPaymentSeen = true;
        status = "pending-payment";
        break;
      }

      case "ordering.order.ready-for-fulfillment-recorded": {
        if (capturedSeen || status !== "pending-payment") {
          return { kind: "conflict", reason: "order-capture-out-of-order" };
        }
        capturedSeen = true;
        status = "ready-for-fulfillment";
        break;
      }

      case "ordering.order.cancelled": {
        if (cancelledSeen) {
          return { kind: "conflict", reason: "order-cancellation-repeated" };
        }
        if (status === "cancelled") {
          return { kind: "conflict", reason: "order-cancellation-out-of-order" };
        }
        const reason = readString(payload, "reason");
        if (reason === null) {
          return { kind: "conflict", reason: "order-cancellation-malformed" };
        }
        if (!cancellationReservationSnapshotMatches(payload["reservationRequests"], declarations, outcomes)) {
          return { kind: "conflict", reason: "order-cancellation-reservations-mismatch" };
        }
        // The shipped public decoder allows both fields to be absent on events
        // written before they existed. Derive from creation and the
        // immediately pre-cancellation fold; any present value must agree.
        const storedBuyerAccountId = payload["buyerAccountId"];
        if (storedBuyerAccountId !== undefined && storedBuyerAccountId !== buyerAccountId) {
          return { kind: "conflict", reason: "order-cancellation-buyer-mismatch" };
        }
        const derivedStatusBefore = status as OrderStatusBeforeCancellation;
        const storedStatusBefore = payload["statusBeforeCancellation"];
        if (storedStatusBefore !== undefined && storedStatusBefore !== derivedStatusBefore) {
          return { kind: "conflict", reason: "order-cancellation-status-mismatch" };
        }
        cancelledSeen = true;
        statusBeforeCancellation = derivedStatusBefore;
        cancellationReason = reason;
        cancelledRecordedAt = String(event.recordedAt);
        status = "cancelled";
        break;
      }

      case "ordering.order.reservation-released": {
        if (!cancelledSeen) {
          return { kind: "conflict", reason: "order-release-before-cancellation" };
        }
        const reservationRequestId = readString(payload, "reservationRequestId");
        const holdId = readString(payload, "holdId");
        if (reservationRequestId === null || holdId === null) {
          return { kind: "conflict", reason: "order-release-malformed" };
        }
        const outcome = outcomes.get(reservationRequestId);
        if (!outcome || outcome.outcome !== "confirmed" || outcome.holdId !== holdId) {
          return { kind: "conflict", reason: "order-release-unconfirmed-request" };
        }
        if (releasedRequestIds.has(reservationRequestId)) {
          return { kind: "conflict", reason: "order-release-repeated" };
        }
        releasedRequestIds.add(reservationRequestId);
        break;
      }

      default:
        return { kind: "conflict", reason: "order-unexpected-event" };
    }
  }

  return {
    kind: "fold",
    fold: {
      orderId: input.orderId,
      buyerAccountId,
      sourceType,
      sourceReferenceId,
      declarations,
      orderRecordedOutcomes: outcomes,
      status,
      statusBeforeCancellation,
      cancellationReason,
      cancelledRecordedAt,
      captured: capturedSeen,
      cleanupEligible: cancelledSeen && isCleanupEligibleStatus(statusBeforeCancellation),
      streamVersion: events[events.length - 1]!.streamVersion,
    },
  };
}

function report(
  state: OrderCleanupAuthorityState,
  fold: OrderHistoryFold,
  holds: readonly OrderingInventoryHoldAuthority[],
): OrderCleanupAuthorityReport {
  const resolved = holds.filter(
    (hold): hold is Extract<OrderingInventoryHoldAuthority, { kind: "hold" }> => hold.kind === "hold",
  );
  const counts: OrderCleanupAuthorityHoldCounts = {
    total: resolved.length,
    active: resolved.filter((hold) => hold.status === "active").length,
    released: resolved.filter((hold) => hold.status === "released").length,
    consumed: resolved.filter((hold) => hold.status === "consumed").length,
    expired: resolved.filter((hold) => hold.status === "expired").length,
  };

  return {
    schemaVersion: ORDER_CLEANUP_AUTHORITY_SCHEMA_VERSION,
    state,
    retryable: state === "live-cancelable" || state === "cancelled-release-pending",
    orderStatus: fold.status,
    cancellationStatusBefore: fold.statusBeforeCancellation,
    holdCounts: counts,
    orderStreamVersion: fold.streamVersion,
    holdStreamVersions: resolved.map((hold) => hold.streamVersion),
  };
}

/**
 * The single Ordering cleanup-authority fold. Both adapters call this; a
 * second fold is forbidden.
 */
export async function observeOrderCleanupAuthority(
  deps: OrderCleanupAuthorityDeps,
  input: OrderCleanupAuthorityInput,
): Promise<OrderCleanupAuthorityObservation> {
  if (typeof input.orderId !== "string" || input.orderId.trim().length === 0) {
    return invalidRequest("order-id-required");
  }
  if (!isStrictUtcInstant(input.windowOpenedAt)) {
    return invalidRequest("window-opened-at-invalid");
  }
  if (typeof input.expectedBuyerAccountId !== "string" || input.expectedBuyerAccountId.trim().length === 0) {
    return invalidRequest("expected-buyer-account-required");
  }
  if (typeof input.tenantId !== "string" || input.tenantId.trim().length === 0) {
    return invalidRequest("tenant-required");
  }
  if (input.expectedSource !== null) {
    if (
      !ORDER_SOURCE_TYPES.includes(input.expectedSource.sourceType) ||
      typeof input.expectedSource.sourceReferenceId !== "string" ||
      input.expectedSource.sourceReferenceId.trim().length === 0
    ) {
      return invalidRequest("expected-source-invalid");
    }
  }

  let orderEvents: readonly StoredEvent[];
  try {
    orderEvents = await readCompleteStream(deps.eventStore, {
      streamId: `ordering.order-${input.orderId}`,
      maxEvents: ORDER_CLEANUP_AUTHORITY_ORDER_MAX_EVENTS,
    });
  } catch {
    return conflict("order-stream-unreadable");
  }

  const history = foldOrderHistory(orderEvents, input);
  if (history.kind === "not-found") {
    return { outcome: "not-found" };
  }
  if (history.kind === "conflict") {
    return conflict(history.reason);
  }

  const fold = history.fold;

  // Captured histories can never be cleaned up, and a live Order has nothing
  // to discharge yet. Neither observation reads or claims Hold disposition,
  // so no Inventory authority is consulted and no Hold count is asserted.
  if (fold.captured) {
    return { outcome: "observed", report: report("captured-remedy-required", fold, []) };
  }
  if (!fold.cleanupEligible) {
    if (fold.status === "cancelled") {
      // Cancelled from a status the cleanup contract does not cover.
      return conflict("order-cancellation-not-cleanup-eligible");
    }
    return { outcome: "observed", report: report("live-cancelable", fold, []) };
  }

  const cancellationReason = fold.cancellationReason;
  const cancelledRecordedAt = fold.cancelledRecordedAt;
  if (cancellationReason === null || cancelledRecordedAt === null) {
    return conflict("order-cancellation-incomplete");
  }
  const expectedReleaseReason = governedOrderReleaseReason(cancellationReason);
  const cancelledRecordedAtMillis = Date.parse(cancelledRecordedAt);

  // Rule 1-3: complete Inventory reservation authority for every declaration,
  // in Order declaration order. Missing authority is a conflict, never a
  // permission to complete.
  const confirmedHoldIdsByDeclaration: (string | null)[] = [];
  for (const declaration of fold.declarations) {
    let authority: OrderingInventoryReservationAuthority;
    try {
      authority = await deps.inventory.readReservationAuthority({
        tenantId: input.tenantId,
        reservationRequestId: declaration.reservationRequestId,
      });
    } catch {
      return conflict("inventory-reservation-authority-unreadable");
    }

    if (authority.kind === "unavailable") {
      return conflict("inventory-reservation-authority-incomplete");
    }
    if (
      authority.reservationRequestId !== declaration.reservationRequestId ||
      authority.orderId !== fold.orderId ||
      authority.sellerAccountId !== declaration.sellerAccountId ||
      authority.inventoryItemId !== declaration.inventoryItemId ||
      authority.quantity !== declaration.quantity
    ) {
      return conflict("inventory-reservation-authority-mismatch");
    }

    const orderRecorded = fold.orderRecordedOutcomes.get(declaration.reservationRequestId);
    if (orderRecorded && orderRecorded.outcome !== "pending" && orderRecorded.outcome !== authority.kind) {
      return conflict("inventory-reservation-authority-disagrees-with-order");
    }

    if (authority.kind === "rejected") {
      // A rejection proves no Hold was ever created for this declaration.
      confirmedHoldIdsByDeclaration.push(null);
      continue;
    }

    if (orderRecorded?.outcome === "confirmed" && orderRecorded.holdId !== authority.holdId) {
      return conflict("inventory-reservation-authority-disagrees-with-order");
    }

    const released = authority.released;
    if (released !== null) {
      if (
        released.reservationRequestId !== authority.reservationRequestId ||
        released.orderId !== authority.orderId ||
        released.sellerAccountId !== authority.sellerAccountId ||
        released.holdId !== authority.holdId
      ) {
        return conflict("inventory-reservation-release-mismatch");
      }
      // Explicit Option B rule 3: a reservation release carrying a reason
      // outside the governed cancellation mapping -- a hold-collision release,
      // for example -- is a mismatch, not a discharge.
      if (released.releaseReason !== expectedReleaseReason) {
        return conflict("inventory-reservation-release-reason-mismatch");
      }
    }

    confirmedHoldIdsByDeclaration.push(authority.holdId);
  }

  const expectedHoldIds = confirmedHoldIdsByDeclaration.filter((holdId): holdId is string => holdId !== null);
  if (new Set(expectedHoldIds).size !== expectedHoldIds.length) {
    return conflict("inventory-reservation-hold-reused");
  }
  if (expectedHoldIds.length > ORDER_CLEANUP_AUTHORITY_MAX_HOLDS) {
    return conflict("inventory-hold-set-over-bound");
  }

  // Rule 4-5: the Inventory-owned reverse Hold lookup must equal the unique
  // confirmed Hold set exactly -- no extra, missing, duplicate, or reused id.
  let lookup: OrderingInventoryHoldSourceLookup;
  try {
    lookup = await deps.inventory.lookupOrderHoldIds({ tenantId: input.tenantId, orderId: fold.orderId });
  } catch {
    return conflict("inventory-hold-lookup-unreadable");
  }
  if (lookup.kind === "unavailable") {
    return conflict("inventory-hold-lookup-incomplete");
  }
  const lookupHoldIds = lookup.holdIds;
  if (new Set(lookupHoldIds).size !== lookupHoldIds.length) {
    return conflict("inventory-hold-lookup-duplicate");
  }
  if (lookupHoldIds.length !== expectedHoldIds.length) {
    return conflict("inventory-hold-lookup-set-mismatch");
  }
  const expectedHoldIdSet = new Set(expectedHoldIds);
  for (const holdId of lookupHoldIds) {
    if (!expectedHoldIdSet.has(holdId)) {
      return conflict("inventory-hold-lookup-set-mismatch");
    }
  }

  // Hold histories, read in Order declaration order.
  const holds: OrderingInventoryHoldAuthority[] = [];
  let anyBlocked = false;
  let anyActive = false;

  for (const [index, declaration] of fold.declarations.entries()) {
    const holdId = confirmedHoldIdsByDeclaration[index];
    if (holdId === null || holdId === undefined) {
      continue;
    }

    let hold: OrderingInventoryHoldAuthority;
    try {
      hold = await deps.inventory.readHoldAuthority({ tenantId: input.tenantId, holdId });
    } catch {
      return conflict("inventory-hold-authority-unreadable");
    }
    if (hold.kind === "unavailable") {
      return conflict("inventory-hold-authority-incomplete");
    }
    if (
      hold.holdId !== holdId ||
      hold.sourceOrderId !== fold.orderId ||
      hold.sourceReservationRequestId !== declaration.reservationRequestId ||
      hold.sellerAccountId !== declaration.sellerAccountId ||
      hold.inventoryItemId !== declaration.inventoryItemId ||
      hold.quantity !== declaration.quantity
    ) {
      return conflict("inventory-hold-identity-mismatch");
    }

    holds.push(hold);

    switch (hold.status) {
      case "active":
        anyActive = true;
        break;
      case "released": {
        // A real release terminal with the wrong reason or wrong causality is
        // a blocked cleanup, not a structural conflict and never a discharge.
        if (hold.releaseReason !== expectedReleaseReason) {
          anyBlocked = true;
          break;
        }
        if (hold.releasedRecordedAt === null) {
          return conflict("inventory-hold-release-timing-missing");
        }
        if (!(Date.parse(hold.releasedRecordedAt) >= cancelledRecordedAtMillis)) {
          anyBlocked = true;
        }
        break;
      }
      case "consumed":
      case "expired":
        anyBlocked = true;
        break;
      default:
        return conflict("inventory-hold-status-unknown");
    }
  }

  if (anyBlocked) {
    return { outcome: "observed", report: report("cancelled-cleanup-blocked", fold, holds) };
  }
  if (anyActive) {
    return { outcome: "observed", report: report("cancelled-release-pending", fold, holds) };
  }
  return { outcome: "observed", report: report("cleanup-complete", fold, holds) };
}

export type BuyerOrderCleanupAuthorityInput = Readonly<{
  orderId: string;
  windowOpenedAt: string;
  buyerAccountId: string;
  tenantId: string;
}>;

/**
 * Buyer adapter (N8). The buyer account always comes from the authenticated
 * principal; a missing Order and a foreign buyer are indistinguishable.
 */
export function observeBuyerOrderCleanupAuthority(
  deps: OrderCleanupAuthorityDeps,
  input: BuyerOrderCleanupAuthorityInput,
): Promise<OrderCleanupAuthorityObservation> {
  return observeOrderCleanupAuthority(deps, {
    orderId: input.orderId,
    windowOpenedAt: input.windowOpenedAt,
    expectedBuyerAccountId: input.buyerAccountId,
    expectedSource: null,
    tenantId: input.tenantId,
  });
}

export type EvidenceWindowSourceCleanupAuthorityInput = Readonly<{
  source: OrderCleanupAuthoritySourceIdentity;
  buyerAccountId: string;
  windowOpenedAt: string;
  /** 1..64 unique Order ids, in the durable source claim's own order. */
  orderIds: readonly string[];
  tenantId: string;
}>;

export type EvidenceWindowSourceCleanupAuthorityResult =
  | Readonly<{
      outcome: "observed";
      observations: readonly Readonly<{ orderId: string; observation: OrderCleanupAuthorityObservation }>[];
    }>
  | Readonly<{ outcome: "invalid-request"; reason: string }>;

/**
 * Evidence-window source adapter. The source identity, buyer, and Order-id
 * membership all arrive from the caller's durable source claim; none is
 * inferred from a projection. Empty membership is rejected rather than
 * reported as success: the durable closed-creator predicate for
 * `not-created` is owned by the evidence-window caller, not by this fold.
 */
export async function observeEvidenceWindowSourceCleanupAuthority(
  deps: OrderCleanupAuthorityDeps,
  input: EvidenceWindowSourceCleanupAuthorityInput,
): Promise<EvidenceWindowSourceCleanupAuthorityResult> {
  if (!Array.isArray(input.orderIds) || input.orderIds.length === 0) {
    return { outcome: "invalid-request", reason: "source-membership-empty" };
  }
  if (input.orderIds.length > ORDER_CLEANUP_AUTHORITY_MAX_SOURCE_ORDER_IDS) {
    return { outcome: "invalid-request", reason: "source-membership-over-bound" };
  }
  if (input.orderIds.some((orderId) => typeof orderId !== "string" || orderId.trim().length === 0)) {
    return { outcome: "invalid-request", reason: "source-membership-malformed" };
  }
  if (new Set(input.orderIds).size !== input.orderIds.length) {
    return { outcome: "invalid-request", reason: "source-membership-duplicate" };
  }
  if (
    !ORDER_SOURCE_TYPES.includes(input.source?.sourceType) ||
    typeof input.source?.sourceReferenceId !== "string" ||
    input.source.sourceReferenceId.trim().length === 0
  ) {
    return { outcome: "invalid-request", reason: "source-identity-invalid" };
  }
  if (typeof input.buyerAccountId !== "string" || input.buyerAccountId.trim().length === 0) {
    return { outcome: "invalid-request", reason: "source-buyer-required" };
  }

  const observations: Readonly<{ orderId: string; observation: OrderCleanupAuthorityObservation }>[] = [];
  // Serial by contract: the membership order is the source claim's order and
  // each Order is observed against the same window instant.
  for (const orderId of input.orderIds) {
    const observation = await observeOrderCleanupAuthority(deps, {
      orderId,
      windowOpenedAt: input.windowOpenedAt,
      expectedBuyerAccountId: input.buyerAccountId,
      expectedSource: input.source,
      tenantId: input.tenantId,
    });
    observations.push({ orderId, observation });
  }

  return { outcome: "observed", observations };
}
