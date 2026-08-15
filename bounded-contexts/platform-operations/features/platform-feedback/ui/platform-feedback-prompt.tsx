import { t } from "@chase-sets/localization";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Inline,
  MarketplaceNotice,
  NativeSelect,
  Rating,
  Stack,
  Surface,
  Text,
  Textarea,
} from "@chase-sets/design-system";
import { createExperienceApiClient, ExperienceApiError } from "../../../support/request-support/api-client";
import type { PlatformFeedbackRelatedEntity, PlatformFeedbackTopic, PlatformFeedbackWorkflow } from "../domain/common";

const topicItems = [
  { value: "ease-of-use", label: t("experience.platformFeedback.topic.easeOfUse") },
  { value: "pricing-fees", label: t("experience.platformFeedback.topic.pricingFees") },
  { value: "product-data-search", label: t("experience.platformFeedback.topic.productDataSearch") },
  { value: "checkout-payment", label: t("experience.platformFeedback.topic.checkoutPayment") },
  { value: "selling-inventory", label: t("experience.platformFeedback.topic.sellingInventory") },
  { value: "performance-reliability", label: t("experience.platformFeedback.topic.performanceReliability") },
  { value: "other", label: t("experience.platformFeedback.topic.other") },
];

function apiErrorMessage(error: unknown) {
  if (error instanceof ExperienceApiError) {
    const body = error.body;
    if (body && typeof body === "object" && "error" in body) {
      const errorBody = (body as { error?: { message?: unknown } }).error;
      if (typeof errorBody?.message === "string") {
        return errorBody.message;
      }
    }
  }

  return error instanceof Error ? error.message : t("experience.platformFeedbackPrompt.couldNotSubmit");
}

export function PlatformFeedbackPrompt({
  workflow,
  relatedEntities = [],
  sourceRoutePath,
  title = t("experience.platformFeedbackPrompt.title"),
  description = t("experience.platformFeedbackPrompt.description"),
  initialShouldPrompt = false,
}: {
  workflow: PlatformFeedbackWorkflow;
  relatedEntities?: readonly PlatformFeedbackRelatedEntity[];
  sourceRoutePath?: string;
  title?: string;
  description?: string;
  initialShouldPrompt?: boolean;
}) {
  const [shouldPrompt, setShouldPrompt] = useState(initialShouldPrompt);
  const [isOpen, setIsOpen] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDismissing, setIsDismissing] = useState(false);
  const [rating, setRating] = useState(5);
  const [topic, setTopic] = useState<PlatformFeedbackTopic>("ease-of-use");
  const [comment, setComment] = useState("");
  const [followUpConsent, setFollowUpConsent] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const api = useMemo(() => createExperienceApiClient(), []);
  const resolvedSourceRoutePath = sourceRoutePath ?? (typeof window === "undefined" ? "/" : window.location.pathname);
  const primaryRelatedEntity = relatedEntities[0];

  useEffect(() => {
    let cancelled = false;
    void api
      .getPromptEligibility({
        workflow,
        relatedEntityType: primaryRelatedEntity?.type,
        relatedEntityId: primaryRelatedEntity?.id,
      })
      .then((result) => {
        if (!cancelled) {
          setShouldPrompt(result.shouldPrompt);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setShouldPrompt(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, primaryRelatedEntity?.id, primaryRelatedEntity?.type, workflow]);

  async function handleDismiss() {
    setIsDismissing(true);
    setErrorMessage(null);
    try {
      await api.dismissPlatformFeedbackPrompt({
        workflow,
        sourceRoutePath: resolvedSourceRoutePath,
        relatedEntities,
      });
      setShouldPrompt(false);
    } catch (error) {
      setErrorMessage(apiErrorMessage(error));
    } finally {
      setIsDismissing(false);
    }
  }

  async function handleSubmit() {
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await api.submitPlatformFeedback({
        rating,
        topic,
        comment,
        followUpConsent,
        workflow,
        sourceRoutePath: resolvedSourceRoutePath,
        relatedEntities,
      });
      setIsSubmitted(true);
      setIsOpen(false);
    } catch (error) {
      setErrorMessage(apiErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!shouldPrompt || isSubmitted) {
    return isSubmitted ? (
      <MarketplaceNotice
        tone="success"
        title={t("experience.platformFeedbackPrompt.thanks")}
        description={t("experience.platformFeedbackPrompt.thanksDescription")}
      />
    ) : null;
  }

  return (
    <Surface elevation="tinted" data-elevation-role="furniture">
      <Stack gap={3}>
        <Inline gap={2}>
          <Badge tone="accent">{t("experience.platformFeedbackPrompt.badge")}</Badge>
          <Text weight="semibold">{title}</Text>
        </Inline>
        <Text tone="secondary">{description}</Text>
        {errorMessage ? (
          <MarketplaceNotice
            tone="danger"
            title={t("experience.platformFeedbackPrompt.issue")}
            description={errorMessage}
          />
        ) : null}
        {isOpen ? (
          <Stack gap={3}>
            <Stack gap={1}>
              <Text weight="semibold">{t("experience.platformFeedbackPrompt.rating")}</Text>
              <Rating
                interactive
                label={t("experience.platformFeedbackPrompt.rating")}
                value={rating}
                onValueChange={setRating}
              />
            </Stack>
            <NativeSelect
              label={t("experience.platformFeedbackPrompt.topic")}
              items={topicItems}
              value={topic}
              onChange={(event) => setTopic(event.currentTarget.value as PlatformFeedbackTopic)}
              required
            />
            <Textarea
              label={t("experience.platformFeedbackPrompt.comment")}
              description={t("experience.platformFeedbackPrompt.commentDescription")}
              value={comment}
              maxLength={1000}
              onChange={(event) => setComment(event.currentTarget.value)}
              rows={4}
            />
            <Checkbox
              label={t("experience.platformFeedbackPrompt.followUp")}
              description={t("experience.platformFeedbackPrompt.followUpDescription")}
              checked={followUpConsent}
              onCheckedChange={(checked) => setFollowUpConsent(checked === true)}
            />
            <Inline gap={2}>
              <Button
                type="button"
                loading={isSubmitting}
                disabled={isSubmitting}
                onClick={handleSubmit}
                leadingIcon="message"
              >
                {t("experience.platformFeedbackPrompt.submit")}
              </Button>
              <Button type="button" tone="secondary" onClick={() => setIsOpen(false)}>
                {t("experience.platformFeedbackPrompt.cancel")}
              </Button>
            </Inline>
          </Stack>
        ) : (
          <Inline gap={2}>
            <Button type="button" onClick={() => setIsOpen(true)} leadingIcon="message">
              {t("experience.platformFeedbackPrompt.leaveFeedback")}
            </Button>
            <Button
              type="button"
              tone="secondary"
              loading={isDismissing}
              disabled={isDismissing}
              onClick={handleDismiss}
            >
              {t("experience.platformFeedbackPrompt.notNow")}
            </Button>
          </Inline>
        )}
      </Stack>
    </Surface>
  );
}
