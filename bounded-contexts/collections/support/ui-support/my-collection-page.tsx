import { Page, PageHeader, Stack, type TabItem, Tabs } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { CollectionOverviewSection } from "./collection-overview-section";
import { OwnedCardsSection } from "./owned-cards-section";
import { SavedListsSection } from "./saved-lists-section";
import type { MyCollectionHrefs, MyCollectionView } from "./view-models";

export type MyCollectionPageProps = Readonly<{
  view: MyCollectionView;
  hrefs: MyCollectionHrefs;
}>;

/**
 * The My Collection deep module. One customer surface that composes the
 * Inventory-owned Overview and Owned Cards with the Collections-owned Saved
 * Lists, along with every loading/empty/error/degraded state, behind a single
 * navigation model. The account-wide valuation total appears only in Overview,
 * and cost/P&L only appears for Inventory-backed Overview and Owned Cards, so a
 * viewer never sees two valuation totals or two cost bases.
 */
export function MyCollectionPage({ view, hrefs }: MyCollectionPageProps) {
  const items: TabItem[] = [
    {
      value: "overview",
      label: t("collections.features.myCollection.ui.myCollectionPage.tab.overview"),
      content: <CollectionOverviewSection overview={view.overview} />,
    },
    {
      value: "owned-cards",
      label: t("collections.features.myCollection.ui.myCollectionPage.tab.ownedCards"),
      content: <OwnedCardsSection ownedCards={view.ownedCards} />,
    },
    {
      value: "lists",
      label: t("collections.features.myCollection.ui.myCollectionPage.tab.lists"),
      content: <SavedListsSection lists={view.lists} hrefs={hrefs} />,
    },
  ];

  return (
    <Page>
      <Stack gap={6}>
        <PageHeader
          eyebrow={t("collections.features.myCollection.ui.myCollectionPage.eyebrow")}
          title={t("collections.features.myCollection.ui.myCollectionPage.title")}
          description={t("collections.features.myCollection.ui.myCollectionPage.description")}
        />
        <Tabs items={items} defaultValue={view.activeSection} />
      </Stack>
    </Page>
  );
}
