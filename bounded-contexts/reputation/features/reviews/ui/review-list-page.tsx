import { t } from "@chase-sets/localization";
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
import type { ReviewListItem } from "./contracts";

function statusTone(status: string) {
  return status === "withdrawn" ? "danger" : "success";
}

export function ReviewListPage({
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
  reviews: readonly ReviewListItem[];
  actions?: ReactNode;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={t("reputation.features.reviews.ui.reviewListPage.track.written.feedback.current.visibility.and")}
        actions={actions}
      />

      <PageSection title={t("reputation.features.reviews.ui.reviewListPage.reviews")}>
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
                    <Text weight="semibold">{t("reputation.features.reviews.ui.reviewListPage.order")}{review.order_id}</Text>
                    <Badge tone={statusTone(review.status)}>{review.status}</Badge>
                  </Stack>
                  <Text>{review.rating} / 5</Text>
                  <Text size="sm" tone="secondary">
                    {t("reputation.features.reviews.ui.reviewListPage.review.author")}{review.author_display_name ?? review.author_account_id}
                  </Text>
                  <Text size="sm" tone="secondary">
                    {t("reputation.features.reviews.ui.reviewListPage.reviewed.account")}{review.subject_display_name ?? review.subject_account_id}
                  </Text>
                  <Text size="sm" tone="secondary">
                    {review.feedback ?? t("reputation.features.reviews.ui.reviewListPage.no.written.feedback")}
                  </Text>
                  <LinkButton href={`${reviewDetailBasePath}/${review.review_id}`} tone="secondary">
                    {t("reputation.features.reviews.ui.reviewListPage.open.review")}</LinkButton>
                </Stack>
              </Card>
            ))
          )}
        </Stack>
      </PageSection>
    </Page>
  );
}
