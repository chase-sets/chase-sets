import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type {
  SavedListCommandId,
  SavedListCommandResult,
  SavedListId,
  SavedListLineId,
  SavedListProductSelection,
} from "../domain/contracts";
import type { RecentSavedList } from "../read-model/picker-queries";

export type SavedListDiscoverySurface = "search" | "item-detail";
export type SavedListDiscoveryAnalyticsLabel =
  | "saved-list.added"
  | "saved-list.merged"
  | "saved-list.created-and-added"
  | "saved-list.guest-intent-created"
  | "saved-list.guest-intent-claimed";

export type SavedListAdditionTokens = Readonly<{
  addCommandId: SavedListCommandId;
  lineId: SavedListLineId;
  newListId: SavedListId;
  newListCommandId: SavedListCommandId;
}>;

export type SavedListDestination =
  | Readonly<{ kind: "existing"; listId: SavedListId }>
  | Readonly<{
      kind: "new";
      listId: SavedListId;
      createCommandId: SavedListCommandId;
      title: string;
    }>;

export type AddProductToSavedListRequest = Readonly<{
  destination: SavedListDestination;
  addCommandId: SavedListCommandId;
  lineId: SavedListLineId;
  product: SavedListProductSelection;
  trackedQuantity: number;
  sourceSurface: SavedListDiscoverySurface;
}>;

export type SavedListAdditionResponse = Readonly<{
  command: SavedListCommandResult;
  listId: SavedListId;
  title: string;
  lineStatus: "added" | "merged";
  alreadyClaimed: boolean;
  analyticsLabel: SavedListDiscoveryAnalyticsLabel;
}>;

export type RecentSavedListsResponse = Readonly<{
  items: readonly RecentSavedList[];
  count: number;
}>;

export type AnonymousSavedListIntentStatus = "active" | "claiming" | "claimed" | "expired";

export type AnonymousSavedListIntent = Readonly<{
  intentId: string;
  anonymousOwnerId: string;
  sourcePath: string;
  sourceSurface: SavedListDiscoverySurface;
  product: SavedListProductSelection;
  productSummary: string | null;
  addCommandId: SavedListCommandId;
  lineId: SavedListLineId;
  status: AnonymousSavedListIntentStatus;
  claimedAccountId: AccountId | null;
  claimedListId: SavedListId | null;
  claimedCreateCommandId: SavedListCommandId | null;
  claimedListTitle: string | null;
  claimedTrackedQuantity: number | null;
  claimedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}>;

export type CreateAnonymousSavedListIntentRequest = Readonly<{
  sourcePath: string;
  sourceSurface: SavedListDiscoverySurface;
  product: SavedListProductSelection;
  productSummary?: string | null;
}>;

export type AnonymousSavedListClaimPreparation = Readonly<{
  intent: AnonymousSavedListIntent;
  recentLists: readonly RecentSavedList[];
  tokens: SavedListAdditionTokens;
  resumeDestination: SavedListDestination | null;
}>;
