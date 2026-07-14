import { type DataColumn, DataTable, EmptyState, LinkButton, Stack, Text } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { formatCollectionMoney } from "./formatting";
import { CollectionSectionDegraded, CollectionSectionError, CollectionSectionLoading } from "./section-states";
import type { OwnedCardView, OwnedCardsView } from "./view-models";

function buildColumns(view: OwnedCardsView): DataColumn<OwnedCardView>[] {
  const valueUnavailable = t("collections.features.myCollection.ui.ownedCardsSection.value.unavailable");
  const columns: DataColumn<OwnedCardView>[] = [
    {
      key: "card",
      header: t("collections.features.myCollection.ui.ownedCardsSection.column.card"),
      cell: (card) => (
        <Stack gap={1} minWidth="0">
          <Text weight="semibold">{card.title}</Text>
          {card.subtitle ? (
            <Text size="sm" tone="secondary">
              {card.subtitle}
            </Text>
          ) : null}
          {card.productSummary ? (
            <Text size="xs" tone="secondary">
              {card.productSummary}
            </Text>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "owned",
      header: t("collections.features.myCollection.ui.ownedCardsSection.column.owned"),
      align: "right",
      cell: (card) => String(card.ownedQuantity),
    },
    {
      key: "available",
      header: t("collections.features.myCollection.ui.ownedCardsSection.column.available"),
      align: "right",
      cell: (card) => String(card.availableQuantity),
    },
    {
      key: "held",
      header: t("collections.features.myCollection.ui.ownedCardsSection.column.held"),
      align: "right",
      cell: (card) => String(card.heldQuantity),
    },
  ];

  if (view.showAcquisitionCost) {
    columns.push({
      key: "acquisitionCost",
      header: t("collections.features.myCollection.ui.ownedCardsSection.column.acquisitionCost"),
      align: "right",
      cell: (card) =>
        card.acquisitionCost
          ? formatCollectionMoney(card.acquisitionCost)
          : t("collections.features.myCollection.ui.ownedCardsSection.cost.notSet"),
    });
  }

  columns.push({
    key: "marketValue",
    header: t("collections.features.myCollection.ui.ownedCardsSection.column.marketValue"),
    align: "right",
    cell: (card) => (card.marketValue ? formatCollectionMoney(card.marketValue) : valueUnavailable),
  });

  columns.push({
    key: "actions",
    header: t("collections.features.myCollection.ui.ownedCardsSection.column.actions"),
    align: "right",
    cell: (card) =>
      card.manageHref ? (
        <LinkButton href={card.manageHref} tone="secondary" size="sm" leadingIcon="package">
          {t("collections.features.myCollection.ui.ownedCardsSection.action.manage")}
        </LinkButton>
      ) : null,
  });

  return columns;
}

export function OwnedCardsSection({ ownedCards }: { ownedCards: OwnedCardsView }) {
  if (ownedCards.status === "loading") {
    return <CollectionSectionLoading label={t("collections.features.myCollection.ui.ownedCardsSection.loading")} />;
  }

  if (ownedCards.status === "error") {
    return <CollectionSectionError message={t("collections.features.myCollection.ui.ownedCardsSection.error")} />;
  }

  if (ownedCards.status === "empty" || ownedCards.cards.length === 0) {
    return (
      <EmptyState
        icon="cards"
        title={t("collections.features.myCollection.ui.ownedCardsSection.empty.title")}
        description={t("collections.features.myCollection.ui.ownedCardsSection.empty.description")}
      />
    );
  }

  return (
    <Stack gap={4}>
      <Stack gap={1}>
        <Text size="sm" tone="secondary">
          {t("collections.features.myCollection.ui.ownedCardsSection.description")}
        </Text>
        {ownedCards.pricingDegraded ? (
          <CollectionSectionDegraded
            title={t("collections.features.myCollection.ui.overviewSection.pricingDegraded.title")}
            description={t("collections.features.myCollection.ui.overviewSection.pricingDegraded.description")}
          />
        ) : null}
      </Stack>
      <DataTable
        rows={[...ownedCards.cards]}
        columns={buildColumns(ownedCards)}
        getRowId={(card) => card.itemId}
        emptyTitle={t("collections.features.myCollection.ui.ownedCardsSection.empty.title")}
        emptyDescription={t("collections.features.myCollection.ui.ownedCardsSection.empty.description")}
      />
    </Stack>
  );
}
