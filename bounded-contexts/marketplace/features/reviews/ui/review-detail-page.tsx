import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Card,
  Form,
  LinkButton,
  MarketplaceEmptyState,
  MarketplaceNotice,
  Page,
  PageHeader,
  PageSection,
  ReviewCard,
  Stack,
  Text,
  Textarea,
  HiddenInput,
} from "@chase-sets/design-system";
import type { ReviewDetail } from "./contracts";
import { ReviewReportAction, type ReviewReportResult } from "./review-report-action";
import { ReviewScoringContext } from "./review-scoring-context";

function statusTone(status: string) {
  return status === "withdrawn" ? "danger" : "success";
}

// Double-blind reveal (m108): rating === null means this row was
// redacted for the subject's own view of a not-yet-revealed review.
function isPending(review: ReviewDetail) {
  return review.status !== "withdrawn" && review.revealed_at === null;
}

// Subject reply compose gating (m108): only the review's subject may reply,
// only once the review is revealed and still active, and only once ever --
// one round, no flame wars. reply_id stays set after an operator withdraws a
// reply, so a withdrawn reply cannot be re-posted.
function canComposeReply(review: ReviewDetail, viewerAccountId: string | null | undefined) {
  return (
    viewerAccountId != null &&
    viewerAccountId === review.subject_account_id &&
    review.status === "active" &&
    review.revealed_at !== null &&
    !review.held &&
    review.reply_id === null
  );
}

function canReportReview(review: ReviewDetail, viewerAccountId: string | null | undefined) {
  return (
    viewerAccountId != null &&
    review.status === "active" &&
    review.revealed_at !== null &&
    !review.held &&
    review.feedback_redacted_at === null
  );
}

export function ReviewDetailPage({
  backHref,
  orderHref,
  review,
  viewerAccountId,
  replyErrorMessage,
  isSubmittingReply = false,
  defaultReplyFeedback = "",
  reportResult,
  reportStatus,
  isSubmittingReport = false,
}: {
  backHref: string;
  orderHref?: string;
  review: ReviewDetail;
  viewerAccountId?: string | null;
  replyErrorMessage?: string | null;
  isSubmittingReply?: boolean;
  defaultReplyFeedback?: string;
  reportResult?: ReviewReportResult | null;
  reportStatus?: "submitted" | null;
  isSubmittingReport?: boolean;
}) {
  const pending = isPending(review);
  const showReplyForm = canComposeReply(review, viewerAccountId);
  const showReportAction = canReportReview(review, viewerAccountId);
  const resolvedReportResult =
    reportResult ??
    (reportStatus === "submitted" ? { reviewId: review.review_id, status: "submitted" as const } : null);

  return (
    <Page>
      <PageHeader
        eyebrow={t("reputation.features.reviews.ui.reviewDetailPage.review")}
        title={t("reputation.features.reviews.ui.reviewDetailPage.review.details")}
        description={t("reputation.features.reviews.ui.reviewDetailPage.verified.order.feedback")}
        actions={
          <Stack direction="row" gap={2}>
            {orderHref ? (
              <LinkButton href={orderHref}>
                {t("reputation.features.reviews.ui.reviewDetailPage.view.order.outcome")}
              </LinkButton>
            ) : null}
            <LinkButton href={backHref} tone="secondary">
              {t("reputation.features.reviews.ui.reviewDetailPage.back")}
            </LinkButton>
          </Stack>
        }
      />

      <PageSection title={t("reputation.features.reviews.ui.reviewDetailPage.summary")}>
        {review.held && review.rating === null ? (
          <MarketplaceEmptyState
            title={t("reputation.features.reviews.ui.reviewDetailPage.feedback.on.hold.title")}
            description={t("reputation.features.reviews.ui.reviewDetailPage.feedback.on.hold.description")}
          />
        ) : review.rating === null ? (
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
                {review.held ? (
                  <Badge tone="warning">
                    {t("reputation.features.reviews.ui.reviewDetailPage.feedback.on.hold.badge")}
                  </Badge>
                ) : null}
                {review.scoring_disposition === "context-only" ? (
                  <Badge tone="neutral">{t("reputation.features.reviews.ui.context.only.rating.explanation")}</Badge>
                ) : null}
                {review.withdrawn_by_actor_type === "operator" ? (
                  <Badge tone="danger">
                    {t("reputation.features.reviews.ui.reviewDetailPage.moderated.withdrawn")}
                  </Badge>
                ) : null}
                {review.feedback_redacted_at !== null ? (
                  <Badge tone="danger">{t("reputation.features.reviews.ui.reviewDetailPage.moderated.redacted")}</Badge>
                ) : null}
              </Stack>
            }
            verified
            response={review.reply_status === "active" && review.reply_feedback ? review.reply_feedback : undefined}
            responseLabel={t("reputation.features.reviews.ui.reviewDetailPage.reply.label")}
            context={<ReviewScoringContext review={review} />}
            actions={
              showReportAction ? (
                <ReviewReportAction
                  reviewId={review.review_id}
                  result={resolvedReportResult}
                  isSubmitting={isSubmittingReport}
                />
              ) : undefined
            }
          />
        )}
      </PageSection>

      {showReplyForm ? (
        <PageSection title={t("reputation.features.reviews.ui.reviewDetailPage.reply.title")}>
          <Card elevation="tinted">
            <Stack gap={3}>
              <Text size="sm" tone="secondary">
                {t("reputation.features.reviews.ui.reviewDetailPage.reply.description")}
              </Text>
              {replyErrorMessage ? (
                <MarketplaceNotice
                  tone="danger"
                  title={t("reputation.features.reviews.ui.reviewDetailPage.reply.title")}
                  description={replyErrorMessage}
                />
              ) : null}
              <Form spacing="none" method="post">
                <Stack gap={3}>
                  <HiddenInput type="hidden" name="intent" value="reply" readOnly />
                  <Textarea
                    name="feedback"
                    label={t("reputation.features.reviews.ui.reviewDetailPage.reply.feedback")}
                    defaultValue={defaultReplyFeedback}
                    rows={4}
                    required
                    maxLength={1000}
                    description={t("reputation.features.reviews.ui.reviewDetailPage.reply.feedback.description")}
                  />
                  <Button type="submit">
                    {isSubmittingReply
                      ? t("reputation.features.reviews.ui.reviewDetailPage.reply.submitting")
                      : t("reputation.features.reviews.ui.reviewDetailPage.reply.submit")}
                  </Button>
                </Stack>
              </Form>
            </Stack>
          </Card>
        </PageSection>
      ) : null}
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
