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
import type { SubmittedBuyerOfferListItem } from "./contracts";

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

export function MarketplaceSubmittedBuyerOfferListPage({
  data,
  errorMessage,
}: {
  data: { items: readonly SubmittedBuyerOfferListItem[] };
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Buyer"
        title="Submitted Buyer Offers"
        description="Review the buyer offers your account has submitted."
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Submitted Buyer Offers">
        <DataTable
          rows={[...data.items]}
          getRowId={(row) => row.offer_id}
          columns={[
            {
              key: "item",
              header: "Item",
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
              header: "Buyer Offer Price",
              cell: (row) => formatMoney(row.price_amount),
            },
            {
              key: "quantity",
              header: "Quantity",
              align: "right",
              cell: (row) => row.quantity_requested,
            },
            {
              key: "status",
              header: "Status",
              cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
            },
            {
              key: "updated",
              header: "Updated",
              cell: (row) => formatTimestamp(row.updated_at),
            },
            {
              key: "actions",
              header: "Actions",
              cell: (row) => (
                <LinkButton href={`/account/submitted-buyer-offers/${row.offer_id}`} tone="secondary" size="sm">
                  Open
                </LinkButton>
              ),
            },
          ]}
          emptyTitle="No submitted buyer offers yet"
          emptyDescription="Submit a buyer offer from any item detail page to start tracking buyer demand."
        />
      </PageSection>
    </Page>
  );
}
