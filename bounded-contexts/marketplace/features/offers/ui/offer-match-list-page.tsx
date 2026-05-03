import { t } from "@chase-sets/localization";
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
import type { OfferMatchListItem } from "./contracts";
import type { MarketplaceListingTermsPreview } from "../../listings/ui/contracts";

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

function termsSource(terms: MarketplaceListingTermsPreview) {
  return terms.agreement_id ?? terms.schedule_id ?? t("marketplace.features.offers.ui.offerMatchListPage.standard.terms");
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

export function MarketplaceOfferMatchListPage({
  data,
  cartData,
  cartTermsByOfferId,
  errorMessage,
}: {
  data: { items: readonly OfferMatchListItem[] };
  cartData?: { items: readonly OfferMatchListItem[] };
  cartTermsByOfferId?: Readonly<Record<string, MarketplaceListingTermsPreview>>;
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.offers.ui.offerMatchListPage.inventory")}
        title={t("marketplace.features.offers.ui.offerMatchListPage.offer.matches")}
        description={t("marketplace.features.offers.ui.offerMatchListPage.review.offer.matches.that.currently.match")}
        actions={
          <LinkButton href="/account/listings" tone="secondary">
            {t("marketplace.features.offers.ui.offerMatchListPage.view.listings")}</LinkButton>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("marketplace.features.offers.ui.offerMatchListPage.sell.list")}>
        <Card>
          <Stack gap={3}>
            <Text tone="secondary" size="sm">
              {cartData?.items.length ?? 0} offer
              {(cartData?.items.length ?? 0) === 1 ? "" : "s"} {t("marketplace.features.offers.ui.offerMatchListPage.queued.in.your.sell.list")}</Text>
            {cartData?.items.length ? (
              <Stack gap={2}>
                {cartData.items.map((item) => {
                  const terms = cartTermsByOfferId?.[item.offer_id] ?? null;

                  return (
                    <Stack key={item.offer_id} gap={1}>
                      <Text size="sm" weight="semibold">{item.item_title}</Text>
                      <Text size="sm" tone="secondary">
                        {t("marketplace.features.offers.ui.offerMatchListPage.sell.list.offer.price", {
                          price: formatMoney(item.price_amount),
                        })}
                      </Text>
                      {terms ? (
                        <>
                          <Text size="sm" tone="secondary">
                            {t("marketplace.features.offers.ui.offerMatchListPage.sell.list.marketplace.fee", {
                              amount: formatMoney(terms.marketplace_sales_fee_unit_amount),
                            })}
                          </Text>
                          <Text size="sm" tone="secondary">
                            {t("marketplace.features.offers.ui.offerMatchListPage.sell.list.seller.net", {
                              amount: formatMoney(terms.seller_net_unit_amount),
                            })}
                          </Text>
                          <Text size="sm" tone="secondary">
                            {t("marketplace.features.offers.ui.offerMatchListPage.sell.list.terms.source", {
                              source: termsSource(terms),
                            })}
                          </Text>
                          <Text size="sm" tone="secondary">
                            {t("marketplace.features.offers.ui.offerMatchListPage.sell.list.quote.time", {
                              time: new Date(terms.resolved_at).toLocaleString(),
                            })}
                          </Text>
                        </>
                      ) : null}
                    </Stack>
                  );
                })}
              </Stack>
            ) : null}
            <form method="post">
              {cartData?.items.map((item) => (
                <input
                  key={item.offer_id}
                  type="hidden"
                  name={`feeQuoteFingerprint:${item.offer_id}`}
                  value={
                    cartTermsByOfferId?.[item.offer_id]?.fee_quote_fingerprint ?? ""
                  }
                />
              ))}
              <Button
                type="submit"
                name="intent"
                value="accept-sell-list"
                disabled={!cartData || cartData.items.length === 0}
              >
                {t("marketplace.features.offers.ui.offerMatchListPage.accept.sell.list")}</Button>
            </form>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title={t("marketplace.features.offers.ui.offerMatchListPage.offer.matches.2")}>
        <DataTable
          rows={[...data.items]}
          getRowId={(row) => row.offer_id}
          columns={[
            {
              key: "item",
              header: t("marketplace.features.offers.ui.offerMatchListPage.item"),
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
              header: t("marketplace.features.offers.ui.offerMatchListPage.buyer"),
              cell: (row) => row.buyer_display_name ?? row.buyer_account_id,
            },
            {
              key: "price",
              header: t("marketplace.features.offers.ui.offerMatchListPage.offer.price"),
              cell: (row) => formatMoney(row.price_amount),
            },
            {
              key: "quantity",
              header: t("marketplace.features.offers.ui.offerMatchListPage.quantity"),
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
              header: t("marketplace.features.offers.ui.offerMatchListPage.status"),
              cell: (row) => (
                <Stack gap={1}>
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  <Badge tone={row.can_fulfill ? "success" : "warning"}>
                    {row.can_fulfill ? t("marketplace.features.offers.ui.offerMatchListPage.can.fulfill") : t("marketplace.features.offers.ui.offerMatchListPage.needs.supply")}
                  </Badge>
                  {row.in_sell_list ? <Badge tone="accent">{t("marketplace.features.offers.ui.offerMatchListPage.in.sell.list")}</Badge> : null}
                </Stack>
              ),
            },
            {
              key: "updated",
              header: t("marketplace.features.offers.ui.offerMatchListPage.updated"),
              cell: (row) => formatTimestamp(row.updated_at),
            },
            {
              key: "actions",
              header: t("marketplace.features.offers.ui.offerMatchListPage.actions"),
              cell: (row) => (
                <LinkButton href={`/account/offers/matches/${row.offer_id}`} tone="secondary" size="sm">
                  {t("marketplace.features.offers.ui.offerMatchListPage.open")}</LinkButton>
              ),
            },
          ]}
          emptyTitle={t("marketplace.features.offers.ui.offerMatchListPage.no.offer.matches")}
          emptyDescription={t("marketplace.features.offers.ui.offerMatchListPage.offer.matches.appear.here.when.submitted")}
        />
      </PageSection>
    </Page>
  );
}
