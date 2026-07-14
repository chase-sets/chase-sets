import type {
  SavedListAdditionResponse,
  SavedListAdditionTokens,
  SavedListDestination,
  SavedListDiscoverySurface,
  SavedListProductSelection,
} from "../../../support/request-support/collections-saved-list-contracts";
import type { DiscoveryRecentSavedList } from "../read-model/queries";

export type SavedListPickerPreparation = Readonly<{
  product: SavedListProductSelection;
  productLabel: string;
  recentLists: readonly DiscoveryRecentSavedList[];
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
