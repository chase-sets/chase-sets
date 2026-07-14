import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId, TypedUlid } from "@chase-sets/primitives/typed-ids";

export type SavedListId = TypedUlid<"svl">;
export type SavedListLineId = TypedUlid<"sll">;
export type SavedListCommandId = TypedUlid<"slc">;

export const savedListEventSchemaVersion = 1 as const;
export type SavedListEventSchemaVersion = typeof savedListEventSchemaVersion;

export const savedListCommandReceiptSchemaVersion = "collections.saved-list-command-receipt.v1" as const;
export type SavedListCommandReceiptSchemaVersion = typeof savedListCommandReceiptSchemaVersion;

export const savedListLimits = {
  maximumLines: 10_000,
  maximumBatchOperations: 100,
  maximumTrackedQuantity: 1_000_000,
  maximumTitleLength: 120,
  maximumDescriptionLength: 2_000,
  maximumPrivateNotesLength: 2_000,
  maximumPrivateTags: 20,
  maximumPrivateTagLength: 40,
  maximumSelectedOptions: 64,
} as const;

export type SavedListVisibility = "private" | "unlisted" | "public";
export type SavedListLifecycleState = "active" | "archived";

export type SavedListSelectedOption = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

export type SavedListProductSelection = Readonly<{
  catalogItemId: CatalogItemId;
  productId: ProductKey;
  selectedOptions: readonly SavedListSelectedOption[];
}>;

export type SavedListIdentity = Readonly<{
  listId: SavedListId;
  ownerAccountId: AccountId;
}>;

export type SavedListCover = Readonly<{
  lineId: SavedListLineId;
}>;

export type SavedListLine = Readonly<{
  lineId: SavedListLineId;
  product: SavedListProductSelection;
  trackedQuantity: number;
  privateNotes: string | null;
  privateTags: readonly string[];
  addedAt: string;
  changedAt: string;
}>;

export type SavedListMembership = Readonly<{
  orderedLineIds: readonly SavedListLineId[];
  lineCount: number;
  trackedUnitCount: number;
}>;

export type SavedListState = Readonly<{
  identity: SavedListIdentity | null;
  title: string;
  description: string | null;
  visibility: SavedListVisibility;
  lifecycle: SavedListLifecycleState;
  cover: SavedListCover | null;
  lines: readonly SavedListLine[];
  createdAt: string | null;
  changedAt: string | null;
  archivedAt: string | null;
}>;

export type SavedListOwnerLineSnapshot = SavedListLine & Readonly<{ position: number }>;

export type SavedListOwnerSnapshot = Readonly<{
  contractVersion: 1;
  identity: SavedListIdentity;
  title: string;
  description: string | null;
  visibility: SavedListVisibility;
  lifecycle: SavedListLifecycleState;
  cover: SavedListCover | null;
  membership: SavedListMembership;
  lines: readonly SavedListOwnerLineSnapshot[];
  createdAt: string;
  changedAt: string;
  archivedAt: string | null;
  version: number;
}>;

export type SavedListViewerLineSnapshot = Readonly<{
  lineId: SavedListLineId;
  product: SavedListProductSelection;
  trackedQuantity: number | null;
  position: number;
}>;

export type SavedListViewerSnapshot = Readonly<{
  contractVersion: 1;
  listId: SavedListId;
  title: string;
  description: string | null;
  visibility: Exclude<SavedListVisibility, "private">;
  cover: SavedListCover | null;
  lineCount: number;
  lines: readonly SavedListViewerLineSnapshot[];
  changedAt: string;
  version: number;
}>;

export type SavedListViewerDisclosure = Readonly<{
  showTrackedQuantities: boolean;
}>;

export type SavedListLineChangeErrorCode =
  | "duplicate-operation"
  | "invalid-line"
  | "invalid-product"
  | "product-not-found"
  | "product-retired"
  | "catalog-unavailable"
  | "line-not-found"
  | "line-limit-reached"
  | "quantity-limit-exceeded"
  | "list-archived";

export type SavedListLineChangeResult = Readonly<{
  operationId: string;
  status: "added" | "merged" | "changed" | "removed" | "reordered" | "rejected";
  lineId: SavedListLineId | null;
  error: Readonly<{
    code: SavedListLineChangeErrorCode;
    message: string;
  }> | null;
}>;

export type SavedListCommandOutcome =
  | "created"
  | "details-changed"
  | "archived"
  | "visibility-changed"
  | "cover-changed"
  | "line-changes-applied"
  | "no-change";

export type SavedListCommandReceipt = Readonly<{
  schemaVersion: SavedListCommandReceiptSchemaVersion;
  commandId: SavedListCommandId;
  listId: SavedListId;
  outcome: SavedListCommandOutcome;
  previousVersion: number;
  committedVersion: number;
  replayed: boolean;
  lineResults: readonly SavedListLineChangeResult[];
}>;

export type SavedListCommandResult = Readonly<{
  receipt: SavedListCommandReceipt;
  savedList: SavedListOwnerSnapshot;
}>;

export type SavedListProductAvailability = "active" | "retired" | "missing" | "unavailable";

export type SavedListCatalogProduct = Readonly<{
  availability: SavedListProductAvailability;
  product: SavedListProductSelection | null;
}>;

export type SavedListProductCatalog = Readonly<{
  resolveProduct: (selection: SavedListProductSelection) => Promise<SavedListCatalogProduct>;
}>;
