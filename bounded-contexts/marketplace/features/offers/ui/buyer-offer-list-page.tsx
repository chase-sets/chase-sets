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
import type { MarketplaceOfferListItem } from "./contracts";

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

export function MarketplaceBuyerOfferListPage({
  data,
  errorMessage,
}: {
  data: { items: readonly MarketplaceOfferListItem[] };
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Buyer"
        title="Offers"
        description="Review the marketplace-wide offers your account has submitted."
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Offer History">
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
                  {row.version_summary ? (
                    <Text tone="secondary" size="sm">
                      {row.version_summary}
                    </Text>
                  ) : null}
                </Stack>
              ),
            },
            {
              key: "price",
              header: "Offer Price",
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
                <LinkButton href={`/account/offers/${row.offer_id}`} tone="secondary" size="sm">
                  Open
                </LinkButton>
              ),
            },
          ]}
          emptyTitle="No offers yet"
          emptyDescription="Submit a marketplace-wide offer from any item detail page to start tracking buyer demand."
        />
      </PageSection>
    </Page>
  );
}
