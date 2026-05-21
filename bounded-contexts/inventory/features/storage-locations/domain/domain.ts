import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import { normalizeAddressSnapshot, type AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  normalizeLabel,
  normalizeOptionalText,
  type InventoryStorageLocationId,
} from "../../../support/runtime-support/common";

export type StorageLocationState = Readonly<{
  id: InventoryStorageLocationId | null;
  accountId: AccountId | null;
  name: string;
  description: string | null;
  shipFromCode: string | null;
  shipFromAddress: AddressSnapshot | null;
  isArchived: boolean;
}>;

export const initialStorageLocationState: StorageLocationState = {
  id: null,
  accountId: null,
  name: "",
  description: null,
  shipFromCode: null,
  shipFromAddress: null,
  isArchived: false,
};

export type CreateStorageLocationCommand = Readonly<{
  type: "CreateStorageLocation";
  storageLocationId: InventoryStorageLocationId;
  accountId: AccountId;
  name: string;
  description?: string | null;
  shipFromCode: string;
  shipFromAddress: AddressSnapshot;
}>;

export type UpdateStorageLocationCommand = Readonly<{
  type: "UpdateStorageLocation";
  name: string;
  description?: string | null;
  shipFromCode: string;
  shipFromAddress: AddressSnapshot;
}>;

export type ArchiveStorageLocationCommand = Readonly<{
  type: "ArchiveStorageLocation";
}>;

export type StorageLocationCommand =
  | CreateStorageLocationCommand
  | UpdateStorageLocationCommand
  | ArchiveStorageLocationCommand;

export type StorageLocationCreatedEvent = DomainEvent<
  "inventory.storage-location.created",
  Readonly<{
    storageLocationId: InventoryStorageLocationId;
    accountId: AccountId;
    name: string;
    description: string | null;
    shipFromCode: string;
    shipFromAddress: AddressSnapshot;
  }>
>;

export type StorageLocationUpdatedEvent = DomainEvent<
  "inventory.storage-location.updated",
  Readonly<{
    storageLocationId: InventoryStorageLocationId;
    name: string;
    description: string | null;
    shipFromCode: string;
    shipFromAddress: AddressSnapshot;
  }>
>;

export type StorageLocationArchivedEvent = DomainEvent<
  "inventory.storage-location.archived",
  Readonly<{
    storageLocationId: InventoryStorageLocationId;
  }>
>;

export type StorageLocationEvent =
  | StorageLocationCreatedEvent
  | StorageLocationUpdatedEvent
  | StorageLocationArchivedEvent;

export const decideStorageLocation: AggregateDecider<
  StorageLocationState,
  StorageLocationCommand,
  StorageLocationEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateStorageLocation":
      assert(state.id === null, "Storage location has already been created.");
      return [
        {
          type: "inventory.storage-location.created",
          data: {
            storageLocationId: command.storageLocationId,
            accountId: command.accountId,
            name: normalizeLabel(command.name),
            description: normalizeOptionalText(command.description),
            shipFromCode: normalizeLabel(command.shipFromCode),
            shipFromAddress: normalizeAddressSnapshot(command.shipFromAddress, "Ship-from address"),
          },
        },
      ];
    case "UpdateStorageLocation":
      requireCreatedStorageLocation(state);
      assert(!state.isArchived, "Archived storage locations cannot be updated.");
      return [
        {
          type: "inventory.storage-location.updated",
          data: {
            storageLocationId: state.id!,
            name: normalizeLabel(command.name),
            description: normalizeOptionalText(command.description),
            shipFromCode: normalizeLabel(command.shipFromCode),
            shipFromAddress: normalizeAddressSnapshot(command.shipFromAddress, "Ship-from address"),
          },
        },
      ];
    case "ArchiveStorageLocation":
      requireCreatedStorageLocation(state);
      assert(!state.isArchived, "Storage location has already been archived.");
      return [
        {
          type: "inventory.storage-location.archived",
          data: { storageLocationId: state.id! },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveStorageLocation: AggregateEvolver<StorageLocationState, StorageLocationEvent> = (state, event) => {
  switch (event.type) {
    case "inventory.storage-location.created":
      return {
        id: event.data.storageLocationId,
        accountId: event.data.accountId,
        name: event.data.name,
        description: event.data.description,
        shipFromCode: event.data.shipFromCode,
        shipFromAddress: event.data.shipFromAddress,
        isArchived: false,
      };
    case "inventory.storage-location.updated":
      return {
        ...state,
        name: event.data.name,
        description: event.data.description,
        shipFromCode: event.data.shipFromCode,
        shipFromAddress: event.data.shipFromAddress,
      };
    case "inventory.storage-location.archived":
      return {
        ...state,
        isArchived: true,
      };
    default:
      return assertNever(event);
  }
};

function requireCreatedStorageLocation(state: StorageLocationState) {
  assert(state.id !== null, "Storage location must be created first.");
}
