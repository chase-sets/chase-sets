import type {
  SavedListLifecycleState,
  SavedListProductAvailability,
  SavedListProductSelection,
  SavedListVisibility,
} from "../domain/contracts";
import type { SavedListId, SavedListLineId } from "../domain/contracts";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

export type SavedListCatalogOptionDisplay = Readonly<{
  dimensionId: string;
  dimensionName: string | null;
  optionId: string;
  optionLabel: string | null;
}>;

export type SavedListCatalogDisplay = Readonly<{
  availability: SavedListProductAvailability;
  languageCode: string | null;
  title: string | null;
  subtitle: string | null;
  selectedOptions: readonly SavedListCatalogOptionDisplay[];
  updatedAt: string | null;
}>;

export type SavedListReadLine = Readonly<{
  lineId: SavedListLineId;
  product: SavedListProductSelection;
  catalog: SavedListCatalogDisplay;
  trackedQuantity: number;
  privateNotes: string | null;
  privateTags: readonly string[];
  position: number;
  addedAt: string;
  changedAt: string;
}>;

export type SavedListReadCover = Readonly<{
  lineId: SavedListLineId;
  product: SavedListProductSelection;
  catalog: SavedListCatalogDisplay;
}>;

export type SavedListSummaryReadModel = Readonly<{
  contractVersion: 1;
  listId: SavedListId;
  ownerAccountId: AccountId;
  title: string;
  description: string | null;
  visibility: SavedListVisibility;
  lifecycle: SavedListLifecycleState;
  cover: SavedListReadCover | null;
  lineCount: number;
  trackedUnitCount: number;
  createdAt: string;
  changedAt: string;
  archivedAt: string | null;
  version: number;
}>;

export type SavedListDetailReadModel = SavedListSummaryReadModel &
  Readonly<{
    lines: readonly SavedListReadLine[];
  }>;

export type SavedListSummaryPage = Readonly<{
  items: readonly SavedListSummaryReadModel[];
  total: number;
  nextCursor: string | null;
}>;

export type MyCollectionSavedListsModule = Readonly<{
  contractVersion: 1;
  kind: "saved-lists";
  savedLists: SavedListSummaryPage;
}>;

export type SavedListSummaryQuery = Readonly<{
  ownerAccountId: AccountId;
  search?: string | null;
  visibilities?: readonly SavedListVisibility[];
  lifecycle?: SavedListLifecycleState | "all";
  cursor?: string | null;
  limit?: number | null;
}>;

export type SavedListDetailQuery = Readonly<{
  ownerAccountId: AccountId;
  listId: SavedListId;
}>;
