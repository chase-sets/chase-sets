import { t } from "@chase-sets/localization";
import type { ReactNode } from "react";
import {
  Card,
  EmptyState,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type {
  ReviewSummary,
  ReviewListItem,
} from "./contracts";

function formatAverage(summary: ReviewSummary) {
  return summary.average_rating ?? t("reputation.features.reviews.ui.accountReviewSummaryPage.not.yet.rated");
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
        <Card>
          <Stack gap={1}>
            <Text weight="semibold">{t("reputation.features.reviews.ui.accountReviewSummaryPage.average.rating")}{formatAverage(summary)}</Text>
            <Text size="sm" tone="secondary">
              {summary.review_count} review{summary.review_count === 1 ? "" : "s"}
            </Text>
            <Text size="sm" tone="secondary">
              {t("reputation.features.reviews.ui.accountReviewSummaryPage.5.star")}{summary.rating_5_count} {t("reputation.features.reviews.ui.accountReviewSummaryPage.4.star")}{summary.rating_4_count} {t("reputation.features.reviews.ui.accountReviewSummaryPage.3.star")}{summary.rating_3_count} {t("reputation.features.reviews.ui.accountReviewSummaryPage.2.star")}{summary.rating_2_count} {t("reputation.features.reviews.ui.accountReviewSummaryPage.1.star")}{summary.rating_1_count}
            </Text>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title={t("reputation.features.reviews.ui.accountReviewSummaryPage.recent.reviews")}>
        <Stack gap={3}>
          {reviews.length === 0 ? (
            <EmptyState
              title={t("reputation.features.reviews.ui.accountReviewSummaryPage.no.reviews.yet")}
              description={t("reputation.features.reviews.ui.accountReviewSummaryPage.completed.transactions.will.surface.here.once")}
              icon="star"
            />
          ) : (
            reviews.map((review) => (
              <Card key={review.review_id}>
                <Stack gap={1}>
                  <Text weight="semibold">{review.rating} / 5</Text>
                  <Text size="sm" tone="secondary">
                    {t("reputation.features.reviews.ui.accountReviewSummaryPage.order")}{review.order_id}
                  </Text>
                  {review.feedback ? <Text>{review.feedback}</Text> : null}
                </Stack>
              </Card>
            ))
          )}
        </Stack>
      </PageSection>
    </Page>
  );
}
