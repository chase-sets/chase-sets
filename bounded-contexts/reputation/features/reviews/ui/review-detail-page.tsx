import { t } from "@chase-sets/localization";
import { Badge, LinkButton, Page, PageHeader, PageSection, ReviewCard, Stack, Text } from "@chase-sets/design-system";
import type { ReviewDetail } from "./contracts";

function statusTone(status: string) {
  return status === "withdrawn" ? "danger" : "success";
}

export function ReviewDetailPage({ backHref, review }: { backHref: string; review: ReviewDetail }) {
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
            </Stack>
          }
          verified
        />
      </PageSection>
    </Page>
  );
}
