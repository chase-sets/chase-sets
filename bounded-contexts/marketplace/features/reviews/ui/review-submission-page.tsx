import { t } from "@chase-sets/localization";
import { useEffect, useRef, useState } from "react";
import {
  HiddenInput,
  Form,
  OrderProtectionModule,
  Button,
  Card,
  Checkbox,
  CheckboxGroup,
  DetailConfidenceModule,
  LinkButton,
  MarketplaceEmptyState,
  MarketplaceNotice,
  Page,
  PageHeader,
  PageSection,
  Rating,
  Stack,
  Text,
  Textarea,
} from "@chase-sets/design-system";
import type { ReviewOpportunity } from "./contracts";
import {
  intakeFlowForProblemCategory,
  isReviewProblemCategory,
  resolutionTriggerReason,
  shouldRouteToResolution,
  trackReviewResolutionEvent,
  type ReviewProblemCategory,
} from "./review-resolution";

function getCounterpartyRole(authorRole: string) {
  return authorRole === "buyer" ? "seller" : "buyer";
}

/** Intake availability supplied by the route; defaults to available. */
export interface ReviewResolutionOptions {
  intakeAvailable?: boolean;
  intakeUnavailableReason?: string | null;
}

const PROBLEM_CATEGORY_LABEL_KEYS: Readonly<Record<ReviewProblemCategory, string>> = {
  "not-received": "reputation.features.reviews.ui.reviewSubmissionPage.problem.category.notReceived",
  damaged: "reputation.features.reviews.ui.reviewSubmissionPage.problem.category.damaged",
  "not-as-described": "reputation.features.reviews.ui.reviewSubmissionPage.problem.category.notAsDescribed",
  "missing-items": "reputation.features.reviews.ui.reviewSubmissionPage.problem.category.missingItems",
  authenticity: "reputation.features.reviews.ui.reviewSubmissionPage.problem.category.authenticity",
  other: "reputation.features.reviews.ui.reviewSubmissionPage.problem.category.other",
};

function draftStorageKey(orderId: string) {
  return `chase-sets:review-draft:${orderId}`;
}

export function ReviewSubmissionPage({
  backHref,
  opportunity,
  errorMessage,
  isSubmitting = false,
  defaultRating = 5,
  defaultFeedback = "",
  resolution,
}: {
  backHref: string;
  opportunity: ReviewOpportunity;
  errorMessage?: string | null;
  isSubmitting?: boolean;
  defaultRating?: number;
  defaultFeedback?: string;
  resolution?: ReviewResolutionOptions;
}) {
  const [rating, setRating] = useState(defaultRating);
  const [feedback, setFeedback] = useState(defaultFeedback);
  const [problemCategories, setProblemCategories] = useState<readonly ReviewProblemCategory[]>([]);
  const [interstitialOpen, setInterstitialOpen] = useState(false);
  const [feedbackOnlyAcknowledged, setFeedbackOnlyAcknowledged] = useState(false);
  const feedbackOnlyRef = useRef(false);
  const interstitialHeadingRef = useRef<HTMLHeadingElement>(null);

  const counterpartyRole = getCounterpartyRole(opportunity.author_role);
  const counterpartyLabel = opportunity.subject_display_name ?? opportunity.subject_account_id;
  const isBuyerAuthor = opportunity.author_role === "buyer";
  const intakeAvailable = resolution?.intakeAvailable ?? true;
  const supportOrderHref = `/account/support?orderId=${encodeURIComponent(opportunity.order_id)}`;
  const primaryCategory = problemCategories[0] ?? null;
  const resolveHref = primaryCategory
    ? `${supportOrderHref}&flow=${encodeURIComponent(intakeFlowForProblemCategory(primaryCategory))}`
    : supportOrderHref;
  const triggerReason = resolutionTriggerReason({ rating, problemCategories });

  // Resume a locally-preserved draft only once the review direction is eligible
  // again (support hold ended and the window is still open). The draft is never
  // published or copied into evidence; it lives only in this browser.
  useEffect(() => {
    if (opportunity.submission_state !== "allowed" || opportunity.window_expired) {
      return;
    }
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem(draftStorageKey(opportunity.order_id));
    } catch {
      stored = null;
    }
    if (!stored) {
      return;
    }
    try {
      const draft = JSON.parse(stored) as {
        rating?: unknown;
        feedback?: unknown;
        problemCategories?: unknown;
      };
      if (typeof draft.rating === "number") {
        setRating(draft.rating);
      }
      if (typeof draft.feedback === "string") {
        setFeedback(draft.feedback);
      }
      if (Array.isArray(draft.problemCategories)) {
        setProblemCategories(
          draft.problemCategories.filter(
            (value): value is ReviewProblemCategory => typeof value === "string" && isReviewProblemCategory(value),
          ),
        );
      }
      window.sessionStorage.removeItem(draftStorageKey(opportunity.order_id));
      trackReviewResolutionEvent("review_resolution_draft_resumed", {});
    } catch {
      // A malformed draft is discarded silently; the form falls back to defaults.
    }
  }, [opportunity.order_id, opportunity.submission_state, opportunity.window_expired]);

  useEffect(() => {
    if (interstitialOpen) {
      interstitialHeadingRef.current?.focus();
      trackReviewResolutionEvent("review_resolution_interstitial_shown", {
        triggerCategory: triggerReason,
        paymentProtection: isBuyerAuthor,
        intakeAvailable,
      });
      if (!intakeAvailable) {
        trackReviewResolutionEvent("review_resolution_intake_unavailable", { triggerCategory: triggerReason });
      }
    }
    // Firing analytics is intentionally tied to the open transition only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interstitialOpen]);

  function openInterstitial() {
    setInterstitialOpen(true);
  }

  function dismissInterstitial() {
    setInterstitialOpen(false);
    trackReviewResolutionEvent("review_resolution_abandoned", { triggerCategory: triggerReason });
  }

  function handleResolveFirst() {
    try {
      window.sessionStorage.setItem(
        draftStorageKey(opportunity.order_id),
        JSON.stringify({ rating, feedback, problemCategories }),
      );
    } catch {
      // If the draft cannot be persisted we still route to resolution; the
      // buyer keeps their protections. The draft simply will not auto-resume.
    }
    trackReviewResolutionEvent("review_resolution_resolve_first_selected", { triggerCategory: triggerReason });
    trackReviewResolutionEvent(
      "review_resolution_case_routed",
      primaryCategory ? { triggerCategory: primaryCategory } : {},
    );
  }

  function handleFeedbackOnly() {
    feedbackOnlyRef.current = true;
    setFeedbackOnlyAcknowledged(true);
    trackReviewResolutionEvent("review_resolution_feedback_only_selected", { triggerCategory: triggerReason });
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (!isBuyerAuthor || feedbackOnlyRef.current) {
      return;
    }
    if (!shouldRouteToResolution({ rating, problemCategories })) {
      return;
    }
    event.preventDefault();
    openInterstitial();
  }

  const problemActionButton = (
    <Button type="button" tone="secondary" onClick={openInterstitial}>
      {t("reputation.features.reviews.ui.reviewSubmissionPage.problem.action")}
    </Button>
  );

  const interstitialPanel = (
    <Card>
      <Stack gap={4}>
        <Stack gap={1}>
          <Text as="h3" weight="semibold" tabIndex={-1} ref={interstitialHeadingRef}>
            {t("reputation.features.reviews.ui.reviewSubmissionPage.resolution.title")}
          </Text>
          <Text tone="secondary">
            {isBuyerAuthor
              ? t("reputation.features.reviews.ui.reviewSubmissionPage.resolution.buyer.description")
              : t("reputation.features.reviews.ui.reviewSubmissionPage.resolution.general.description")}
          </Text>
        </Stack>

        {intakeAvailable ? (
          <MarketplaceNotice
            tone="info"
            title={t("reputation.features.reviews.ui.reviewSubmissionPage.resolution.primary.title")}
            description={
              isBuyerAuthor
                ? t("reputation.features.reviews.ui.reviewSubmissionPage.resolution.primary.description")
                : t("reputation.features.reviews.ui.reviewSubmissionPage.resolution.general.primary.description")
            }
            action={
              <LinkButton href={resolveHref} tone="primary" onClick={handleResolveFirst}>
                {t("reputation.features.reviews.ui.reviewSubmissionPage.resolution.primary.action")}
              </LinkButton>
            }
          />
        ) : (
          <MarketplaceNotice
            tone="warning"
            title={t("reputation.features.reviews.ui.reviewSubmissionPage.resolution.unavailable.title")}
            description={
              resolution?.intakeUnavailableReason ??
              t("reputation.features.reviews.ui.reviewSubmissionPage.resolution.unavailable.description")
            }
          />
        )}

        {isBuyerAuthor ? (
          <MarketplaceNotice
            tone="neutral"
            title={t("reputation.features.reviews.ui.reviewSubmissionPage.resolution.secondary.title")}
            description={t("reputation.features.reviews.ui.reviewSubmissionPage.resolution.secondary.description")}
            action={
              <Stack gap={2}>
                <Checkbox
                  name="feedbackOnlyAcknowledged"
                  value="true"
                  checked={feedbackOnlyAcknowledged}
                  onCheckedChange={(state) => setFeedbackOnlyAcknowledged(state === true)}
                  label={t("reputation.features.reviews.ui.reviewSubmissionPage.resolution.secondary.acknowledge")}
                />
                <Button
                  type="submit"
                  tone="secondary"
                  disabled={!feedbackOnlyAcknowledged}
                  onClick={handleFeedbackOnly}
                >
                  {t("reputation.features.reviews.ui.reviewSubmissionPage.resolution.secondary.action")}
                </Button>
              </Stack>
            }
          />
        ) : null}

        <Text tone="secondary" size="sm">
          {t("reputation.features.reviews.ui.reviewSubmissionPage.resolution.privacy.note")}
        </Text>

        <Button type="button" tone="ghost" onClick={dismissInterstitial}>
          {t("reputation.features.reviews.ui.reviewSubmissionPage.resolution.dismiss")}
        </Button>
      </Stack>
    </Card>
  );

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
            {t("reputation.features.reviews.ui.reviewSubmissionPage.back")}
          </LinkButton>
        }
      />

      <PageSection title={t("reputation.features.reviews.ui.reviewSubmissionPage.verified.order")}>
        <Stack gap={4}>
          <DetailConfidenceModule
            title={t("reputation.features.reviews.ui.reviewSubmissionPage.verified.order")}
            description={t("reputation.features.reviews.ui.reviewSubmissionPage.reviews.open.only.after.the.order")}
            items={[
              {
                label: t("reputation.features.reviews.ui.reviewSubmissionPage.order"),
                value: opportunity.order_id,
              },
              {
                label: t("reputation.features.reviews.ui.reviewSubmissionPage.counterparty"),
                value: counterpartyLabel,
              },
              {
                label: t("reputation.features.reviews.ui.reviewSubmissionPage.reviews"),
                value: counterpartyRole,
              },
            ]}
          />
          <OrderProtectionModule
            title={t("reputation.features.reviews.ui.reviewSubmissionPage.verified.order")}
            items={[
              {
                title: t("reputation.features.reviews.ui.reviewSubmissionPage.reviews.open.only.after.the.order"),
                description: t("reputation.features.reviews.ui.reviewSubmissionPage.feedback.description", {
                  counterpartyRole,
                  orderId: opportunity.order_id,
                }),
              },
              {
                title: t("reputation.features.reviews.ui.reviewSubmissionPage.rating"),
                description: t("reputation.features.reviews.ui.reviewSubmissionPage.tell.the.account.what.went.well"),
              },
              {
                title: t("reputation.features.reviews.ui.reviewSubmissionPage.counterparty"),
                description: counterpartyLabel,
              },
            ]}
          />
        </Stack>
      </PageSection>

      <PageSection title={t("reputation.features.reviews.ui.reviewSubmissionPage.your.review")}>
        {opportunity.submission_state === "held" ? (
          <Card>
            <Stack gap={3}>
              <MarketplaceEmptyState
                title={t("reputation.features.reviews.ui.reviewSubmissionPage.feedback.on.hold.title")}
                description={t("reputation.features.reviews.ui.reviewSubmissionPage.feedback.on.hold.description")}
              />
              <LinkButton
                href={supportOrderHref}
                tone="primary"
                onClick={() =>
                  trackReviewResolutionEvent("review_resolution_existing_case_routed", {
                    paymentProtection: isBuyerAuthor,
                  })
                }
              >
                {t("reputation.features.reviews.ui.reviewSubmissionPage.resolution.track.action")}
              </LinkButton>
            </Stack>
          </Card>
        ) : opportunity.window_expired ? (
          <MarketplaceEmptyState
            title={t("reputation.features.reviews.ui.reviewSubmissionPage.review.window.closed.title")}
            description={t("reputation.features.reviews.ui.reviewSubmissionPage.review.window.closed.description")}
          />
        ) : (
          <Card>
            <Stack gap={3}>
              {errorMessage ? (
                <MarketplaceNotice
                  tone="danger"
                  title={t("reputation.features.reviews.ui.reviewSubmissionPage.your.review")}
                  description={errorMessage}
                />
              ) : null}
              <Form spacing="none" method="post" onSubmit={handleSubmit}>
                <Stack gap={3}>
                  <HiddenInput type="hidden" name="rating" value={rating} />
                  {problemCategories.map((category) => (
                    <HiddenInput key={category} type="hidden" name="problemCategories" value={category} />
                  ))}
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
                    value={feedback}
                    onChange={(event) => setFeedback(event.target.value)}
                    rows={5}
                    description={t(
                      "reputation.features.reviews.ui.reviewSubmissionPage.tell.the.account.what.went.well",
                    )}
                  />
                  {isBuyerAuthor ? (
                    <CheckboxGroup
                      label={t("reputation.features.reviews.ui.reviewSubmissionPage.problem.indicators.label")}
                      description={t(
                        "reputation.features.reviews.ui.reviewSubmissionPage.problem.indicators.description",
                      )}
                      values={[...problemCategories]}
                      onValuesChange={(next) =>
                        setProblemCategories(next.filter(isReviewProblemCategory) as ReviewProblemCategory[])
                      }
                      items={Object.entries(PROBLEM_CATEGORY_LABEL_KEYS).map(([value, labelKey]) => ({
                        value,
                        label: t(labelKey),
                      }))}
                    />
                  ) : null}

                  {interstitialOpen ? (
                    interstitialPanel
                  ) : (
                    <Stack gap={2}>
                      <Button type="submit">
                        {isSubmitting
                          ? t("reputation.features.reviews.ui.reviewSubmissionPage.submitting.review")
                          : t("reputation.features.reviews.ui.reviewSubmissionPage.submit.account.review")}
                      </Button>
                      {problemActionButton}
                    </Stack>
                  )}
                </Stack>
              </Form>
            </Stack>
          </Card>
        )}
      </PageSection>
    </Page>
  );
}
