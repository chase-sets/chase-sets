/**
 * React-free presentation view-models for the My Collection deep module.
 *
 * The Lists section consumes the committed Saved List owner-snapshot and line
 * contracts from the `saved-lists` slice directly, so this surface never
 * redefines Saved List truth. Overview and Owned Cards carry Inventory-owned
 * presentation shapes (value, quantities, cost visibility) that the route
 * loader maps from Inventory read models; Collections never stores that truth.
 */
import type {
  SavedListId,
  SavedListLineId,
  SavedListOwnerSnapshot,
  SavedListVisibility,
} from "../../features/saved-lists/domain";

export type MyCollectionSection = "overview" | "owned-cards" | "lists";

export type CollectionSectionStatus = "ready" | "loading" | "empty" | "error";

/** A rendered money amount. Kept as a decimal string + ISO currency, formatted at the edge. */
export type CollectionMoney = Readonly<{
  amount: string;
  currency: string;
}>;

export type CollectionActivityKind = "owned-card-added" | "owned-card-updated" | "list-created" | "list-updated";

export type CollectionActivityEntry = Readonly<{
  id: string;
  kind: CollectionActivityKind;
  /** Dynamic entity name (card title or list title). This is data, never UI copy. */
  subject: string;
  occurredAt: string;
}>;

export type CollectionOverviewView = Readonly<{
  status: CollectionSectionStatus;
  /** Pricing degraded hides value without blocking list/Inventory use. */
  pricingDegraded: boolean;
  /** The single account-wide valuation total. Inventory-owned. Null when pricing degrades. */
  totalValue: CollectionMoney | null;
  ownedCardCount: number;
  ownedUnitCount: number;
  savedListCount: number;
  /** Share of owned cards with a market price, 0-100. Null when pricing degrades. */
  pricedCoveragePercent: number | null;
  recentActivity: readonly CollectionActivityEntry[];
}>;

export type OwnedCardView = Readonly<{
  itemId: string;
  title: string;
  subtitle: string | null;
  productSummary: string | null;
  ownedQuantity: number;
  availableQuantity: number;
  heldQuantity: number;
  /** Null when the actor cannot see cost, or no cost is recorded. */
  acquisitionCost: CollectionMoney | null;
  /** Null when pricing degrades. */
  marketValue: CollectionMoney | null;
  /** Deep link into the shared Inventory/Seller Desk surface for operational actions. */
  manageHref: string | null;
}>;

export type OwnedCardsView = Readonly<{
  status: CollectionSectionStatus;
  pricingDegraded: boolean;
  /** The single cost-basis gate. Cost/P&L only appears for Inventory-backed Owned Cards. */
  showAcquisitionCost: boolean;
  cards: readonly OwnedCardView[];
}>;

export type SavedListSummaryView = Readonly<{
  listId: SavedListId;
  title: string;
  description: string | null;
  visibility: SavedListVisibility;
  lineCount: number;
  trackedUnitCount: number;
  changedAt: string;
  /** Contextual list value. Null when pricing degrades. Never a cost basis. */
  estimatedValue: CollectionMoney | null;
}>;

export type SavedListLineAvailability = "active" | "retired" | "missing";

export type SavedListLineDisplay = Readonly<{
  title: string;
  subtitle: string | null;
  availability: SavedListLineAvailability;
  /** Contextual line value. Null when pricing degrades. Never a cost basis. */
  estimatedValue: CollectionMoney | null;
}>;

export type SavedListDetailView = Readonly<{
  /** The committed Saved List owner snapshot, consumed verbatim as the edit view-model. */
  snapshot: SavedListOwnerSnapshot;
  estimatedValue: CollectionMoney | null;
  lineDisplay: Readonly<Partial<Record<SavedListLineId, SavedListLineDisplay>>>;
}>;

export type SavedListsView = Readonly<{
  status: CollectionSectionStatus;
  lists: readonly SavedListSummaryView[];
  query: string;
  /** Present when a single list is opened for detail/edit. */
  selected: SavedListDetailView | null;
  /**
   * True when the Saved List command service is unreachable, so edits degrade to
   * read-only. Only reversible edits are ever optimistically applied elsewhere.
   */
  editUnavailable: boolean;
}>;

export type MyCollectionView = Readonly<{
  activeSection: MyCollectionSection;
  overview: CollectionOverviewView;
  ownedCards: OwnedCardsView;
  lists: SavedListsView;
}>;

/** Href helpers keep the surface configurable without hard-coding deployable routes. */
export type MyCollectionHrefs = Readonly<{
  section: (section: MyCollectionSection) => string;
  list: (listId: SavedListId) => string;
  lists: string;
}>;
