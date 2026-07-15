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

// Double-blind reveal (m108): rating === null means this row was
// redacted for the subject's own view of a not-yet-revealed review.
function isPending(review: ReviewListItem) {
  return review.status !== "withdrawn" && review.revealed_at === null;
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
            reviews.map((review) =>
              review.held && review.rating === null ? (
                <Stack key={review.review_id} gap={2}>
                  <MarketplaceEmptyState
                    title={t("reputation.features.reviews.ui.reviewListPage.feedback.on.hold.title")}
                    description={t("reputation.features.reviews.ui.reviewListPage.feedback.on.hold.description")}
                  />
                </Stack>
              ) : review.rating === null ? (
                <Stack key={review.review_id} gap={2}>
                  <MarketplaceEmptyState
                    title={t("reputation.features.reviews.ui.reviewListPage.review.pending.title")}
                    description={t("reputation.features.reviews.ui.reviewListPage.review.pending.description")}
                  />
                </Stack>
              ) : (
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
                        {isPending(review) ? (
                          <Badge tone="warning">
                            {t("reputation.features.reviews.ui.reviewListPage.pending.reveal")}
                          </Badge>
                        ) : null}
                        {review.held ? (
                          <Badge tone="warning">
                            {t("reputation.features.reviews.ui.reviewListPage.feedback.on.hold.badge")}
                          </Badge>
                        ) : null}
                      </Stack>
                    }
                    verified
                    sellerResponse={
                      review.reply_status === "active" && review.reply_feedback ? review.reply_feedback : undefined
                    }
                  />
                  <LinkButton href={`${reviewDetailBasePath}/${review.review_id}`} tone="secondary">
                    {t("reputation.features.reviews.ui.reviewListPage.open.review")}
                  </LinkButton>
                </Stack>
              ),
            )
          )}
        </Stack>
      </PageSection>
    </Page>
  );
}
