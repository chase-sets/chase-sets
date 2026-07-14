/**
 * React web surface for the collections context.
 *
 * The My Collection deep module and its presentation view-models are exported
 * here for the marketplace-web deployable. React-free Saved List contracts stay
 * in `./server`; this barrel is the only place React enters the context.
 */
export { MyCollectionPage, type MyCollectionPageProps } from "./support/ui-support";
export type {
  CollectionActivityEntry,
  CollectionActivityKind,
  CollectionMoney,
  CollectionOverviewView,
  CollectionSectionStatus,
  MyCollectionHrefs,
  MyCollectionSection,
  MyCollectionView,
  OwnedCardView,
  OwnedCardsView,
  SavedListDetailView,
  SavedListLineAvailability,
  SavedListLineDisplay,
  SavedListSummaryView,
  SavedListsView,
} from "./support/ui-support";
