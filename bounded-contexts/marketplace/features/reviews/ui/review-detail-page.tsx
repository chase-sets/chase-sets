import { t } from "@chase-sets/localization";
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
import type { ReviewDetail } from "./contracts";

function statusTone(status: string) {
  return status === "withdrawn" ? "danger" : "success";
}

// Double-blind reveal (m108): rating === null means this row was
// redacted for the subject's own view of a not-yet-revealed review.
function isPending(review: ReviewDetail) {
  return review.status !== "withdrawn" && review.revealed_at === null;
}

export function ReviewDetailPage({ backHref, review }: { backHref: string; review: ReviewDetail }) {
  const pending = isPending(review);

  return (
    <Page>
      <PageHeader
        eyebrow={t("reputation.features.reviews.ui.reviewDetailPage.review")}
        title={t("reputation.features.reviews.ui.reviewDetailPage.review.details")}
        description={t("reputation.features.reviews.ui.reviewDetailPage.verified.order.feedback")}
        actions={
          <LinkButton href={backHref} tone="secondary">
            {t("reputation.features.reviews.ui.reviewDetailPage.back")}
          </LinkButton>
        }
      />

      <PageSection title={t("reputation.features.reviews.ui.reviewDetailPage.summary")}>
        {review.rating === null ? (
          <MarketplaceEmptyState
            title={t("reputation.features.reviews.ui.reviewDetailPage.review.pending.title")}
            description={t("reputation.features.reviews.ui.reviewDetailPage.review.pending.description")}
          />
        ) : (
          <ReviewCard
            author={`${t("reputation.features.reviews.ui.reviewDetailPage.review.author")}${review.author_display_name ?? review.author_account_id}`}
            rating={review.rating}
            body={review.feedback ?? t("reputation.features.reviews.ui.reviewDetailPage.no.written.feedback")}
            meta={
              <Stack gap={1}>
                <Text size="sm" tone="secondary">
                  {t("reputation.features.reviews.ui.reviewDetailPage.author.role")}
                  {review.author_role}
                </Text>
                <Text size="sm" tone="secondary">
                  {t("reputation.features.reviews.ui.reviewDetailPage.reviewed.account")}
                  {review.subject_display_name ?? review.subject_account_id}
                </Text>
                <Badge tone={statusTone(review.status)}>{review.status}</Badge>
                {pending ? (
                  <Badge tone="warning">{t("reputation.features.reviews.ui.reviewDetailPage.pending.reveal")}</Badge>
                ) : null}
                {review.resolution_context === "resolved-via-refund" ? (
                  <Badge tone="neutral">
                    {t("reputation.features.reviews.ui.reviewDetailPage.resolved.via.refund")}
                  </Badge>
                ) : null}
              </Stack>
            }
            verified
          />
        )}
      </PageSection>
    </Page>
  );
}

export function ReviewDetailRecoveryPage({ currentPath }: Readonly<{ currentPath: string }>) {
  const preparingTitle = t("reputation.routes.marketplace.accountReview.review.preparing");
  const preparingDescription = t("reputation.routes.marketplace.accountReview.review.preparing.description");

  return (
    <Page>
      <PageHeader
        eyebrow={t("reputation.features.reviews.ui.reviewDetailPage.review")}
        title={preparingTitle}
        description={preparingDescription}
      />
      <PageSection title={t("reputation.features.reviews.ui.reviewDetailRecoveryPage.recover.review")}>
        <MarketplaceEmptyState
          title={preparingTitle}
          description={preparingDescription}
          trustCue={t("reputation.features.reviews.ui.reviewDetailRecoveryPage.review.submission.saved")}
          recoveryActions={
            <>
              <LinkButton href={currentPath} leadingIcon="refreshCcw">
                {t("reputation.features.reviews.ui.reviewDetailRecoveryPage.refresh.review")}
              </LinkButton>
              <LinkButton href="/account/reviews" tone="secondary">
                {t("reputation.features.reviews.ui.reviewDetailPage.back")}
              </LinkButton>
            </>
          }
        />
      </PageSection>
    </Page>
  );
}
