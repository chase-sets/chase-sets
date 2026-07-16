import { formatDate, formatDisplayIdentity, t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import {
  OrderProtectionModule,
  Container,
  Grid,
  ListingCard,
  LinkButton,
  MarketplaceEmptyState,
  AccountCredibilityHeader,
  Badge,
  Box,
  Inline,
  PageSection,
  Pagination,
  ProductOptions,
  RatingDistribution,
  RatingSummary,
  ReviewCard,
  Stack,
  Text,
  formatProductImageAltText,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import type { DiscoveryPublicAccount } from "../support/client-support/contracts";
import { createDiscoveryRequestApiClient, DiscoveryApiError } from "../support/request-support/api-client";
import { discoveryAssetUrls } from "../support/client-support/assets";
import { applyDiscoveryPublicAccountPatch } from "../support/client-support/realtime-market";
import { discoveryRealtimeRouteTopics } from "../support/realtime-support/topics";
import { useDiscoveryRealtimeRevalidation } from "../support/realtime-support/revalidation";
import {
  FounderBadge,
  hasFounderBadge,
  hasTrustedSellerBadge,
  TrustedSellerBadge,
} from "../features/item-detail/ui/account-badges";
import {
  createMarketplaceRequestApiClient,
  createSellerMetricsRequestApiClient,
  MarketplaceApiError,
  type ReportReviewRequest,
  type SellerBehavioralMetricsChips,
} from "@chase-sets/marketplace/server";
import { ReviewReportAction, ReviewScoringContext, type ReviewReportResult } from "@chase-sets/marketplace/web";
import { formatMoney } from "../support/ui-support/formatting";

const ACCOUNT_REVIEW_PAGE_SIZE = 10;
const ACCOUNT_REVIEW_ROLES = new Set(["seller", "buyer"]);

type AccountReviewRoleFilter = "seller" | "buyer" | null;

type AccountRatingDimension = Readonly<{
  averageRating: string | null;
  reviewCount: number;
  ratingCount: number;
  rating1Count: number;
  rating2Count: number;
  rating3Count: number;
  rating4Count: number;
  rating5Count: number;
}>;

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

  return formatDate(value);
}

function formatMemberSince(value: string | null | undefined) {
  if (!value || Number.isNaN(new Date(value).getTime())) {
    return null;
  }

  return formatDate(value, { preset: "long", includeDay: false });
}

function reviewRoleFromRequest(request: Request): AccountReviewRoleFilter {
  const role = new URL(request.url).searchParams.get("role");
  return role && ACCOUNT_REVIEW_ROLES.has(role) ? (role as "seller" | "buyer") : null;
}

function reviewPageFromRequest(request: Request): number {
  const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function sellerDimension(account: DiscoveryPublicAccount): AccountRatingDimension {
  return {
    averageRating: account.average_rating_as_seller,
    reviewCount: account.review_count_as_seller,
    ratingCount: account.rating_count_as_seller,
    rating1Count: account.rating_1_count_as_seller,
    rating2Count: account.rating_2_count_as_seller,
    rating3Count: account.rating_3_count_as_seller,
    rating4Count: account.rating_4_count_as_seller,
    rating5Count: account.rating_5_count_as_seller,
  };
}

function buyerDimension(account: DiscoveryPublicAccount): AccountRatingDimension {
  return {
    averageRating: account.average_rating_as_buyer,
    reviewCount: account.review_count_as_buyer,
    ratingCount: account.rating_count_as_buyer,
    rating1Count: account.rating_1_count_as_buyer,
    rating2Count: account.rating_2_count_as_buyer,
    rating3Count: account.rating_3_count_as_buyer,
    rating4Count: account.rating_4_count_as_buyer,
    rating5Count: account.rating_5_count_as_buyer,
  };
}

function ratingPercent(count: number, total: number) {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

function RoleRatingDistribution({ title, dimension }: { title: string; dimension: AccountRatingDimension }) {
  const average = Number.parseFloat(dimension.averageRating ?? "0");

  return (
    <RatingDistribution
      title={title}
      average={Number.isFinite(average) ? average : 0}
      count={
        dimension.ratingCount === 0
          ? t("discovery.routes.publicAccount.no.feedback.yet")
          : dimension.ratingCount === dimension.reviewCount
            ? dimension.ratingCount
            : t("discovery.routes.publicAccount.ratings.included", {
                ratingCount: dimension.ratingCount,
                reviewCount: dimension.reviewCount,
              })
      }
      rows={[
        { stars: 5, value: ratingPercent(dimension.rating5Count, dimension.ratingCount) },
        { stars: 4, value: ratingPercent(dimension.rating4Count, dimension.ratingCount) },
        { stars: 3, value: ratingPercent(dimension.rating3Count, dimension.ratingCount) },
        { stars: 2, value: ratingPercent(dimension.rating2Count, dimension.ratingCount) },
        { stars: 1, value: ratingPercent(dimension.rating1Count, dimension.ratingCount) },
      ]}
    />
  );
}

// Qualitative chips, never raw percentages -- each chip only
// renders when its underlying rate is confidently good AND past the
// display threshold (marketplace's public API already returns null for
// "not confident" and "not enough orders", collapsing both into "say
// nothing" here rather than distinguishing them to the buyer).
function BehavioralMetricsChipRow({ chips }: { chips: SellerBehavioralMetricsChips | null }) {
  if (!chips) {
    return null;
  }

  const labels = [
    chips.shipsOnTime === true ? t("discovery.routes.publicAccount.chips.ships.on.time") : null,
    chips.lowCancellationRate === true ? t("discovery.routes.publicAccount.chips.rarely.cancels") : null,
    chips.lowDisputeRate === true ? t("discovery.routes.publicAccount.chips.rarely.disputed") : null,
  ].filter((label): label is string => label !== null);

  if (labels.length === 0) {
    return null;
  }

  return (
    <Inline gap={2}>
      {labels.map((label) => (
        <Badge key={label} tone="success">
          {label}
        </Badge>
      ))}
    </Inline>
  );
}

function navigateToAccountReviewsPage(role: AccountReviewRoleFilter, page: number) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  if (role) {
    url.searchParams.set("role", role);
  } else {
    url.searchParams.delete("role");
  }
  url.searchParams.set("page", String(page));
  window.location.assign(`${url.pathname}${url.search}#feedback`);
}

function accountReviewRoleHref(currentSearch: string, role: AccountReviewRoleFilter): string {
  const params = new URLSearchParams(currentSearch);
  params.delete("page");
  if (role) {
    params.set("role", role);
  } else {
    params.delete("role");
  }
  const query = params.toString();
  return `${query ? `?${query}` : ""}#feedback`;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const slug = params.accountSlug;

  if (!slug) {
    return {
      account: null,
      notFound: true,
      canonicalUrl: null,
      reviewRole: null,
      reviewPage: 1,
      search: "",
      behavioralMetricsChips: null,
    };
  }

  const reviewRole = reviewRoleFromRequest(request);
  const reviewPage = reviewPageFromRequest(request);
  const reviewQuery = new URLSearchParams({
    limit: String(ACCOUNT_REVIEW_PAGE_SIZE),
    offset: String((reviewPage - 1) * ACCOUNT_REVIEW_PAGE_SIZE),
    ...(reviewRole ? { role: reviewRole } : {}),
  }).toString();

  try {
    const account = await createDiscoveryRequestApiClient(request).getPublicAccountBySlug(slug, reviewQuery);
    const url = new URL(request.url);

    if (account.account_slug && slug !== account.account_slug) {
      throw redirect(`/accounts/${account.account_slug}${url.search}`, { status: 301 });
    }

    const behavioralMetricsChips = await fetchSellerBehavioralMetricsChips(request, account.account_id);

    return {
      account,
      notFound: false,
      canonicalUrl: new URL(`/accounts/${account.account_slug}`, url.origin).toString(),
      reviewRole,
      reviewPage,
      search: url.search,
      behavioralMetricsChips,
    };
  } catch (error) {
    if (error instanceof DiscoveryApiError) {
      return {
        account: null,
        notFound: true,
        canonicalUrl: null,
        reviewRole,
        reviewPage,
        search: "",
        behavioralMetricsChips: null,
      };
    }

    throw error;
  }
}

function reviewReportErrorMessage(error: unknown) {
  if (error instanceof MarketplaceApiError) {
    const body = error.body as Readonly<{ error?: Readonly<{ message?: unknown }> }> | null;
    const message = body?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return error instanceof Error ? error.message : "Report submission failed. Try again.";
}

function marketplaceErrorCode(error: MarketplaceApiError) {
  const body = error.body as Readonly<{ error?: Readonly<{ code?: unknown }> }> | null;
  return typeof body?.error?.code === "string" ? body.error.code : null;
}

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  if (formData.get("intent") !== "report-review") {
    return null;
  }

  const reviewId = String(formData.get("reviewId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  const details = String(formData.get("details") ?? "");
  try {
    await createMarketplaceRequestApiClient(request).reportReview(reviewId, {
      reason: reason as ReportReviewRequest["reason"],
      details: details || null,
      sourceRoutePath: new URL(request.url).pathname,
    });
    return { reviewId, status: "submitted" } satisfies ReviewReportResult;
  } catch (error) {
    if (error instanceof MarketplaceApiError && error.status === 401) {
      const url = new URL(request.url);
      const returnTo = `${url.pathname}${url.search}#feedback`;
      throw redirect(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
    }
    if (
      error instanceof MarketplaceApiError &&
      error.status === 409 &&
      marketplaceErrorCode(error) === "report_already_submitted"
    ) {
      return { reviewId, status: "already-submitted" } satisfies ReviewReportResult;
    }
    return {
      reviewId,
      status: "error",
      message: reviewReportErrorMessage(error),
      values: { reason, details },
    } satisfies ReviewReportResult;
  }
}

// Composition-root call to marketplace's public server API
// client (already the established cross-context pattern for discovery's
// item-detail route, support/route-support/item-detail/loader.ts) rather
// than a new event-subscribed local projection -- marketplace computes the
// behavioral-metrics rates exactly once and discovery reads its public,
// already-flag-gated, already-threshold-gated chip surface at request time.
// Best-effort: a transient failure degrades to no chips, not a failed page.
async function fetchSellerBehavioralMetricsChips(
  request: Request,
  accountId: string,
): Promise<SellerBehavioralMetricsChips | null> {
  try {
    return await createSellerMetricsRequestApiClient(request).getBehavioralMetricsChips(accountId);
  } catch {
    return null;
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
  // Suspended/closed and not-found profiles carry no lasting public content
  // worth indexing (reputation privacy pass); the launch-wide indexability
  // gate in the deployable root already covers pre-launch noindex separately.
  ...(!data?.account || data.account.status !== "active" ? [{ name: "robots", content: "noindex" }] : []),
];

export default function PublicAccountRoute() {
  const data = useLoaderData<typeof loader>();
  const reportResult = useActionData<typeof action>() as ReviewReportResult | undefined;
  const navigation = useNavigation();
  const submittingReportId =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "report-review"
      ? String(navigation.formData.get("reviewId") ?? "")
      : null;

  return (
    <PublicAccountRealtimeView
      key={[
        data.account?.account_id ?? "empty",
        data.account?.active_listing_count ?? 0,
        data.account?.listings.map((listing) => listing.listing_id).join("|") ?? "",
      ].join("\n")}
      data={data}
      reportResult={reportResult}
      submittingReportId={submittingReportId}
    />
  );
}

function PublicAccountRealtimeView({
  data,
  reportResult,
  submittingReportId,
}: {
  data: Awaited<ReturnType<typeof loader>>;
  reportResult?: ReviewReportResult;
  submittingReportId: string | null;
}) {
  const revalidateForRealtimeSync = useDiscoveryRealtimeRevalidation();
  const account = useRealtimePatchedSnapshot({
    initialSnapshot: data.account,
    snapshotKey: JSON.stringify(data.account),
    topics: data.account ? discoveryRealtimeRouteTopics.publicAccount(data.account.account_id).topics : [],
    applyPatch: applyDiscoveryPublicAccountPatch,
    onSyncRequired: revalidateForRealtimeSync,
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

  // Privacy pass: a suspended or closed account gets a minimal
  // "unavailable" profile -- no listings, no reviews, no reputation numbers,
  // no member-since. The API already withholds this content server-side;
  // this branch keeps the client from ever rendering stale realtime data for
  // an account that should no longer be publicly browsable.
  if (account.status !== "active") {
    return (
      <Container width="content">
        <PageSection title={t("discovery.routes.publicAccount.account.unavailable")}>
          <Text>
            {t("discovery.routes.publicAccount.account.profile.unavailable.description", {
              accountName: account.account_display_name ?? t("discovery.routes.publicAccount.account"),
            })}
          </Text>
        </PageSection>
      </Container>
    );
  }

  const sellerRating = parseRating(account.average_rating_as_seller);
  const sellerReviewCount = account.rating_count_as_seller;
  const reputationValue =
    sellerRating !== null && sellerReviewCount > 0 ? (
      <RatingSummary value={sellerRating} count={sellerReviewCount} compact />
    ) : (
      t("discovery.routes.publicAccount.no.feedback.yet")
    );
  const memberSince = formatMemberSince(account.created_at);
  const reviewRole = data.reviewRole;
  const reviewPage = data.reviewPage;
  const reviewPageSize = ACCOUNT_REVIEW_PAGE_SIZE;
  const reviewTotal = account.reviews.total;
  const reviewTotalPages = Math.max(1, Math.ceil(reviewTotal / reviewPageSize));
  const showReviewPagination = reviewTotal > reviewPageSize;

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
          badges={
            <>
              {hasTrustedSellerBadge(account.badges) ? <TrustedSellerBadge /> : null}
              {hasFounderBadge(account.badges) ? <FounderBadge founderNumber={account.founder_number} /> : null}
            </>
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
              label: t("discovery.routes.publicAccount.member.since.label"),
              value: memberSince ?? t("discovery.routes.publicAccount.member.since.unknown"),
            },
            {
              label: t("discovery.routes.publicAccount.response.time"),
              value: t("discovery.routes.publicAccount.responds.through.order.updates"),
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

        <BehavioralMetricsChipRow chips={data.behavioralMetricsChips} />

        <Box id="feedback">
          <PageSection title={t("discovery.routes.publicAccount.feedback")}>
            <Stack gap={4}>
              <Grid columns={{ base: 1, md: 2 }} gap={3}>
                <RoleRatingDistribution
                  title={t("discovery.routes.publicAccount.as.seller")}
                  dimension={sellerDimension(account)}
                />
                <RoleRatingDistribution
                  title={t("discovery.routes.publicAccount.as.buyer")}
                  dimension={buyerDimension(account)}
                />
              </Grid>

              <Stack direction="row" gap={2}>
                <LinkButton
                  href={accountReviewRoleHref(data.search, null)}
                  tone={reviewRole === null ? "primary" : "secondary"}
                >
                  {t("discovery.routes.publicAccount.all.roles")}
                </LinkButton>
                <LinkButton
                  href={accountReviewRoleHref(data.search, "seller")}
                  tone={reviewRole === "seller" ? "primary" : "secondary"}
                >
                  {t("discovery.routes.publicAccount.as.seller")}
                </LinkButton>
                <LinkButton
                  href={accountReviewRoleHref(data.search, "buyer")}
                  tone={reviewRole === "buyer" ? "primary" : "secondary"}
                >
                  {t("discovery.routes.publicAccount.as.buyer")}
                </LinkButton>
              </Stack>

              {account.reviews.items.length > 0 ? (
                <Stack gap={2}>
                  {account.reviews.items.map((review) => {
                    const reviewDate = formatReviewDate(review.submitted_at ?? review.updated_at);
                    return (
                      <ReviewCard
                        key={review.review_id}
                        author={
                          reviewDate
                            ? t("discovery.routes.publicAccount.review.byline", {
                                author:
                                  review.author_display_name ?? t("discovery.routes.publicAccount.marketplace.buyer"),
                                date: reviewDate,
                              })
                            : (review.author_display_name ?? t("discovery.routes.publicAccount.marketplace.buyer"))
                        }
                        rating={review.rating}
                        body={review.feedback ?? t("discovery.routes.publicAccount.no.written.feedback")}
                        meta={
                          review.author_role === "buyer"
                            ? t("discovery.routes.publicAccount.as.seller")
                            : t("discovery.routes.publicAccount.as.buyer")
                        }
                        verified
                        response={review.reply_status === "active" ? review.reply_feedback : null}
                        responseLabel={t("discovery.routes.publicAccount.review.reply.label")}
                        context={
                          <Stack gap={2}>
                            {review.scoring_disposition === "context-only" ? (
                              <Badge tone="neutral">
                                {t("discovery.routes.publicAccount.context.only.rating")}
                              </Badge>
                            ) : null}
                            <ReviewScoringContext review={review} />
                          </Stack>
                        }
                        actions={
                          <ReviewReportAction
                            reviewId={review.review_id}
                            result={reportResult}
                            isSubmitting={submittingReportId === review.review_id}
                          />
                        }
                      />
                    );
                  })}
                </Stack>
              ) : (
                <Text size="sm" tone="secondary">
                  {t("discovery.routes.publicAccount.no.written.feedback")}
                </Text>
              )}

              {showReviewPagination ? (
                <Pagination
                  page={reviewPage}
                  totalPages={reviewTotalPages}
                  onPageChange={(page) => navigateToAccountReviewsPage(reviewRole, page)}
                />
              ) : null}
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
              const displayIdentity = formatDisplayIdentity(
                listing.item_title ?? t("discovery.routes.publicAccount.marketplace.listing"),
                listing.product_summary,
              );
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
                  detailLinkLabel={t("localization.listingCard.view.details.for", { identity: displayIdentity })}
                  saveLabel={t("localization.listingCard.save", { identity: displayIdentity })}
                  savedLabel={t("localization.listingCard.saved", { identity: displayIdentity })}
                  watchingLabel={t("localization.listingCard.watching", { identity: displayIdentity })}
                  price={formatMoney(listing.price_amount)}
                  priceDetail={availabilityDetail}
                  sellerName={account.account_display_name ?? t("discovery.routes.publicAccount.account")}
                  sellerHref={`/accounts/${account.account_slug}#feedback`}
                  sellerTrustLabel={
                    sellerRating !== null && sellerReviewCount > 0
                      ? t("discovery.routes.publicAccount.reputation.rating", {
                          rating: sellerRating.toFixed(1),
                          count: sellerReviewCount,
                        })
                      : account.status === "active"
                        ? t("discovery.routes.publicAccount.verified.account")
                        : t("discovery.routes.publicAccount.account.details.visible")
                  }
                  sellerVerified={account.status === "active"}
                  rating={sellerRating ?? undefined}
                  reviewCount={sellerReviewCount}
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
