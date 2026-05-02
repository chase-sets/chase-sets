import { t } from "@chase-sets/localization";
import {
  Badge,
  Card,
  DataTable,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { SubmittedOfferListItem } from "./contracts";

function statusTone(status: string) {
  switch (status) {
    case "submitted":
      return "accent";
    default:
      return "neutral";
  }
}

function formatMoney(amount: string) {
  return `$${amount}`;
}

function formatTimestamp(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function MarketplaceSubmittedOfferListPage({
  data,
  errorMessage,
}: {
  data: { items: readonly SubmittedOfferListItem[] };
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.offers.ui.submittedOfferListPage.offers")}
        title={t("marketplace.features.offers.ui.submittedOfferListPage.submitted.offers")}
        description={t("marketplace.features.offers.ui.submittedOfferListPage.review.the.offers.your.account.has")}
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("marketplace.features.offers.ui.submittedOfferListPage.submitted.offers.2")}>
        <DataTable
          rows={[...data.items]}
          getRowId={(row) => row.offer_id}
          columns={[
            {
              key: "item",
              header: t("marketplace.features.offers.ui.submittedOfferListPage.item"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{row.item_title}</Text>
                  {row.item_subtitle ? (
                    <Text tone="secondary" size="sm">
                      {row.item_subtitle}
                    </Text>
                  ) : null}
                  {row.product_summary ? (
                    <Text tone="secondary" size="sm">
                      {row.product_summary}
                    </Text>
                  ) : null}
                </Stack>
              ),
            },
            {
              key: "price",
              header: t("marketplace.features.offers.ui.submittedOfferListPage.offer.price"),
              cell: (row) => formatMoney(row.price_amount),
            },
            {
              key: "quantity",
              header: t("marketplace.features.offers.ui.submittedOfferListPage.quantity"),
              align: "right",
              cell: (row) => row.quantity_requested,
            },
            {
              key: "status",
              header: t("marketplace.features.offers.ui.submittedOfferListPage.status"),
              cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
            },
            {
              key: "updated",
              header: t("marketplace.features.offers.ui.submittedOfferListPage.updated"),
              cell: (row) => formatTimestamp(row.updated_at),
            },
            {
              key: "actions",
              header: t("marketplace.features.offers.ui.submittedOfferListPage.actions"),
              cell: (row) => (
                <LinkButton href={`/account/offers/submitted/${row.offer_id}`} tone="secondary" size="sm">
                  {t("marketplace.features.offers.ui.submittedOfferListPage.open")}</LinkButton>
              ),
            },
          ]}
          emptyTitle={t("marketplace.features.offers.ui.submittedOfferListPage.no.submitted.offers.yet")}
          emptyDescription={t("marketplace.features.offers.ui.submittedOfferListPage.submit.an.offer.from.any.item")}
        />
      </PageSection>
    </Page>
  );
}
