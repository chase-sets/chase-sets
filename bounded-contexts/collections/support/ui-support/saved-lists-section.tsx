import {
  Badge,
  Button,
  Card,
  EmptyState,
  Form,
  Grid,
  Inline,
  LinkButton,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { formatCollectionMoney, visibilityLabel } from "./formatting";
import { CollectionSectionError, CollectionSectionLoading } from "./section-states";
import { SavedListDetail } from "./saved-list-detail";
import type { MyCollectionHrefs, SavedListSummaryView, SavedListsView } from "./view-models";

function SavedListSummaryCard({ list, href }: { list: SavedListSummaryView; href: string }) {
  return (
    <Card interactive>
      <Card.Header>
        <Inline gap={2} align="center">
          <Card.Title>{list.title}</Card.Title>
          <Badge tone="neutral">{visibilityLabel(list.visibility)}</Badge>
        </Inline>
        {list.description ? <Card.Description>{list.description}</Card.Description> : null}
      </Card.Header>
      <Card.Body>
        <Inline gap={3} align="center" wrap>
          <Text size="sm" tone="secondary">
            {t("collections.features.myCollection.ui.savedListsSection.card.lineCount", {
              count: String(list.lineCount),
            })}
          </Text>
          <Text size="sm" tone="secondary">
            {t("collections.features.myCollection.ui.savedListsSection.card.trackedUnits", {
              count: String(list.trackedUnitCount),
            })}
          </Text>
          {list.estimatedValue ? (
            <Text size="sm" weight="semibold">
              {t("collections.features.myCollection.ui.savedListsSection.card.value.amount", {
                amount: formatCollectionMoney(list.estimatedValue),
              })}
            </Text>
          ) : null}
        </Inline>
      </Card.Body>
      <Card.Footer>
        <LinkButton href={href} tone="secondary" size="sm">
          {t("collections.features.myCollection.ui.savedListsSection.card.open")}
        </LinkButton>
      </Card.Footer>
    </Card>
  );
}

export function SavedListsSection({ lists, hrefs }: { lists: SavedListsView; hrefs: MyCollectionHrefs }) {
  if (lists.selected) {
    return <SavedListDetail detail={lists.selected} editUnavailable={lists.editUnavailable} backHref={hrefs.lists} />;
  }

  if (lists.status === "loading") {
    return <CollectionSectionLoading label={t("collections.features.myCollection.ui.savedListsSection.loading")} />;
  }

  if (lists.status === "error") {
    return <CollectionSectionError message={t("collections.features.myCollection.ui.savedListsSection.error")} />;
  }

  const hasQuery = lists.query.trim().length > 0;

  return (
    <Stack gap={4}>
      <Stack gap={1}>
        <Text size="sm" tone="secondary">
          {t("collections.features.myCollection.ui.savedListsSection.description")}
        </Text>
      </Stack>

      <Inline gap={2} align="end" wrap>
        <Form method="get" spacing="none">
          <Inline gap={2} align="end">
            <TextInput
              name="q"
              label={t("collections.features.myCollection.ui.savedListsSection.search.label")}
              placeholder={t("collections.features.myCollection.ui.savedListsSection.search.placeholder")}
              defaultValue={lists.query}
            />
            <Button type="submit" tone="secondary" size="sm" leadingIcon="search">
              {t("collections.features.myCollection.ui.savedListsSection.search.submit")}
            </Button>
          </Inline>
        </Form>
        <Button type="button" tone="primary" size="sm" leadingIcon="plus" disabled={lists.editUnavailable}>
          {t("collections.features.myCollection.ui.savedListsSection.create")}
        </Button>
      </Inline>

      {lists.lists.length === 0 ? (
        hasQuery ? (
          <EmptyState
            icon="search"
            title={t("collections.features.myCollection.ui.savedListsSection.noResults.title")}
            description={t("collections.features.myCollection.ui.savedListsSection.noResults.description")}
          />
        ) : (
          <EmptyState
            icon="star"
            title={t("collections.features.myCollection.ui.savedListsSection.empty.title")}
            description={t("collections.features.myCollection.ui.savedListsSection.empty.description")}
          />
        )
      ) : (
        <Grid columns={{ base: 1, md: 2, lg: 3 }} gap={4}>
          {lists.lists.map((list) => (
            <SavedListSummaryCard key={list.listId} list={list} href={hrefs.list(list.listId)} />
          ))}
        </Grid>
      )}
    </Stack>
  );
}
