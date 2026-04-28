import {
  Badge,
  Button,
  Card,
  DataTable,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { MarketplaceSellerOfferListItem } from "./contracts";

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

export function MarketplaceSellerOfferListPage({
  data,
  cartData,
  errorMessage,
}: {
  data: { items: readonly MarketplaceSellerOfferListItem[] };
  cartData?: { items: readonly MarketplaceSellerOfferListItem[] };
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Seller"
        title="Market Offers"
        description="Review marketplace-wide demand that currently matches your active listings."
        actions={
          <LinkButton href="/account/listings" tone="secondary">
            View listings
          </LinkButton>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Sell List">
        <Card>
          <Stack gap={3}>
            <Text tone="secondary" size="sm">
              {cartData?.items.length ?? 0} offer
              {(cartData?.items.length ?? 0) === 1 ? "" : "s"} queued for seller review.
            </Text>
            <form method="post">
              <Button
                type="submit"
                name="intent"
                value="accept-sell-list"
                disabled={!cartData || cartData.items.length === 0}
              >
                Accept sell list
              </Button>
            </form>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title="Matching Demand">
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
              key: "buyer",
              header: "Buyer",
              cell: (row) => row.buyer_display_name ?? row.buyer_account_id,
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
              cell: (row) => (
                <Stack gap={1}>
                  <Text>{row.quantity_requested}</Text>
                  <Text size="sm" tone="secondary">
                    {row.seller_available_quantity} available
                  </Text>
                </Stack>
              ),
            },
            {
              key: "status",
              header: "Status",
              cell: (row) => (
                <Stack gap={1}>
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  <Badge tone={row.can_fulfill ? "success" : "warning"}>
                    {row.can_fulfill ? "Can fulfill" : "Needs supply"}
                  </Badge>
                  {row.in_sell_list ? <Badge tone="accent">In sell list</Badge> : null}
                </Stack>
              ),
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
                <LinkButton href={`/account/market-offers/${row.offer_id}`} tone="secondary" size="sm">
                  Open
                </LinkButton>
              ),
            },
          ]}
          emptyTitle="No matching offers"
          emptyDescription="Marketplace-wide demand appears here when buyers submit offers for Products you actively list."
        />
      </PageSection>
    </Page>
  );
}
