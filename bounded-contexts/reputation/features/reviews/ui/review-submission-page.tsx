import { t } from "@chase-sets/localization";
import { useState } from "react";
import {
  Button,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Rating,
  Stack,
  Text,
  Textarea,
} from "@chase-sets/design-system";
import type { ReviewOpportunity } from "./contracts";

function getCounterpartyRole(authorRole: string) {
  return authorRole === "buyer" ? "seller" : "buyer";
}

export function ReviewSubmissionPage({
  backHref,
  opportunity,
  errorMessage,
  isSubmitting = false,
  defaultRating = 5,
  defaultFeedback = "",
}: {
  backHref: string;
  opportunity: ReviewOpportunity;
  errorMessage?: string | null;
  isSubmitting?: boolean;
  defaultRating?: number;
  defaultFeedback?: string;
}) {
  const [rating, setRating] = useState(defaultRating);
  const counterpartyRole = getCounterpartyRole(opportunity.author_role);
  const counterpartyLabel =
    opportunity.subject_display_name ?? opportunity.subject_account_id;

  return (
    <Page>
      <PageHeader
        eyebrow={t("reputation.features.reviews.ui.reviewSubmissionPage.reviews")}
        title={t("reputation.features.reviews.ui.reviewSubmissionPage.review.counterparty.title", {
          counterparty: counterpartyLabel,
        })}
        description={t("reputation.features.reviews.ui.reviewSubmissionPage.feedback.description", {
          counterpartyRole,
          orderId: opportunity.order_id,
        })}
        actions={
          <LinkButton href={backHref} tone="secondary">
            {t("reputation.features.reviews.ui.reviewSubmissionPage.back")}</LinkButton>
        }
      />

      <PageSection title={t("reputation.features.reviews.ui.reviewSubmissionPage.verified.order")}>
        <Card>
          <Stack gap={2}>
            <Text>{t("reputation.features.reviews.ui.reviewSubmissionPage.order")}{opportunity.order_id}</Text>
            <Text>{t("reputation.features.reviews.ui.reviewSubmissionPage.counterparty")}{counterpartyLabel}</Text>
            <Text size="sm" tone="secondary">
              {t("reputation.features.reviews.ui.reviewSubmissionPage.reviews.open.only.after.the.order")}</Text>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title={t("reputation.features.reviews.ui.reviewSubmissionPage.your.review")}>
        <Card>
          <Stack gap={3}>
            {errorMessage ? <Text>{errorMessage}</Text> : null}
            <form method="post">
              <Stack gap={3}>
                <input type="hidden" name="rating" value={rating} />
                <Stack gap={1}>
                  <Text weight="semibold">{t("reputation.features.reviews.ui.reviewSubmissionPage.rating")}</Text>
                  <Rating
                    interactive
                    label={t("reputation.features.reviews.ui.reviewSubmissionPage.review.rating")}
                    value={rating}
                    onValueChange={setRating}
                  />
                </Stack>
                <Textarea
                  name="feedback"
                  label={t("reputation.features.reviews.ui.reviewSubmissionPage.feedback")}
                  defaultValue={defaultFeedback}
                  rows={5}
                  description={t("reputation.features.reviews.ui.reviewSubmissionPage.tell.the.account.what.went.well")}
                />
                <Button type="submit">
                  {isSubmitting ? t("reputation.features.reviews.ui.reviewSubmissionPage.submitting.review") : t("reputation.features.reviews.ui.reviewSubmissionPage.submit.account.review")}
                </Button>
              </Stack>
            </form>
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
