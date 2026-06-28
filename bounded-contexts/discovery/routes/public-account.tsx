import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import {
  OrderProtectionModule,
  Card,
  Container,
  Grid,
  ListingCard,
  LinkButton,
  MarketplaceEmptyState,
  AccountCredibilityHeader,
  Box,
  PageSection,
  ProductOptions,
  RatingSummary,
  Stack,
  Text,
  formatProductImageAltText,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import { createDiscoveryRequestApiClient, DiscoveryApiError } from "../support/request-support/api-client";
import { discoveryAssetUrls } from "../support/client-support/assets";
import { applyDiscoveryPublicAccountPatch } from "../support/client-support/realtime-market";
import { discoveryRealtimeRouteTopics } from "../support/realtime-support/topics";

function formatMoney(value: string): string {
  return `$${value}`;
}

function parseRating(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const rating = Number(value);
  return Number.isFinite(rating) ? rating : null;
}

function buyerFulfillmentLabel(shipFromCode: string | null) {
  if (!shipFromCode) {
    return t("discovery.routes.publicAccount.fulfillment.confirmed.at.checkout");
  }

  const normalized = shipFromCode.toUpperCase();
  if (normalized.startsWith("STL")) {
    return t("discovery.routes.publicAccount.ships.from", {
      shipFrom: "St. Louis, MO",
    });
  }
  if (normalized.startsWith("CHI")) {
    return t("discovery.routes.publicAccount.ships.from", {
      shipFrom: "Chicago, IL",
    });
  }

  return t("discovery.routes.publicAccount.account.fulfillment.center");
}

function purchaseLimitLabel(listing: {
  max_units_per_order?: number | null;
  max_units_per_day?: number | null;
  max_units_per_customer_account?: number | null;
}) {
  if (listing.max_units_per_customer_account) {
    return `Limit ${listing.max_units_per_customer_account} per customer`;
  }
  if (listing.max_units_per_day) {
    return `Limit ${listing.max_units_per_day} per day`;
  }
  if (listing.max_units_per_order) {
    return `Limit ${listing.max_units_per_order} per order`;
  }
  return null;
}

function formatReviewDate(value: string | null | undefined) {
  if (!value) {
    return null;
  }

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

export async function loader({ request, params }: LoaderFunctionArgs) {
  const slug = params.accountSlug;

  if (!slug) {
    return { account: null, notFound: true, canonicalUrl: null };
  }

  try {
    const account = await createDiscoveryRequestApiClient(request).getPublicAccountBySlug(slug);
    const url = new URL(request.url);

    if (account.account_slug && slug !== account.account_slug) {
      throw redirect(`/accounts/${account.account_slug}${url.search}`, { status: 301 });
    }

    return {
      account,
      notFound: false,
      canonicalUrl: new URL(`/accounts/${account.account_slug}`, url.origin).toString(),
    };
  } catch (error) {
    if (error instanceof DiscoveryApiError) {
      return { account: null, notFound: true, canonicalUrl: null };
    }

    throw error;
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  ...buildOpenGraphMeta({
    title: data?.account
      ? t("discovery.routes.publicAccount.account.meta.title", {
          accountName: data.account.account_display_name ?? t("discovery.routes.publicAccount.account"),
        })
      : t("discovery.routes.publicAccount.account.not.found.marketplace"),
    description: data?.account
      ? t("discovery.routes.publicAccount.browse.active.listings", {
          count: data.account.active_listing_count,
        })
      : t("discovery.routes.publicAccount.this.marketplace.account.is.not.available"),
  }),
  ...(data?.canonicalUrl ? [{ tagName: "link", rel: "canonical", href: data.canonicalUrl }] : []),
];

export default function PublicAccountRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <PublicAccountRealtimeView
      key={[
        data.account?.account_id ?? "empty",
        data.account?.active_listing_count ?? 0,
        data.account?.listings.map((listing) => listing.listing_id).join("|") ?? "",
      ].join("\n")}
      data={data}
    />
  );
}

function PublicAccountRealtimeView({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  const account = useRealtimePatchedSnapshot({
    initialSnapshot: data.account,
    snapshotKey: JSON.stringify(data.account),
    topics: data.account ? discoveryRealtimeRouteTopics.publicAccount(data.account.account_id).topics : [],
    applyPatch: applyDiscoveryPublicAccountPatch,
    onSyncRequired: reloadForRealtimeSync,
  });

  if (!account) {
    return (
      <Container width="content">
        <PageSection title={t("discovery.routes.publicAccount.account.not.found")}>
          <Text>{t("discovery.routes.publicAccount.this.account.is.not.available.right")}</Text>
        </PageSection>
      </Container>
    );
  }
  const accountRating = parseRating(account.average_rating);
  const accountReviewCount = account.review_count ?? 0;
  const reputationValue =
    accountRating !== null && accountReviewCount > 0 ? (
      <RatingSummary value={accountRating} count={accountReviewCount} compact />
    ) : (
      t("discovery.routes.publicAccount.no.feedback.yet")
    );

  return (
    <Container width="expanded">
      <Stack gap={6}>
        <AccountCredibilityHeader
          name={account.account_display_name ?? t("discovery.routes.publicAccount.account")}
          verification={
            account.status === "active"
              ? t("discovery.routes.publicAccount.verified.account")
              : t("discovery.routes.publicAccount.building.trust")
          }
          summary={
            account.active_listing_count > 0
              ? t("discovery.routes.publicAccount.verified.marketplace.account.profile")
              : t("discovery.routes.publicAccount.new.account.protected.checkout")
          }
          facts={[
            {
              label: t("discovery.routes.publicAccount.active.listings"),
              value: account.active_listing_count,
            },
            {
              label: t("discovery.routes.publicAccount.review.history"),
              value: reputationValue,
            },
            {
              label: t("discovery.routes.publicAccount.response.time"),
              value: t("discovery.routes.publicAccount.responds.through.order.updates"),
            },
            {
              label: t("discovery.routes.publicAccount.profile.updated"),
              value: new Intl.DateTimeFormat("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              }).format(new Date(account.updated_at)),
            },
          ]}
          policies={[
            {
              label: t("discovery.routes.publicAccount.buyer.protection"),
              value: t("discovery.routes.publicAccount.buyer.protection.description"),
            },
            {
              label: t("discovery.routes.publicAccount.return.refund.policy"),
              value: t("discovery.routes.publicAccount.policies.confirmed.before.payment"),
            },
          ]}
          contactAction={
            <LinkButton href="/sign-in?returnTo=%2Faccount%2Fmessages" tone="secondary">
              {t("discovery.routes.publicAccount.sign.in.to.contact.account")}
            </LinkButton>
          }
          reportAction={
            <LinkButton href="/support" tone="ghost">
              {t("discovery.routes.publicAccount.report.account")}
            </LinkButton>
          }
        />

        <Box id="feedback">
          <PageSection title={t("discovery.routes.publicAccount.feedback")}>
            <Stack gap={3}>
              <Text>
                {accountRating !== null && accountReviewCount > 0
                  ? t("discovery.routes.publicAccount.feedback.summary", {
                      rating: accountRating.toFixed(1),
                      count: accountReviewCount,
                    })
                  : t("discovery.routes.publicAccount.no.feedback.yet")}
              </Text>
              {account.recent_reviews.length > 0 ? (
                <Stack gap={2}>
                  {account.recent_reviews.map((review) => {
                    const reviewDate = formatReviewDate(review.submitted_at ?? review.updated_at);
                    return (
                      <Card key={review.review_id}>
                        <Stack gap={2}>
                          <RatingSummary value={review.rating} compact />
                          <Text size="sm" weight="semibold">
                            {reviewDate
                              ? t("discovery.routes.publicAccount.review.byline", {
                                  author:
                                    review.author_display_name ?? t("discovery.routes.publicAccount.marketplace.buyer"),
                                  date: reviewDate,
                                })
                              : (review.author_display_name ?? t("discovery.routes.publicAccount.marketplace.buyer"))}
                          </Text>
                          <Text size="sm" tone="secondary">
                            {review.feedback ?? t("discovery.routes.publicAccount.no.written.feedback")}
                          </Text>
                        </Stack>
                      </Card>
                    );
                  })}
                </Stack>
              ) : (
                <Text size="sm" tone="secondary">
                  {t("discovery.routes.publicAccount.no.written.feedback")}
                </Text>
              )}
            </Stack>
          </PageSection>
        </Box>

        <OrderProtectionModule
          title={t("discovery.routes.publicAccount.buyer.confidence")}
          items={[
            {
              title: t("discovery.routes.publicAccount.verified.account.status"),
              description: t("discovery.routes.publicAccount.verified.account.status.description"),
            },
            {
              title: t("discovery.routes.publicAccount.clear.listing.details"),
              description: t("discovery.routes.publicAccount.clear.listing.details.description"),
            },
            {
              title: t("discovery.routes.publicAccount.secure.checkout"),
              description: t("discovery.routes.publicAccount.secure.checkout.description"),
            },
          ]}
        />

        {account.listings.length > 0 ? (
          <Grid columns={{ base: 1, lg: 2 }} gap={4}>
            {account.listings.map((listing) => {
              const availability = t("discovery.routes.publicAccount.quantity.available", {
                quantity: listing.visible_quantity,
              });
              const limitLabel = purchaseLimitLabel(listing);
              const availabilityDetail = limitLabel ? `${availability} | ${limitLabel}` : availability;
              return (
                <ListingCard
                  key={listing.listing_id}
                  title={listing.item_title ?? t("discovery.routes.publicAccount.marketplace.listing")}
                  imageSrc={discoveryAssetUrls.defaultProductImage}
                  imageAlt={formatProductImageAltText({
                    title: listing.item_title,
                    options: productOptionsFromSummary(listing.product_summary),
                    fallback: t("discovery.routes.publicAccount.pokemon.card.back"),
                  })}
                  price={formatMoney(listing.price_amount)}
                  priceDetail={availabilityDetail}
                  sellerName={account.account_display_name ?? t("discovery.routes.publicAccount.account")}
                  sellerHref={`/accounts/${account.account_slug}#feedback`}
                  sellerTrustLabel={
                    accountRating !== null && accountReviewCount > 0
                      ? t("discovery.routes.publicAccount.reputation.rating", {
                          rating: accountRating.toFixed(1),
                          count: accountReviewCount,
                        })
                      : account.status === "active"
                        ? t("discovery.routes.publicAccount.verified.account")
                        : t("discovery.routes.publicAccount.account.details.visible")
                  }
                  sellerVerified={account.status === "active"}
                  rating={accountRating ?? undefined}
                  reviewCount={accountReviewCount}
                  fulfillment={buyerFulfillmentLabel(listing.ship_from_code)}
                  availability={availabilityDetail}
                  condition={
                    listing.product_summary ? (
                      <ProductOptions options={productOptionsFromSummary(listing.product_summary)} variant="compact" />
                    ) : (
                      t("discovery.routes.publicAccount.standard.product")
                    )
                  }
                  valueCue={t("discovery.routes.publicAccount.price.quantity.and.account.visible")}
                  protection={t("discovery.routes.publicAccount.buyer.protected")}
                  primaryAction={
                    <LinkButton href={`/listings/${listing.listing_slug}`} size="sm">
                      {t("discovery.routes.publicAccount.view.listing")}
                    </LinkButton>
                  }
                  secondaryAction={
                    <LinkButton
                      href={`/items/${listing.catalog_item_slug ?? listing.catalog_catalog_item_id}`}
                      tone="secondary"
                      size="sm"
                    >
                      {t("discovery.routes.publicAccount.compare")}
                    </LinkButton>
                  }
                />
              );
            })}
          </Grid>
        ) : (
          <MarketplaceEmptyState
            title={t("discovery.routes.publicAccount.no.active.listings")}
            description={t("discovery.routes.publicAccount.this.account.does.not.have.active")}
            recoveryActions={
              <LinkButton href="/search">{t("discovery.routes.publicAccount.browse.marketplace")}</LinkButton>
            }
          />
        )}
      </Stack>
    </Container>
  );
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
