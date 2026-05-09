import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Card,
  DataTable,
  Inline,
  LinkButton,
  MarketplaceDashboardPanel,
  MarketplaceNotice,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@chase-sets/design-system";
import type {
  InventoryImportBatch,
  InventoryImportBatchDetail,
  InventoryImportBatchRow,
} from "../read-model/queries";

function statusTone(status: string) {
  switch (status) {
    case "accepted":
    case "committed":
      return "success";
    case "rejected":
      return "danger";
    default:
      return "neutral";
  }
}

function money(amount: string | null) {
  return amount ? `$${amount}` : t("inventory.features.importBatches.ui.importBatchPage.not.set");
}

function rowOutcome(row: InventoryImportBatchRow) {
  const outcomes = [
    row.committed_inventory_item_id
      ? t("inventory.features.importBatches.ui.importBatchPage.inventory.item.created", {
          id: row.committed_inventory_item_id,
        })
      : null,
    row.committed_listing_id
      ? t("inventory.features.importBatches.ui.importBatchPage.draft.listing.created", {
          id: row.committed_listing_id,
        })
      : null,
  ].filter((entry): entry is string => Boolean(entry));

  return outcomes.length > 0
    ? outcomes.join(" ")
    : t("inventory.features.importBatches.ui.importBatchPage.no.outcome.yet");
}

export function InventoryImportBatchPage({
  batches,
  detail,
  errorMessage,
}: {
  batches: readonly InventoryImportBatch[];
  detail: InventoryImportBatchDetail | null;
  errorMessage?: string | null;
}) {
  const canCommit = Boolean(detail && detail.accepted_count > detail.committed_count);
  const latestBatchId = detail?.batch_id ?? batches[0]?.batch_id ?? null;

  return (
    <Page>
      <PageHeader
        eyebrow={t("inventory.features.importBatches.ui.importBatchPage.seller")}
        title={t("inventory.features.importBatches.ui.importBatchPage.inventory.import")}
        description={t("inventory.features.importBatches.ui.importBatchPage.upload.review.and.commit.csv")}
        actions={
          <Inline>
            <LinkButton href="/account/inventory" tone="secondary">
              {t("inventory.features.importBatches.ui.importBatchPage.inventory")}</LinkButton>
            <LinkButton href="/account/listings" tone="secondary">
              {t("inventory.features.importBatches.ui.importBatchPage.listings")}</LinkButton>
            <LinkButton href="/account/repricing" tone="ghost">
              {t("inventory.features.importBatches.ui.importBatchPage.pricing")}</LinkButton>
          </Inline>
        }
      />

      {errorMessage ? (
        <MarketplaceNotice
          tone="error"
          title={t("inventory.features.importBatches.ui.importBatchPage.import.failed")}
          description={errorMessage}
        />
      ) : null}

      <MarketplaceDashboardPanel
        title={t("inventory.features.importBatches.ui.importBatchPage.batch.summary")}
        description={t("inventory.features.importBatches.ui.importBatchPage.review.row.outcomes.before.creating")}
        metrics={[
          {
            label: t("inventory.features.importBatches.ui.importBatchPage.total.rows"),
            value: detail?.total_count ?? 0,
            detail: t("inventory.features.importBatches.ui.importBatchPage.csv.rows"),
          },
          {
            label: t("inventory.features.importBatches.ui.importBatchPage.accepted"),
            value: detail?.accepted_count ?? 0,
            detail: t("inventory.features.importBatches.ui.importBatchPage.ready.to.commit"),
          },
          {
            label: t("inventory.features.importBatches.ui.importBatchPage.rejected"),
            value: detail?.rejected_count ?? 0,
            detail: t("inventory.features.importBatches.ui.importBatchPage.needs.row.fixes"),
          },
          {
            label: t("inventory.features.importBatches.ui.importBatchPage.committed"),
            value: detail?.committed_count ?? 0,
            detail: t("inventory.features.importBatches.ui.importBatchPage.items.created"),
          },
        ]}
      />

      <PageSection title={t("inventory.features.importBatches.ui.importBatchPage.upload.csv")}>
        <Card>
          <form method="post">
            <Stack gap={3}>
              <input type="hidden" name="intent" value="create-batch" />
              <TextInput
                label={t("inventory.features.importBatches.ui.importBatchPage.source.filename")}
                name="sourceFilename"
                placeholder={t("inventory.features.importBatches.ui.importBatchPage.source.filename.placeholder")}
              />
              <Textarea
                label={t("inventory.features.importBatches.ui.importBatchPage.csv.rows.input")}
                name="csvText"
                rows={8}
                required
                placeholder={t("inventory.features.importBatches.ui.importBatchPage.csv.placeholder")}
                description={t("inventory.features.importBatches.ui.importBatchPage.csv.description")}
              />
              <Inline>
                <Button type="submit">
                  {t("inventory.features.importBatches.ui.importBatchPage.validate.import")}</Button>
                {latestBatchId ? (
                  <LinkButton href={`/account/inventory/imports/${latestBatchId}`} tone="ghost">
                    {t("inventory.features.importBatches.ui.importBatchPage.latest.batch")}</LinkButton>
                ) : null}
              </Inline>
            </Stack>
          </form>
        </Card>
      </PageSection>

      {detail ? (
        <PageSection title={t("inventory.features.importBatches.ui.importBatchPage.review.batch")}>
          <Stack gap={3}>
            {canCommit ? (
              <Card>
                <form method="post">
                  <input type="hidden" name="intent" value="commit-batch" />
                  <input type="hidden" name="batchId" value={detail.batch_id} />
                  <Inline>
                    <Text>
                      {t("inventory.features.importBatches.ui.importBatchPage.accepted.rows.ready", {
                        count: detail.accepted_count - detail.committed_count,
                      })}
                    </Text>
                    <Button type="submit">
                      {t("inventory.features.importBatches.ui.importBatchPage.commit.accepted.rows")}</Button>
                  </Inline>
                </form>
              </Card>
            ) : null}
            <DataTable
              rows={[...detail.rows]}
              getRowId={(row) => row.row_id}
              columns={[
                {
                  key: "row",
                  header: t("inventory.features.importBatches.ui.importBatchPage.row"),
                  cell: (row) => row.row_number,
                },
                {
                  key: "status",
                  header: t("inventory.features.importBatches.ui.importBatchPage.status"),
                  cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
                },
                {
                  key: "catalogItem",
                  header: t("inventory.features.importBatches.ui.importBatchPage.catalog.item"),
                  cell: (row) => (
                    <Stack gap={1}>
                      <Text weight="semibold">{row.catalog_item_id ?? t("inventory.features.importBatches.ui.importBatchPage.not.set")}</Text>
                      <Text size="sm" tone="secondary">
                        {row.product_id ?? t("inventory.features.importBatches.ui.importBatchPage.product.unresolved")}
                      </Text>
                    </Stack>
                  ),
                },
                {
                  key: "quantity",
                  header: t("inventory.features.importBatches.ui.importBatchPage.quantity"),
                  align: "right",
                  cell: (row) => row.total_quantity ?? t("inventory.features.importBatches.ui.importBatchPage.not.set"),
                },
                {
                  key: "listing",
                  header: t("inventory.features.importBatches.ui.importBatchPage.listing.draft"),
                  cell: (row) => (
                    <Stack gap={1}>
                      <Text>{money(row.listing_price_amount)}</Text>
                      <Text size="sm" tone="secondary">
                        {row.listing_quantity_cap
                          ? t("inventory.features.importBatches.ui.importBatchPage.cap.quantity", {
                              quantity: row.listing_quantity_cap,
                            })
                          : t("inventory.features.importBatches.ui.importBatchPage.no.draft")}
                      </Text>
                    </Stack>
                  ),
                },
                {
                  key: "errors",
                  header: t("inventory.features.importBatches.ui.importBatchPage.errors.and.outcomes"),
                  cell: (row) => (
                    <Stack gap={1}>
                      {row.validation_errors.length > 0 ? (
                        row.validation_errors.map((message) => (
                          <Text key={message} size="sm">
                            {message}
                          </Text>
                        ))
                      ) : (
                        <Text size="sm" tone="secondary">{rowOutcome(row)}</Text>
                      )}
                    </Stack>
                  ),
                },
              ]}
              emptyTitle={t("inventory.features.importBatches.ui.importBatchPage.no.rows")}
              emptyDescription={t("inventory.features.importBatches.ui.importBatchPage.upload.csv.to.review.rows")}
            />
          </Stack>
        </PageSection>
      ) : (
        <PageSection title={t("inventory.features.importBatches.ui.importBatchPage.recent.imports")}>
          <DataTable
            rows={[...batches]}
            getRowId={(row) => row.batch_id}
            columns={[
              {
                key: "batch",
                header: t("inventory.features.importBatches.ui.importBatchPage.batch"),
                cell: (row) => (
                  <Stack gap={1}>
                    <Text weight="semibold">{row.source_filename ?? row.batch_id}</Text>
                    <Text size="sm" tone="secondary">
                      {new Date(row.updated_at).toLocaleString()}
                    </Text>
                  </Stack>
                ),
              },
              {
                key: "status",
                header: t("inventory.features.importBatches.ui.importBatchPage.status"),
                cell: (row) => <Badge tone={row.status === "committed" ? "success" : "neutral"}>{row.status}</Badge>,
              },
              {
                key: "accepted",
                header: t("inventory.features.importBatches.ui.importBatchPage.accepted"),
                align: "right",
                cell: (row) => row.accepted_count,
              },
              {
                key: "rejected",
                header: t("inventory.features.importBatches.ui.importBatchPage.rejected"),
                align: "right",
                cell: (row) => row.rejected_count,
              },
              {
                key: "actions",
                header: t("inventory.features.importBatches.ui.importBatchPage.actions"),
                cell: (row) => (
                  <LinkButton href={`/account/inventory/imports/${row.batch_id}`} tone="secondary" size="sm">
                    {t("inventory.features.importBatches.ui.importBatchPage.open")}</LinkButton>
                ),
              },
            ]}
            emptyTitle={t("inventory.features.importBatches.ui.importBatchPage.no.imports.yet")}
            emptyDescription={t("inventory.features.importBatches.ui.importBatchPage.upload.csv.to.start")}
          />
        </PageSection>
      )}
    </Page>
  );
}
