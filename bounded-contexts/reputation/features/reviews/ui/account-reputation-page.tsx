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
  ReputationAccountSummary,
  ReputationReviewListItem,
} from "./contracts";

function formatAverage(summary: ReputationAccountSummary) {
  return summary.average_rating ?? "Not yet rated";
}

export function ReputationAccountPage({
  accountLabel,
  summary,
  reviews,
  actions,
}: {
  accountLabel: string;
  summary: ReputationAccountSummary;
  reviews: readonly ReputationReviewListItem[];
  actions?: ReactNode;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Reputation"
        title={accountLabel}
        description="Canonical post-transaction feedback and rating summary."
        actions={actions}
      />

      <PageSection title="Summary">
        <Card>
          <Stack gap={1}>
            <Text weight="semibold">Average rating: {formatAverage(summary)}</Text>
            <Text size="sm" tone="secondary">
              {summary.review_count} review{summary.review_count === 1 ? "" : "s"}
            </Text>
            <Text size="sm" tone="secondary">
              5-star: {summary.rating_5_count} | 4-star: {summary.rating_4_count} |
              3-star: {summary.rating_3_count} | 2-star: {summary.rating_2_count} |
              1-star: {summary.rating_1_count}
            </Text>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title="Recent Reviews">
        <Stack gap={3}>
          {reviews.length === 0 ? (
            <EmptyState
              title="No reviews yet"
              description="Completed transactions will surface here once counterparties leave feedback."
              icon="star"
            />
          ) : (
            reviews.map((review) => (
              <Card key={review.review_id}>
                <Stack gap={1}>
                  <Text weight="semibold">{review.rating} / 5</Text>
                  <Text size="sm" tone="secondary">
                    Order {review.order_id}
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
