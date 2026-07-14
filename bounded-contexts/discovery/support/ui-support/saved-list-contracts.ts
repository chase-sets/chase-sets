import type {
  RecentSavedList,
  SavedListAdditionResponse,
  SavedListAdditionTokens,
  SavedListDestination,
  SavedListDiscoverySurface,
  SavedListProductSelection,
} from "../route-support/collections-saved-list-contracts";

export type SavedListPickerPreparation = Readonly<{
  product: SavedListProductSelection;
  productLabel: string;
  recentLists: readonly RecentSavedList[];
  tokens: SavedListAdditionTokens;
  sourceSurface: SavedListDiscoverySurface;
  claimIntentId: string | null;
  resumeDestination: SavedListDestination | null;
  resumeTrackedQuantity: number | null;
}>;

export type SavedListRouteActionData =
  | Readonly<{ status: "ready"; preparation: SavedListPickerPreparation }>
  | Readonly<{ status: "registration-required"; href: string }>
  | Readonly<{ status: "options-required"; href: string }>
  | Readonly<{ status: "saved"; result: SavedListAdditionResponse; trackedQuantity: number }>;

export type SavedListClaimLoadState = Readonly<{
  preparation: SavedListPickerPreparation | null;
  error: string | null;
}>;
