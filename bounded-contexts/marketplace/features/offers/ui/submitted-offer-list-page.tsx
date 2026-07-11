import { formatDate, formatMoney, t } from "@chase-sets/localization";
import {
  AccountReputationSummary,
  Badge,
  Grid,
  LinkButton,
  MarketplaceEmptyState,
  MarketplaceNotice,
  OfferCard,
  Page,
  PageHeader,
  PageSection,
  ProductOptions,
  Stack,
  Text,
  productOptionsFromSummary,
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
        <MarketplaceNotice
          tone="danger"
          title={t("marketplace.features.offers.ui.submittedOfferListPage.offer.status.issue")}
          description={errorMessage}
        />
      ) : null}

      <PageSection title={t("marketplace.features.offers.ui.submittedOfferListPage.submitted.offers.2")}>
        {data.items.length === 0 ? (
          <MarketplaceEmptyState
            title={t("marketplace.features.offers.ui.submittedOfferListPage.no.submitted.offers.yet")}
            description={t("marketplace.features.offers.ui.submittedOfferListPage.submit.an.offer.from.any.item")}
            recoveryActions={
              <LinkButton href="/" tone="secondary">
                {t("marketplace.features.offers.ui.submittedOfferListPage.browse.marketplace")}
              </LinkButton>
            }
          />
        ) : (
          <Grid columns={{ base: 1, xl: 2 }} gap={3}>
            {data.items.map((offer) => {
              return (
                <OfferCard
                  key={offer.offer_id}
                  title={offer.item_title}
                  amount={formatMoney(offer.price_amount, "USD")}
                  status={<Badge tone={statusTone(offer.status)}>{offer.status}</Badge>}
                  details={
                    <Stack gap={2}>
                      {offer.item_subtitle ? <Text size="sm">{offer.item_subtitle}</Text> : null}
                      {offer.product_summary ? (
                        <ProductOptions options={productOptionsFromSummary(offer.product_summary)} variant="chips" />
                      ) : null}
                      <Text size="sm" tone="secondary">
                        {t("marketplace.features.offers.ui.submittedOfferListPage.quantity.requested", {
                          quantity: offer.quantity_requested,
                        })}
                      </Text>
                      {offer.accepted_seller_account_id && offer.status === "accepted" ? (
                        <AccountReputationSummary
                          accountName={offer.accepted_seller_account_id}
                          averageRating={offer.accepted_seller_average_rating}
                          reviewCount={offer.accepted_seller_review_count ?? 0}
                          ratingLabel={t("marketplace.features.offers.ui.submittedOfferListPage.seller.reputation")}
                        />
                      ) : null}
                      <Text size="sm" tone="secondary">
                        {t("marketplace.features.offers.ui.submittedOfferListPage.updated.on", {
                          date: formatDate(offer.updated_at),
                        })}
                      </Text>
                    </Stack>
                  }
                  actions={
                    <LinkButton href={`/account/offers/submitted/${offer.offer_id}`} tone="secondary" size="sm">
                      {t("marketplace.features.offers.ui.submittedOfferListPage.open")}
                    </LinkButton>
                  }
                />
              );
            })}
          </Grid>
        )}
      </PageSection>
    </Page>
  );
}
