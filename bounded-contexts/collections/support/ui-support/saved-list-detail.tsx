import { useState } from "react";
import {
  Badge,
  BulkActionBar,
  BulkActionSurface,
  Button,
  Cluster,
  type DataColumn,
  DataTable,
  EmptyState,
  Inline,
  LinkButton,
  NumberField,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { SavedListOwnerLineSnapshot } from "../../features/saved-lists/domain";
import { formatCollectionMoney, visibilityLabel } from "./formatting";
import { CollectionSectionDegraded } from "./section-states";
import type { SavedListDetailView, SavedListLineDisplay } from "./view-models";

export type SavedListDetailProps = Readonly<{
  detail: SavedListDetailView;
  /**
   * When true, Saved List edits are shown read-only. On composition roots that
   * have not yet wired the Saved List command service, this stays true so the
   * list remains fully readable. Reversible edits are the only ones a future
   * write wiring applies optimistically.
   */
  editUnavailable: boolean;
  backHref: string;
}>;

const valueUnavailableKey = "collections.features.myCollection.ui.savedListDetail.value.unavailable";

function AvailabilityBadge({ display }: { display: SavedListLineDisplay }) {
  if (display.availability === "retired") {
    return (
      <Badge tone="warning">{t("collections.features.myCollection.ui.savedListDetail.availability.retired")}</Badge>
    );
  }
  if (display.availability === "missing") {
    return (
      <Badge tone="danger">{t("collections.features.myCollection.ui.savedListDetail.availability.missing")}</Badge>
    );
  }
  return null;
}

export function SavedListDetail({ detail, editUnavailable, backHref }: SavedListDetailProps) {
  const { snapshot } = detail;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const displayFor = (lineId: string): SavedListLineDisplay | undefined =>
    detail.lineDisplay[lineId as keyof typeof detail.lineDisplay];

  const columns: DataColumn<SavedListOwnerLineSnapshot>[] = [
    {
      key: "card",
      header: t("collections.features.myCollection.ui.savedListDetail.column.card"),
      cell: (line) => {
        const display = displayFor(line.lineId);
        return (
          <Stack gap={1} minWidth="0">
            <Text weight="semibold">{display?.title ?? line.product.productId}</Text>
            {display?.subtitle ? (
              <Text size="sm" tone="secondary">
                {display.subtitle}
              </Text>
            ) : null}
            {display ? <AvailabilityBadge display={display} /> : null}
          </Stack>
        );
      },
    },
    {
      key: "trackedQuantity",
      header: t("collections.features.myCollection.ui.savedListDetail.column.trackedQuantity"),
      align: "right",
      cell: (line) => (
        <NumberField
          name="trackedQuantity"
          label={t("collections.features.myCollection.ui.savedListDetail.column.trackedQuantity")}
          hideLabel
          defaultValue={line.trackedQuantity}
          min={0}
          disabled={editUnavailable}
        />
      ),
    },
    {
      key: "notes",
      header: t("collections.features.myCollection.ui.savedListDetail.column.notes"),
      cell: (line) => (
        <TextInput
          name="privateNotes"
          label={t("collections.features.myCollection.ui.savedListDetail.column.notes")}
          hideLabel
          defaultValue={line.privateNotes ?? ""}
          placeholder={t("collections.features.myCollection.ui.savedListDetail.empty.notes")}
          disabled={editUnavailable}
        />
      ),
    },
    {
      key: "tags",
      header: t("collections.features.myCollection.ui.savedListDetail.column.tags"),
      cell: (line) => (
        <TextInput
          name="privateTags"
          label={t("collections.features.myCollection.ui.savedListDetail.column.tags")}
          hideLabel
          defaultValue={line.privateTags.join(", ")}
          placeholder={t("collections.features.myCollection.ui.savedListDetail.empty.tags")}
          disabled={editUnavailable}
        />
      ),
    },
    {
      key: "value",
      header: t("collections.features.myCollection.ui.savedListDetail.column.value"),
      align: "right",
      cell: (line) => {
        const display = displayFor(line.lineId);
        return display?.estimatedValue ? formatCollectionMoney(display.estimatedValue) : t(valueUnavailableKey);
      },
    },
    {
      key: "order",
      header: t("collections.features.myCollection.ui.savedListDetail.column.order"),
      align: "right",
      cell: (line) => (
        <Inline gap={1} align="center">
          <Button type="button" tone="ghost" size="sm" disabled={editUnavailable || line.position === 0}>
            {t("collections.features.myCollection.ui.savedListDetail.moveUp")}
          </Button>
          <Button
            type="button"
            tone="ghost"
            size="sm"
            disabled={editUnavailable || line.position >= snapshot.lines.length - 1}
          >
            {t("collections.features.myCollection.ui.savedListDetail.moveDown")}
          </Button>
        </Inline>
      ),
    },
  ];

  return (
    <Stack gap={4}>
      <Cluster gap={2} align="center">
        <LinkButton href={backHref} tone="ghost" size="sm">
          {t("collections.features.myCollection.ui.savedListDetail.back")}
        </LinkButton>
        <Inline gap={2} align="center">
          <Text size="sm" tone="secondary">
            {t("collections.features.myCollection.ui.savedListDetail.value")}
          </Text>
          <Text weight="semibold">
            {detail.estimatedValue ? formatCollectionMoney(detail.estimatedValue) : t(valueUnavailableKey)}
          </Text>
        </Inline>
      </Cluster>

      <Stack gap={1}>
        <Inline gap={2} align="center">
          <Text size="lg" weight="semibold">
            {snapshot.title}
          </Text>
          <Badge tone="neutral">{visibilityLabel(snapshot.visibility)}</Badge>
        </Inline>
        {snapshot.description ? (
          <Text size="sm" tone="secondary">
            {snapshot.description}
          </Text>
        ) : null}
        <Text size="sm" tone="secondary">
          {t("collections.features.myCollection.ui.savedListDetail.trackedUnits", {
            count: String(snapshot.membership.trackedUnitCount),
          })}
        </Text>
      </Stack>

      {editUnavailable ? (
        <CollectionSectionDegraded
          title={t("collections.features.myCollection.ui.savedListDetail.editUnavailable.title")}
          description={t("collections.features.myCollection.ui.savedListDetail.editUnavailable.description")}
        />
      ) : null}

      <Cluster gap={2} align="end">
        <Inline gap={2} align="end">
          <TextInput
            name="productId"
            label={t("collections.features.myCollection.ui.savedListDetail.add.label")}
            placeholder={t("collections.features.myCollection.ui.savedListDetail.add.placeholder")}
            disabled={editUnavailable}
          />
          <Button type="button" tone="primary" size="sm" leadingIcon="plus" disabled={editUnavailable}>
            {t("collections.features.myCollection.ui.savedListDetail.add.submit")}
          </Button>
        </Inline>
        <Inline gap={2} align="center">
          <Button type="button" tone="secondary" size="sm" leadingIcon="share" disabled={editUnavailable}>
            {t("collections.features.myCollection.ui.savedListDetail.share")}
          </Button>
          <Button type="button" tone="ghost" size="sm" leadingIcon="trash" disabled={editUnavailable}>
            {t("collections.features.myCollection.ui.savedListDetail.archive")}
          </Button>
        </Inline>
      </Cluster>

      {snapshot.lines.length === 0 ? (
        <EmptyState
          icon="cards"
          title={t("collections.features.myCollection.ui.savedListDetail.empty.title")}
          description={t("collections.features.myCollection.ui.savedListDetail.empty.description")}
        />
      ) : (
        <BulkActionSurface>
          <DataTable
            rows={[...snapshot.lines]}
            columns={columns}
            getRowId={(line) => line.lineId}
            selectedKeys={selected}
            onSelectionChange={setSelected}
            emptyTitle={t("collections.features.myCollection.ui.savedListDetail.empty.title")}
            emptyDescription={t("collections.features.myCollection.ui.savedListDetail.empty.description")}
          />
          {selected.size > 0 ? (
            <BulkActionBar
              count={selected.size}
              formatSelectedLabel={(count) =>
                t("collections.features.myCollection.ui.savedListDetail.bulk.selected", { count: String(count) })
              }
              overflowLabel={t("collections.features.myCollection.ui.savedListDetail.bulk.moreLabel")}
              primaryActions={
                <Button type="button" tone="danger" size="sm" leadingIcon="trash" disabled={editUnavailable}>
                  {t("collections.features.myCollection.ui.savedListDetail.bulk.remove")}
                </Button>
              }
            />
          ) : null}
        </BulkActionSurface>
      )}
    </Stack>
  );
}
