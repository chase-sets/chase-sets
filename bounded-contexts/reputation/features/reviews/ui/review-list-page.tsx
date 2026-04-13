import type { ReactNode } from "react";
import {
  Badge,
  Card,
  EmptyState,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { ReputationReviewListItem } from "./contracts";

function statusTone(status: string) {
  return status === "withdrawn" ? "danger" : "success";
}

export function ReputationReviewListPage({
  title,
  eyebrow,
  emptyTitle,
  emptyDescription,
  reviewDetailBasePath,
  reviews,
  actions,
}: {
  title: string;
  eyebrow: string;
  emptyTitle: string;
  emptyDescription: string;
  reviewDetailBasePath: string;
  reviews: readonly ReputationReviewListItem[];
  actions?: ReactNode;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description="Track written feedback, current visibility, and commercial counterparties."
        actions={actions}
      />

      <PageSection title="Reviews">
        <Stack gap={3}>
          {reviews.length === 0 ? (
            <EmptyState
              title={emptyTitle}
              description={emptyDescription}
              icon="star"
            />
          ) : (
            reviews.map((review) => (
              <Card key={review.review_id}>
                <Stack gap={2}>
                  <Stack gap={1}>
                    <Text weight="semibold">Order {review.order_id}</Text>
                    <Badge tone={statusTone(review.status)}>{review.status}</Badge>
                  </Stack>
                  <Text>{review.rating} / 5</Text>
                  <Text size="sm" tone="secondary">
                    {review.feedback ?? "No written feedback."}
                  </Text>
                  <LinkButton href={`${reviewDetailBasePath}/${review.review_id}`} tone="secondary">
                    Open review
                  </LinkButton>
                </Stack>
              </Card>
            ))
          )}
        </Stack>
      </PageSection>
    </Page>
  );
}
