import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import {
  inventoryHoldPurposes,
  inventoryHoldReleaseReasons,
  type InventoryHoldPlacedPayload,
  type InventoryHoldConvertedPayload,
  type InventoryHoldExpiredPayload,
  type InventoryHoldExtendedPayload,
  type InventoryHoldPurpose,
  type InventoryHoldReleaseReason,
  type InventoryHoldReleasedPayload,
  type InventoryHoldSourceRef,
} from "@chase-sets/event-core/public-event-payloads";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  ensurePositiveInteger,
  normalizeLabel,
  normalizeOptionalText,
  type InventoryHoldId,
  type InventoryHoldStatus,
} from "../../../support/runtime-support/common";

export type InventoryHoldState = Readonly<{
  id: InventoryHoldId | null;
  accountId: AccountId | null;
  itemId: string | null;
  quantity: number;
  reason: string;
  notes: string | null;
  purpose: InventoryHoldPurpose | null;
  sourceRef: InventoryHoldSourceRef;
  expiresAt: string | null;
  status: InventoryHoldStatus;
  releasedAt: string | null;
  releaseReason: InventoryHoldReleaseReason | null;
  consumedAt: string | null;
  expiredAt: string | null;
  extensionCount: number;
}>;

export const initialInventoryHoldState: InventoryHoldState = {
  id: null,
  accountId: null,
  itemId: null,
  quantity: 0,
  reason: "",
  notes: null,
  purpose: null,
  sourceRef: null,
  expiresAt: null,
  status: "active",
  releasedAt: null,
  releaseReason: null,
  consumedAt: null,
  expiredAt: null,
  extensionCount: 0,
};

export type PlaceInventoryHoldCommand = Readonly<{
  type: "PlaceInventoryHold";
  holdId: InventoryHoldId;
  accountId: AccountId;
  itemId: string;
  quantity: number;
  reason: string;
  notes?: string | null;
  purpose: InventoryHoldPurpose;
  sourceRef: InventoryHoldSourceRef;
  expiresAt?: string | null;
}>;

export type ReleaseInventoryHoldCommand = Readonly<{
  type: "ReleaseInventoryHold";
  releasedAt: string;
  releaseReason: InventoryHoldReleaseReason;
}>;

export type ConsumeInventoryHoldCommand = Readonly<{
  type: "ConsumeInventoryHold";
  consumedAt: string;
  consumptionReason: string;
}>;

export type ConvertInventoryHoldCommand = Readonly<{
  type: "ConvertInventoryHold";
  convertedAt: string;
  orderId: string;
  reservationRequestId: string;
}>;

export type ExpireInventoryHoldCommand = Readonly<{
  type: "ExpireInventoryHold";
  expiredAt: string;
}>;

export type ExtendInventoryHoldCommand = Readonly<{
  type: "ExtendInventoryHold";
  extendedAt: string;
  expiresAt: string;
  maxExtensionCount: number;
}>;

export type InventoryHoldCommand =
  | PlaceInventoryHoldCommand
  | ReleaseInventoryHoldCommand
  | ConsumeInventoryHoldCommand
  | ConvertInventoryHoldCommand
  | ExpireInventoryHoldCommand
  | ExtendInventoryHoldCommand;

export type InventoryHeldEvent = DomainEvent<
  "inventory.hold.placed",
  InventoryHoldPlacedPayload & Readonly<{ holdId: InventoryHoldId; accountId: AccountId }>
>;

export type InventoryReleasedEvent = DomainEvent<
  "inventory.hold.released",
  InventoryHoldReleasedPayload & Readonly<{ holdId: InventoryHoldId }>
>;

export type InventoryConsumedEvent = DomainEvent<
  "inventory.hold.consumed",
  Readonly<{
    holdId: InventoryHoldId;
    consumedAt: string;
    consumptionReason: string;
    sourceRef: InventoryHoldSourceRef;
  }>
>;

export type InventoryHoldConvertedEvent = DomainEvent<
  "inventory.hold.converted",
  InventoryHoldConvertedPayload & Readonly<{ holdId: InventoryHoldId }>
>;

export type InventoryHoldExpiredEvent = DomainEvent<
  "inventory.hold.expired",
  InventoryHoldExpiredPayload & Readonly<{ holdId: InventoryHoldId }>
>;

export type InventoryHoldExtendedEvent = DomainEvent<
  "inventory.hold.extended",
  InventoryHoldExtendedPayload & Readonly<{ holdId: InventoryHoldId }>
>;

export type InventoryHoldEvent =
  | InventoryHeldEvent
  | InventoryReleasedEvent
  | InventoryConsumedEvent
  | InventoryHoldConvertedEvent
  | InventoryHoldExpiredEvent
  | InventoryHoldExtendedEvent;

export const decideInventoryHold: AggregateDecider<InventoryHoldState, InventoryHoldCommand, InventoryHoldEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "PlaceInventoryHold":
      assert(state.id === null, "Inventory hold has already been created.");
      ensurePositiveInteger(command.quantity, "Inventory holds require a positive quantity.");
      validateHoldPurpose(command.purpose);
      validateHoldSourceRef(command.purpose, command.sourceRef);
      validateHoldExpiry(command.purpose, command.expiresAt ?? null);
      return [
        {
          type: "inventory.hold.placed",
          data: {
            holdId: command.holdId,
            accountId: command.accountId,
            itemId: normalizeLabel(command.itemId),
            quantity: command.quantity,
            reason: normalizeLabel(command.reason),
            notes: normalizeOptionalText(command.notes),
            purpose: command.purpose,
            sourceRef: normalizeHoldSourceRef(command.sourceRef),
            expiresAt: command.expiresAt ? normalizeLabel(command.expiresAt) : null,
          },
        },
      ];
    case "ReleaseInventoryHold":
      requireCreatedInventoryHold(state);
      assert(state.status === "active", "Only active holds can be released.");
      validateReleaseReason(command.releaseReason);
      return [
        {
          type: "inventory.hold.released",
          data: {
            holdId: state.id!,
            releasedAt: command.releasedAt,
            releaseReason: command.releaseReason,
          },
        },
      ];
    case "ConsumeInventoryHold":
      requireCreatedInventoryHold(state);
      assert(state.status === "active", "Only active holds can be consumed.");
      assert(state.sourceRef !== null, "Consumed inventory holds require order provenance.");
      return [
        {
          type: "inventory.hold.consumed",
          data: {
            holdId: state.id!,
            consumedAt: command.consumedAt,
            consumptionReason: normalizeLabel(command.consumptionReason),
            sourceRef: state.sourceRef,
          },
        },
      ];
    case "ConvertInventoryHold":
      requireCreatedInventoryHold(state);
      assert(state.status === "active", "Only active holds can be converted.");
      assert(state.purpose === "checkout", "Only checkout inventory holds can be converted to orders.");
      return [
        {
          type: "inventory.hold.converted",
          data: {
            holdId: state.id!,
            convertedAt: normalizeLabel(command.convertedAt),
            purpose: "order",
            sourceRef: normalizeOrderSourceRef({
              orderId: command.orderId,
              reservationRequestId: command.reservationRequestId,
            }),
            expiresAt: null,
          },
        },
      ];
    case "ExpireInventoryHold":
      requireCreatedInventoryHold(state);
      assert(state.status === "active", "Only active holds can expire.");
      assert(state.purpose === "checkout", "Only checkout inventory holds can expire automatically.");
      assert(state.expiresAt !== null, "Checkout inventory holds require an expiry before they can expire.");
      assert(
        Date.parse(command.expiredAt) >= Date.parse(state.expiresAt),
        "Checkout inventory holds cannot expire before their expiry time.",
      );
      return [
        {
          type: "inventory.hold.expired",
          data: {
            holdId: state.id!,
            expiredAt: normalizeLabel(command.expiredAt),
          },
        },
      ];
    case "ExtendInventoryHold":
      requireCreatedInventoryHold(state);
      assert(state.status === "active", "Only active holds can be extended.");
      assert(state.purpose === "checkout", "Only checkout inventory holds can be extended.");
      assert(state.expiresAt !== null, "Checkout inventory holds require an expiry before they can be extended.");
      assert(state.extensionCount < command.maxExtensionCount, "Checkout reservation extension limit reached.");
      assert(
        Date.parse(command.expiresAt) > Date.parse(state.expiresAt),
        "Checkout reservation extension must move expiry later.",
      );
      return [
        {
          type: "inventory.hold.extended",
          data: {
            holdId: state.id!,
            extendedAt: normalizeLabel(command.extendedAt),
            expiresAt: normalizeLabel(command.expiresAt),
            extensionCount: state.extensionCount + 1,
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveInventoryHold: AggregateEvolver<InventoryHoldState, InventoryHoldEvent> = (state, event) => {
  switch (event.type) {
    case "inventory.hold.placed":
      return {
        id: event.data.holdId,
        accountId: event.data.accountId,
        itemId: event.data.itemId,
        quantity: event.data.quantity,
        reason: event.data.reason,
        notes: event.data.notes,
        purpose: event.data.purpose,
        sourceRef: event.data.sourceRef,
        expiresAt: event.data.expiresAt,
        status: "active",
        releasedAt: null,
        releaseReason: null,
        consumedAt: null,
        expiredAt: null,
        extensionCount: 0,
      };
    case "inventory.hold.released":
      return {
        ...state,
        status: "released",
        releasedAt: event.data.releasedAt,
        releaseReason: event.data.releaseReason,
        consumedAt: null,
      };
    case "inventory.hold.consumed":
      return {
        ...state,
        status: "consumed",
        consumedAt: event.data.consumedAt,
      };
    case "inventory.hold.converted":
      return {
        ...state,
        purpose: event.data.purpose,
        sourceRef: event.data.sourceRef,
        expiresAt: event.data.expiresAt,
      };
    case "inventory.hold.expired":
      return {
        ...state,
        status: "expired",
        expiredAt: event.data.expiredAt,
        releasedAt: event.data.expiredAt,
        releaseReason: "checkout-expired",
      };
    case "inventory.hold.extended":
      return {
        ...state,
        expiresAt: event.data.expiresAt,
        extensionCount: event.data.extensionCount,
      };
    default:
      return assertNever(event);
  }
};

function requireCreatedInventoryHold(state: InventoryHoldState) {
  assert(state.id !== null, "Inventory hold must be created first.");
}

function validateHoldPurpose(purpose: InventoryHoldPurpose) {
  assert(
    (inventoryHoldPurposes as readonly string[]).includes(purpose),
    `Unsupported inventory hold purpose: ${String(purpose)}.`,
  );
  assert(
    purpose === "order" || purpose === "manual" || purpose === "checkout",
    `Inventory hold purpose ${purpose} is planned but not active yet.`,
  );
}

function validateReleaseReason(releaseReason: InventoryHoldReleaseReason) {
  assert(
    (inventoryHoldReleaseReasons as readonly string[]).includes(releaseReason),
    `Unsupported inventory hold release reason: ${String(releaseReason)}.`,
  );
}

function validateHoldSourceRef(purpose: InventoryHoldPurpose, sourceRef: InventoryHoldSourceRef) {
  if (purpose === "order") {
    assert(sourceRef !== null, "Order inventory holds require a source reference.");
    assert("orderId" in sourceRef, "Order inventory holds require an order source reference.");
    assert(normalizeLabel(sourceRef.orderId).length > 0, "Order inventory holds require an order id.");
    assert(
      normalizeLabel(sourceRef.reservationRequestId).length > 0,
      "Order inventory holds require a reservation request id.",
    );
    return;
  }

  if (purpose === "checkout") {
    assert(sourceRef !== null, "Checkout inventory holds require a source reference.");
    assert("checkoutSessionId" in sourceRef, "Checkout inventory holds require a checkout source reference.");
    assert(
      normalizeLabel(sourceRef.checkoutSessionId).length > 0,
      "Checkout inventory holds require a checkout session id.",
    );
    assert(normalizeLabel(sourceRef.lineKey).length > 0, "Checkout inventory holds require a line key.");
    return;
  }

  assert(sourceRef === null, "Manual inventory holds cannot carry a source reference.");
}

function validateHoldExpiry(purpose: InventoryHoldPurpose, expiresAt: string | null) {
  if (purpose === "order" || purpose === "manual") {
    assert(expiresAt === null, `${purpose} inventory holds do not expire automatically.`);
    return;
  }
  if (purpose === "checkout") {
    assert(expiresAt !== null, "Checkout inventory holds require an expiry.");
  }
}

function normalizeOrderSourceRef(sourceRef: { orderId: string; reservationRequestId: string }) {
  return {
    orderId: normalizeLabel(sourceRef.orderId),
    reservationRequestId: normalizeLabel(sourceRef.reservationRequestId),
  };
}

function normalizeHoldSourceRef(sourceRef: InventoryHoldSourceRef): InventoryHoldSourceRef {
  if (sourceRef === null) {
    return null;
  }

  if ("checkoutSessionId" in sourceRef) {
    return {
      checkoutSessionId: normalizeLabel(sourceRef.checkoutSessionId) as never,
      lineKey: normalizeLabel(sourceRef.lineKey),
    };
  }

  return normalizeOrderSourceRef(sourceRef);
}
