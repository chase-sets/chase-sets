import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { SavedListCommandId, SavedListId } from "./contracts";

export const savedListSharingEventSchemaVersion = 1 as const;
export const savedListSharingReceiptSchemaVersion = "collections.saved-list-sharing-receipt.v1" as const;

export type SavedListSharingDisclosure = Readonly<{
  showTrackedQuantities: boolean;
  showCurrentEstimatedValue: boolean;
}>;

export const privateSavedListSharingDisclosure: SavedListSharingDisclosure = {
  showTrackedQuantities: false,
  showCurrentEstimatedValue: false,
};

export type SavedListSharingSnapshot = Readonly<{
  contractVersion: 1;
  listId: SavedListId;
  ownerAccountId: AccountId;
  disclosure: SavedListSharingDisclosure;
  unlistedAccess: Readonly<{
    active: boolean;
    generation: number;
    changedAt: string | null;
  }>;
  changedAt: string;
  version: number;
}>;

export type SavedListUnlistedSecret = string & Readonly<{ __savedListUnlistedSecret: true }>;

export type SavedListSharingCommandOutcome =
  | "configured"
  | "disclosure-changed"
  | "unlisted-access-rotated"
  | "unlisted-access-revoked"
  | "no-change";

export type SavedListSharingCommandReceipt = Readonly<{
  schemaVersion: typeof savedListSharingReceiptSchemaVersion;
  commandId: SavedListCommandId;
  listId: SavedListId;
  outcome: SavedListSharingCommandOutcome;
  previousVersion: number;
  committedVersion: number;
  replayed: boolean;
}>;

export type SavedListSharingCommandResult = Readonly<{
  receipt: SavedListSharingCommandReceipt;
  sharing: SavedListSharingSnapshot;
  unlistedSecret: SavedListUnlistedSecret | null;
}>;

export type SavedListCapabilityMaterial = Readonly<{
  keyId: string;
  secret: SavedListUnlistedSecret;
  verifier: string;
}>;

export type SavedListCapabilityService = Readonly<{
  mint: (input: Readonly<{ listId: SavedListId; commandId: SavedListCommandId }>) => SavedListCapabilityMaterial;
  reissue: (
    input: Readonly<{ listId: SavedListId; commandId: SavedListCommandId; keyId: string }>,
  ) => SavedListUnlistedSecret;
  verifierFor: (secret: SavedListUnlistedSecret) => string | null;
}>;
