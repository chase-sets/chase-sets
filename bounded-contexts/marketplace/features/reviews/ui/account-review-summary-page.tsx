import { t } from "@chase-sets/localization";
import type { ReactNode } from "react";
import {
  MarketplaceEmptyState,
  Page,
  PageHeader,
  PageSection,
  RatingDistribution,
  ReviewCard,
  Stack,
} from "@chase-sets/design-system";
import type { ReviewSummary, ReviewListItem } from "./contracts";
import { ReviewReportAction, type ReviewReportResult } from "./review-report-action";
import { ReviewScoringContext } from "./review-scoring-context";

type ReviewRoleDimension = Readonly<{
  averageRating: string | null;
  reviewCount: number;
  rating1Count: number;
  rating2Count: number;
  rating3Count: number;
  rating4Count: number;
  rating5Count: number;
}>;

function sellerDimension(summary: ReviewSummary): ReviewRoleDimension {
  return {
    averageRating: summary.average_rating_as_seller,
    reviewCount: summary.review_count_as_seller,
    rating1Count: summary.rating_1_count_as_seller,
    rating2Count: summary.rating_2_count_as_seller,
    rating3Count: summary.rating_3_count_as_seller,
    rating4Count: summary.rating_4_count_as_seller,
    rating5Count: summary.rating_5_count_as_seller,
  };
}

function buyerDimension(summary: ReviewSummary): ReviewRoleDimension {
  return {
    averageRating: summary.average_rating_as_buyer,
    reviewCount: summary.review_count_as_buyer,
    rating1Count: summary.rating_1_count_as_buyer,
    rating2Count: summary.rating_2_count_as_buyer,
    rating3Count: summary.rating_3_count_as_buyer,
    rating4Count: summary.rating_4_count_as_buyer,
    rating5Count: summary.rating_5_count_as_buyer,
  };
}

function formatAverage(dimension: ReviewRoleDimension) {
  return dimension.averageRating ?? t("reputation.features.reviews.ui.accountReviewSummaryPage.not.yet.rated");
}

function numericAverage(dimension: ReviewRoleDimension) {
  const average = Number.parseFloat(dimension.averageRating ?? "0");
  return Number.isFinite(average) ? average : 0;
}

function ratingPercent(count: number, total: number) {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

function RoleReputationDistribution({ title, dimension }: { title: string; dimension: ReviewRoleDimension }) {
  return (
    <RatingDistribution
      title={title}
      average={numericAverage(dimension)}
      count={dimension.reviewCount || formatAverage(dimension)}
      rows={[
        { stars: 5, value: ratingPercent(dimension.rating5Count, dimension.reviewCount) },
        { stars: 4, value: ratingPercent(dimension.rating4Count, dimension.reviewCount) },
        { stars: 3, value: ratingPercent(dimension.rating3Count, dimension.reviewCount) },
        { stars: 2, value: ratingPercent(dimension.rating2Count, dimension.reviewCount) },
        { stars: 1, value: ratingPercent(dimension.rating1Count, dimension.reviewCount) },
      ]}
    />
  );
}

export function ReviewSummaryPage({
  accountLabel,
  summary,
  reviews,
  actions,
  reportResult,
  submittingReportId,
}: {
  accountLabel: string;
  summary: ReviewSummary;
  reviews: readonly ReviewListItem[];
  actions?: ReactNode;
  reportResult?: ReviewReportResult | null;
  submittingReportId?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("reputation.features.reviews.ui.accountReviewSummaryPage.reviews")}
        title={accountLabel}
        description={t(
          "reputation.features.reviews.ui.accountReviewSummaryPage.canonical.post.transaction.feedback.and.rating",
        )}
        actions={actions}
      />

      <PageSection title={t("reputation.features.reviews.ui.accountReviewSummaryPage.summary")}>
        <Stack gap={3}>
          <RoleReputationDistribution
            title={t("reputation.features.reviews.ui.accountReviewSummaryPage.as.seller")}
            dimension={sellerDimension(summary)}
          />
          <RoleReputationDistribution
            title={t("reputation.features.reviews.ui.accountReviewSummaryPage.as.buyer")}
            dimension={buyerDimension(summary)}
          />
        </Stack>
      </PageSection>

      <PageSection title={t("reputation.features.reviews.ui.accountReviewSummaryPage.recent.reviews")}>
        <Stack gap={3}>
          {reviews.length === 0 ? (
            <MarketplaceEmptyState
              title={t("reputation.features.reviews.ui.accountReviewSummaryPage.no.reviews.yet")}
              description={t(
                "reputation.features.reviews.ui.accountReviewSummaryPage.completed.transactions.will.surface.here.once",
              )}
            />
          ) : (
            // listAccountReviews (the public, revealed-only list) never returns
            // a redacted row, but the shared ReviewListItem type allows
            // rating === null (m108 double-blind reveal), so this guard keeps
            // the component honest without assuming that invariant.
            reviews
              .filter((review): review is typeof review & { rating: number } => review.rating !== null)
              .map((review) => (
                <ReviewCard
                  key={review.review_id}
                  author={review.author_display_name ?? review.author_account_id}
                  rating={review.rating}
                  body={
                    review.feedback ?? t("reputation.features.reviews.ui.accountReviewSummaryPage.no.written.feedback")
                  }
                  meta="Verified order"
                  verified
                  response={
                    review.reply_status === "active" && review.reply_feedback ? review.reply_feedback : undefined
                  }
                  responseLabel={t("reputation.features.reviews.ui.accountReviewSummaryPage.reply.label")}
                  context={<ReviewScoringContext review={review} />}
                  actions={
                    review.status === "active" && review.revealed_at !== null && !review.held ? (
                      <ReviewReportAction
                        reviewId={review.review_id}
                        result={reportResult}
                        isSubmitting={submittingReportId === review.review_id}
                      />
                    ) : undefined
                  }
                />
              ))
          )}
        </Stack>
      </PageSection>
    </Page>
  );
}
