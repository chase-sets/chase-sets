import { t } from "@chase-sets/localization";
import {
  Badge,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { ReviewDetail } from "./contracts";

function statusTone(status: string) {
  return status === "withdrawn" ? "danger" : "success";
}

export function ReviewDetailPage({
  backHref,
  review,
}: {
  backHref: string;
  review: ReviewDetail;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("reputation.features.reviews.ui.reviewDetailPage.review")}
        title={t("reputation.features.reviews.ui.reviewDetailPage.review.title", {
          reviewId: review.review_id,
        })}
        description={t("reputation.features.reviews.ui.reviewDetailPage.order.description", {
          orderId: review.order_id,
        })}
        actions={
          <LinkButton href={backHref} tone="secondary">
            {t("reputation.features.reviews.ui.reviewDetailPage.back")}</LinkButton>
        }
      />

      <PageSection title={t("reputation.features.reviews.ui.reviewDetailPage.summary")}>
        <Card>
          <Stack gap={2}>
            <Badge tone={statusTone(review.status)}>{review.status}</Badge>
            <Text>{t("reputation.features.reviews.ui.reviewDetailPage.rating")}{review.rating} / 5</Text>
            <Text>{t("reputation.features.reviews.ui.reviewDetailPage.author.role")}{review.author_role}</Text>
            <Text>
              {t("reputation.features.reviews.ui.reviewDetailPage.review.author")}{review.author_display_name ?? review.author_account_id}
            </Text>
            <Text>
              {t("reputation.features.reviews.ui.reviewDetailPage.reviewed.account")}{review.subject_display_name ?? review.subject_account_id}
            </Text>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title={t("reputation.features.reviews.ui.reviewDetailPage.feedback")}>
        <Card>
          <Text>{review.feedback ?? t("reputation.features.reviews.ui.reviewDetailPage.no.written.feedback")}</Text>
        </Card>
      </PageSection>
    </Page>
  );
}
