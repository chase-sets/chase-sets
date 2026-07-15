import { t } from "@chase-sets/localization";
import {
  Button,
  Dialog,
  Form,
  HiddenInput,
  MarketplaceNotice,
  NativeSelect,
  Stack,
  Textarea,
} from "@chase-sets/design-system";

export type ReviewReportResult = Readonly<{
  reviewId: string;
  status: "submitted" | "already-submitted" | "error";
  message?: string;
  values?: Readonly<{ reason: string; details: string }>;
}>;

const reviewReportReasons = [
  {
    value: "harassment-or-abuse",
    label: t("reputation.features.reviews.ui.reviewReportAction.reason.harassment"),
  },
  {
    value: "hate-or-discrimination",
    label: t("reputation.features.reviews.ui.reviewReportAction.reason.hate"),
  },
  {
    value: "personal-information",
    label: t("reputation.features.reviews.ui.reviewReportAction.reason.personalInformation"),
  },
  {
    value: "spam-or-manipulation",
    label: t("reputation.features.reviews.ui.reviewReportAction.reason.spam"),
  },
  { value: "other", label: t("reputation.features.reviews.ui.reviewReportAction.reason.other") },
];

export function ReviewReportAction({
  reviewId,
  result,
  isSubmitting = false,
}: {
  reviewId: string;
  result?: ReviewReportResult | null;
  isSubmitting?: boolean;
}) {
  const matchingResult = result?.reviewId === reviewId ? result : null;
  const submitted = matchingResult?.status === "submitted" || matchingResult?.status === "already-submitted";
  const alreadySubmitted = matchingResult?.status === "already-submitted";
  const error = matchingResult?.status === "error" ? matchingResult.message : null;

  return (
    <Stack gap={2}>
      {submitted ? (
        <MarketplaceNotice
          tone="success"
          title={t(
            alreadySubmitted
              ? "reputation.features.reviews.ui.reviewReportAction.alreadySubmitted"
              : "reputation.features.reviews.ui.reviewReportAction.submitted",
          )}
          description={t(
            alreadySubmitted
              ? "reputation.features.reviews.ui.reviewReportAction.alreadySubmitted.description"
              : "reputation.features.reviews.ui.reviewReportAction.submitted.description",
          )}
        />
      ) : null}
      {error ? (
        <MarketplaceNotice
          tone="danger"
          title={t("reputation.features.reviews.ui.reviewReportAction.failed")}
          description={error}
        />
      ) : null}
      <Dialog
        defaultOpen={Boolean(error)}
        title={t("reputation.features.reviews.ui.reviewReportAction.title")}
        description={t("reputation.features.reviews.ui.reviewReportAction.description")}
        trigger={
          <Button type="button" tone="ghost" leadingIcon="warning" disabled={submitted}>
            {submitted
              ? t(
                  alreadySubmitted
                    ? "reputation.features.reviews.ui.reviewReportAction.alreadySubmitted"
                    : "reputation.features.reviews.ui.reviewReportAction.submitted",
                )
              : t("reputation.features.reviews.ui.reviewReportAction.title")}
          </Button>
        }
      >
        <Form spacing="none" method="post">
          <HiddenInput type="hidden" name="intent" value="report-review" readOnly />
          <HiddenInput type="hidden" name="reviewId" value={reviewId} readOnly />
          <Stack gap={3}>
            <NativeSelect
              name="reason"
              label={t("reputation.features.reviews.ui.reviewReportAction.reason")}
              items={reviewReportReasons}
              defaultValue={matchingResult?.values?.reason}
              required
            />
            <Textarea
              name="details"
              label={t("reputation.features.reviews.ui.reviewReportAction.details")}
              description={t("reputation.features.reviews.ui.reviewReportAction.details.description")}
              defaultValue={matchingResult?.values?.details}
              rows={4}
              maxLength={1000}
            />
            <Button type="submit" tone="secondary" disabled={isSubmitting || submitted}>
              {isSubmitting
                ? t("reputation.features.reviews.ui.reviewReportAction.submitting")
                : t("reputation.features.reviews.ui.reviewReportAction.submit")}
            </Button>
          </Stack>
        </Form>
      </Dialog>
    </Stack>
  );
}
