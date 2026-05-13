import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type {
  AccountId,
  ShippingAddressId,
} from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  ensureIsoTimestamp,
  normalizeLabel,
} from "../../../support/runtime-support/common";

export type ShippingAddressSnapshot = Readonly<{
  name: string;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string | null;
  email: string | null;
}>;

export type ShippingAddressEntry = ShippingAddressSnapshot &
  Readonly<{
    shippingAddressId: ShippingAddressId;
    label: string;
    isDefault: boolean;
    isArchived: boolean;
    createdAt: string;
    updatedAt: string;
  }>;

export type ShippingAddressBookState = Readonly<{
  accountId: AccountId | null;
  addresses: readonly ShippingAddressEntry[];
}>;

export const initialShippingAddressBookState: ShippingAddressBookState = {
  accountId: null,
  addresses: [],
};

export type AddShippingAddressCommand = Readonly<{
  type: "AddShippingAddress";
  accountId: AccountId;
  shippingAddressId: ShippingAddressId;
  label?: string | null;
  address: ShippingAddressSnapshot;
  makeDefault?: boolean;
  addedAt: string;
}>;

export type UpdateShippingAddressCommand = Readonly<{
  type: "UpdateShippingAddress";
  shippingAddressId: ShippingAddressId;
  label?: string | null;
  address: ShippingAddressSnapshot;
  makeDefault?: boolean;
  updatedAt: string;
}>;

export type SetDefaultShippingAddressCommand = Readonly<{
  type: "SetDefaultShippingAddress";
  shippingAddressId: ShippingAddressId;
  setAt: string;
}>;

export type ArchiveShippingAddressCommand = Readonly<{
  type: "ArchiveShippingAddress";
  shippingAddressId: ShippingAddressId;
  archivedAt: string;
}>;

export type ShippingAddressCommand =
  | AddShippingAddressCommand
  | UpdateShippingAddressCommand
  | SetDefaultShippingAddressCommand
  | ArchiveShippingAddressCommand;

export type ShippingAddressAddedEvent = DomainEvent<
  "identity.shipping-address.added",
  Readonly<{
    accountId: AccountId;
    shippingAddressId: ShippingAddressId;
    label: string;
    address: ShippingAddressSnapshot;
    isDefault: boolean;
    addedAt: string;
  }>
>;

export type ShippingAddressUpdatedEvent = DomainEvent<
  "identity.shipping-address.updated",
  Readonly<{
    accountId: AccountId;
    shippingAddressId: ShippingAddressId;
    label: string;
    address: ShippingAddressSnapshot;
    isDefault: boolean;
    updatedAt: string;
  }>
>;

export type DefaultShippingAddressSetEvent = DomainEvent<
  "identity.shipping-address.default-set",
  Readonly<{
    accountId: AccountId;
    shippingAddressId: ShippingAddressId;
    setAt: string;
  }>
>;

export type ShippingAddressArchivedEvent = DomainEvent<
  "identity.shipping-address.archived",
  Readonly<{
    accountId: AccountId;
    shippingAddressId: ShippingAddressId;
    promotedDefaultShippingAddressId: ShippingAddressId | null;
    archivedAt: string;
  }>
>;

export type ShippingAddressEvent =
  | ShippingAddressAddedEvent
  | ShippingAddressUpdatedEvent
  | DefaultShippingAddressSetEvent
  | ShippingAddressArchivedEvent;

function normalizeOptionalText(value: string | null | undefined) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeRequiredText(value: string, fieldName: string) {
  const normalized = normalizeLabel(value);
  assert(normalized.length > 0, `${fieldName} is required.`);
  return normalized;
}

export function normalizeShippingAddressSnapshot(
  address: ShippingAddressSnapshot,
): ShippingAddressSnapshot {
  return {
    name: normalizeRequiredText(address.name, "Recipient name"),
    company: normalizeOptionalText(address.company),
    line1: normalizeRequiredText(address.line1, "Address line 1"),
    line2: normalizeOptionalText(address.line2),
    city: normalizeRequiredText(address.city, "City"),
    state: normalizeRequiredText(address.state, "State").toUpperCase(),
    postalCode: normalizeRequiredText(address.postalCode, "Postal code"),
    country: normalizeRequiredText(address.country, "Country").toUpperCase(),
    phone: normalizeOptionalText(address.phone),
    email: normalizeOptionalText(address.email),
  };
}

function normalizeAddressLabel(
  label: string | null | undefined,
  address: ShippingAddressSnapshot,
) {
  const normalized = normalizeOptionalText(label);
  return normalized ?? `${address.name} - ${address.city}, ${address.state}`;
}

function activeAddresses(state: ShippingAddressBookState) {
  return state.addresses.filter((address) => !address.isArchived);
}

function findAddress(
  state: ShippingAddressBookState,
  shippingAddressId: ShippingAddressId,
) {
  return state.addresses.find(
    (address) => address.shippingAddressId === shippingAddressId,
  );
}

function requireAccount(
  state: ShippingAddressBookState,
  accountId?: AccountId,
) {
  assert(
    state.accountId !== null || accountId !== undefined,
    "Shipping address book requires an account.",
  );
  if (state.accountId !== null && accountId) {
    assert(state.accountId === accountId, "Shipping address account mismatch.");
  }
  return (state.accountId ?? accountId) as AccountId;
}

function shouldBecomeDefault(
  state: ShippingAddressBookState,
  requested: boolean | undefined,
) {
  return requested === true || activeAddresses(state).length === 0;
}

function newestActiveFallback(
  state: ShippingAddressBookState,
  archivedShippingAddressId: ShippingAddressId,
) {
  const candidates = activeAddresses(state)
    .filter((address) => address.shippingAddressId !== archivedShippingAddressId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return candidates[0]?.shippingAddressId ?? null;
}

export const decideShippingAddressBook: AggregateDecider<
  ShippingAddressBookState,
  ShippingAddressCommand,
  ShippingAddressEvent
> = (state, command) => {
  switch (command.type) {
    case "AddShippingAddress": {
      assert(
        !findAddress(state, command.shippingAddressId),
        "Shipping address has already been added.",
      );
      const address = normalizeShippingAddressSnapshot(command.address);
      const accountId = requireAccount(state, command.accountId);
      const isDefault = shouldBecomeDefault(state, command.makeDefault);
      return [
        {
          type: "identity.shipping-address.added",
          data: {
            accountId,
            shippingAddressId: command.shippingAddressId,
            label: normalizeAddressLabel(command.label, address),
            address,
            isDefault,
            addedAt: ensureIsoTimestamp(command.addedAt),
          },
        },
      ];
    }
    case "UpdateShippingAddress": {
      const existing = findAddress(state, command.shippingAddressId);
      assert(existing !== undefined, "Shipping address not found.");
      assert(!existing.isArchived, "Archived shipping addresses cannot be updated.");
      const address = normalizeShippingAddressSnapshot(command.address);
      const isDefault = command.makeDefault === true || existing.isDefault;
      return [
        {
          type: "identity.shipping-address.updated",
          data: {
            accountId: requireAccount(state),
            shippingAddressId: command.shippingAddressId,
            label: normalizeAddressLabel(command.label, address),
            address,
            isDefault,
            updatedAt: ensureIsoTimestamp(command.updatedAt),
          },
        },
      ];
    }
    case "SetDefaultShippingAddress": {
      const existing = findAddress(state, command.shippingAddressId);
      assert(existing !== undefined, "Shipping address not found.");
      assert(!existing.isArchived, "Archived shipping addresses cannot be default.");
      if (existing.isDefault) {
        return [];
      }
      return [
        {
          type: "identity.shipping-address.default-set",
          data: {
            accountId: requireAccount(state),
            shippingAddressId: command.shippingAddressId,
            setAt: ensureIsoTimestamp(command.setAt),
          },
        },
      ];
    }
    case "ArchiveShippingAddress": {
      const existing = findAddress(state, command.shippingAddressId);
      assert(existing !== undefined, "Shipping address not found.");
      if (existing.isArchived) {
        return [];
      }
      return [
        {
          type: "identity.shipping-address.archived",
          data: {
            accountId: requireAccount(state),
            shippingAddressId: command.shippingAddressId,
            promotedDefaultShippingAddressId: existing.isDefault
              ? newestActiveFallback(state, command.shippingAddressId)
              : null,
            archivedAt: ensureIsoTimestamp(command.archivedAt),
          },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

function applyDefaultSelection(
  addresses: readonly ShippingAddressEntry[],
  shippingAddressId: ShippingAddressId,
): ShippingAddressEntry[] {
  return addresses.map((address) => ({
    ...address,
    isDefault: !address.isArchived && address.shippingAddressId === shippingAddressId,
  }));
}

export const evolveShippingAddressBook: AggregateEvolver<
  ShippingAddressBookState,
  ShippingAddressEvent
> = (state, event) => {
  switch (event.type) {
    case "identity.shipping-address.added": {
      const entry: ShippingAddressEntry = {
        shippingAddressId: event.data.shippingAddressId,
        label: event.data.label,
        ...event.data.address,
        isDefault: event.data.isDefault,
        isArchived: false,
        createdAt: event.data.addedAt,
        updatedAt: event.data.addedAt,
      };
      const addresses = event.data.isDefault
        ? applyDefaultSelection([...state.addresses, entry], event.data.shippingAddressId)
        : [...state.addresses, entry];
      return {
        accountId: event.data.accountId,
        addresses,
      };
    }
    case "identity.shipping-address.updated": {
      const updated = state.addresses.map((address) =>
        address.shippingAddressId === event.data.shippingAddressId
          ? {
              ...address,
              label: event.data.label,
              ...event.data.address,
              isDefault: event.data.isDefault,
              updatedAt: event.data.updatedAt,
            }
          : address,
      );
      return {
        ...state,
        addresses: event.data.isDefault
          ? applyDefaultSelection(updated, event.data.shippingAddressId)
          : updated,
      };
    }
    case "identity.shipping-address.default-set":
      return {
        ...state,
        addresses: applyDefaultSelection(
          state.addresses.map((address) =>
            address.shippingAddressId === event.data.shippingAddressId
              ? { ...address, updatedAt: event.data.setAt }
              : address,
          ),
          event.data.shippingAddressId,
        ),
      };
    case "identity.shipping-address.archived": {
      const archived = state.addresses.map((address) =>
        address.shippingAddressId === event.data.shippingAddressId
          ? {
              ...address,
              isArchived: true,
              isDefault: false,
              updatedAt: event.data.archivedAt,
            }
          : address,
      );
      return {
        ...state,
        addresses: event.data.promotedDefaultShippingAddressId
          ? applyDefaultSelection(
              archived.map((address) =>
                address.shippingAddressId === event.data.promotedDefaultShippingAddressId
                  ? { ...address, updatedAt: event.data.archivedAt }
                  : address,
              ),
              event.data.promotedDefaultShippingAddressId,
            )
          : archived,
      };
    }
    default:
      return assertNever(event);
  }
};
