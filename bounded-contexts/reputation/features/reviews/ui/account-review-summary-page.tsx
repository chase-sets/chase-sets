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
import type {
  ReviewSummary,
  ReviewListItem,
} from "./contracts";

function formatAverage(summary: ReviewSummary) {
  return summary.average_rating ?? t("reputation.features.reviews.ui.accountReviewSummaryPage.not.yet.rated");
}

function numericAverage(summary: ReviewSummary) {
  const average = Number.parseFloat(summary.average_rating ?? "0");
  return Number.isFinite(average) ? average : 0;
}

function ratingPercent(count: number, total: number) {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

export function ReviewSummaryPage({
  accountLabel,
  summary,
  reviews,
  actions,
}: {
  accountLabel: string;
  summary: ReviewSummary;
  reviews: readonly ReviewListItem[];
  actions?: ReactNode;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("reputation.features.reviews.ui.accountReviewSummaryPage.reviews")}
        title={accountLabel}
        description={t("reputation.features.reviews.ui.accountReviewSummaryPage.canonical.post.transaction.feedback.and.rating")}
        actions={actions}
      />

      <PageSection title={t("reputation.features.reviews.ui.accountReviewSummaryPage.summary")}>
        <RatingDistribution
          average={numericAverage(summary)}
          count={summary.review_count || formatAverage(summary)}
          rows={[
            { stars: 5, value: ratingPercent(summary.rating_5_count, summary.review_count) },
            { stars: 4, value: ratingPercent(summary.rating_4_count, summary.review_count) },
            { stars: 3, value: ratingPercent(summary.rating_3_count, summary.review_count) },
            { stars: 2, value: ratingPercent(summary.rating_2_count, summary.review_count) },
            { stars: 1, value: ratingPercent(summary.rating_1_count, summary.review_count) },
          ]}
        />
      </PageSection>

      <PageSection title={t("reputation.features.reviews.ui.accountReviewSummaryPage.recent.reviews")}>
        <Stack gap={3}>
          {reviews.length === 0 ? (
            <MarketplaceEmptyState
              title={t("reputation.features.reviews.ui.accountReviewSummaryPage.no.reviews.yet")}
              description={t("reputation.features.reviews.ui.accountReviewSummaryPage.completed.transactions.will.surface.here.once")}
            />
          ) : (
            reviews.map((review) => (
              <ReviewCard
                key={review.review_id}
                author={review.author_display_name ?? review.author_account_id}
                rating={review.rating}
                body={review.feedback ?? t("reputation.features.reviews.ui.accountReviewSummaryPage.no.written.feedback")}
                meta="Verified order"
                verified
              />
            ))
          )}
        </Stack>
      </PageSection>
    </Page>
  );
}
