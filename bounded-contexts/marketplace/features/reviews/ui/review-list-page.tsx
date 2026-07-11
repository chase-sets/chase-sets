import { t } from "@chase-sets/localization";
import type { ReactNode } from "react";
import {
  Badge,
  LinkButton,
  MarketplaceEmptyState,
  Page,
  PageHeader,
  PageSection,
  ReviewCard,
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
  roleFilterActions,
}: {
  title: string;
  eyebrow: string;
  emptyTitle: string;
  emptyDescription: string;
  reviewDetailBasePath: string;
  reviews: readonly ReviewListItem[];
  actions?: ReactNode;
  roleFilterActions?: ReactNode;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={t("reputation.features.reviews.ui.reviewListPage.track.written.feedback.current.visibility.and")}
        actions={actions}
      />

      {roleFilterActions ? (
        <PageSection title={t("reputation.features.reviews.ui.reviewListPage.filter.by.role")}>
          {roleFilterActions}
        </PageSection>
      ) : null}

      <PageSection title={t("reputation.features.reviews.ui.reviewListPage.reviews")}>
        <Stack gap={3}>
          {reviews.length === 0 ? (
            <MarketplaceEmptyState title={emptyTitle} description={emptyDescription} />
          ) : (
            reviews.map((review) => (
              <Stack key={review.review_id} gap={2}>
                <ReviewCard
                  author={`${t("reputation.features.reviews.ui.reviewListPage.review.author")}${review.author_display_name ?? review.author_account_id}`}
                  rating={review.rating}
                  body={review.feedback ?? t("reputation.features.reviews.ui.reviewListPage.no.written.feedback")}
                  meta={
                    <Stack gap={1}>
                      <Text size="sm" tone="secondary">
                        {t("reputation.features.reviews.ui.reviewListPage.verified.order")}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {t("reputation.features.reviews.ui.reviewListPage.reviewed.account")}
                        {review.subject_display_name ?? review.subject_account_id}
                      </Text>
                      <Badge tone={statusTone(review.status)}>{review.status}</Badge>
                      {review.resolution_context === "resolved-via-refund" ? (
                        <Badge tone="neutral">
                          {t("reputation.features.reviews.ui.reviewListPage.resolved.via.refund")}
                        </Badge>
                      ) : null}
                    </Stack>
                  }
                  verified
                />
                <LinkButton href={`${reviewDetailBasePath}/${review.review_id}`} tone="secondary">
                  {t("reputation.features.reviews.ui.reviewListPage.open.review")}
                </LinkButton>
              </Stack>
            ))
          )}
        </Stack>
      </PageSection>
    </Page>
  );
}
