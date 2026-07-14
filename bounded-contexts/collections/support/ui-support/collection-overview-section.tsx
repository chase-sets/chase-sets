import { Card, EmptyState, Stack, Stat, StatGrid, Text } from "@chase-sets/design-system";
import { formatDateTime, t } from "@chase-sets/localization";
import { formatCollectionMoney } from "./formatting";
import { CollectionSectionDegraded, CollectionSectionError, CollectionSectionLoading } from "./section-states";
import type { CollectionActivityEntry, CollectionOverviewView } from "./view-models";

function activityLabel(entry: CollectionActivityEntry): string {
  switch (entry.kind) {
    case "owned-card-added":
      return t("collections.features.myCollection.ui.overviewSection.activity.ownedCardAdded", {
        subject: entry.subject,
      });
    case "owned-card-updated":
      return t("collections.features.myCollection.ui.overviewSection.activity.ownedCardUpdated", {
        subject: entry.subject,
      });
    case "list-created":
      return t("collections.features.myCollection.ui.overviewSection.activity.listCreated", {
        subject: entry.subject,
      });
    case "list-updated":
      return t("collections.features.myCollection.ui.overviewSection.activity.listUpdated", {
        subject: entry.subject,
      });
  }
}

export function CollectionOverviewSection({ overview }: { overview: CollectionOverviewView }) {
  if (overview.status === "loading") {
    return (
      <CollectionSectionLoading label={t("collections.features.myCollection.ui.overviewSection.loading")} rows={3} />
    );
  }

  if (overview.status === "error") {
    return <CollectionSectionError message={t("collections.features.myCollection.ui.overviewSection.error")} />;
  }

  if (overview.status === "empty") {
    return (
      <EmptyState
        icon="cards"
        title={t("collections.features.myCollection.ui.overviewSection.empty.title")}
        description={t("collections.features.myCollection.ui.overviewSection.empty.description")}
      />
    );
  }

  const valueUnavailable = t("collections.features.myCollection.ui.overviewSection.value.unavailable");

  return (
    <Stack gap={4}>
      {overview.pricingDegraded ? (
        <CollectionSectionDegraded
          title={t("collections.features.myCollection.ui.overviewSection.pricingDegraded.title")}
          description={t("collections.features.myCollection.ui.overviewSection.pricingDegraded.description")}
        />
      ) : null}

      <StatGrid columns={{ base: 1, sm: 2, lg: 4 }}>
        <Stat
          icon="wallet"
          label={t("collections.features.myCollection.ui.overviewSection.stat.totalValue")}
          value={overview.totalValue ? formatCollectionMoney(overview.totalValue) : valueUnavailable}
        />
        <Stat
          icon="cards"
          label={t("collections.features.myCollection.ui.overviewSection.stat.ownedCards")}
          value={String(overview.ownedCardCount)}
          trend={t("collections.features.myCollection.ui.overviewSection.stat.ownedUnits.trend", {
            count: String(overview.ownedUnitCount),
          })}
        />
        <Stat
          icon="star"
          label={t("collections.features.myCollection.ui.overviewSection.stat.savedLists")}
          value={String(overview.savedListCount)}
        />
        <Stat
          icon="chart"
          label={t("collections.features.myCollection.ui.overviewSection.stat.pricedCoverage")}
          value={
            overview.pricedCoveragePercent === null
              ? valueUnavailable
              : t("collections.features.myCollection.ui.overviewSection.coverage.value", {
                  percent: String(overview.pricedCoveragePercent),
                })
          }
        />
      </StatGrid>

      <Card>
        <Card.Header>
          <Card.Title>{t("collections.features.myCollection.ui.overviewSection.activity.title")}</Card.Title>
        </Card.Header>
        <Card.Body>
          {overview.recentActivity.length === 0 ? (
            <Text size="sm" tone="secondary">
              {t("collections.features.myCollection.ui.overviewSection.activity.empty")}
            </Text>
          ) : (
            <Stack gap={2} as="ul">
              {overview.recentActivity.map((entry) => (
                <Stack key={entry.id} as="li" gap={1}>
                  <Text size="sm">{activityLabel(entry)}</Text>
                  <Text size="xs" tone="secondary">
                    {formatDateTime(entry.occurredAt)}
                  </Text>
                </Stack>
              ))}
            </Stack>
          )}
        </Card.Body>
      </Card>
    </Stack>
  );
}
