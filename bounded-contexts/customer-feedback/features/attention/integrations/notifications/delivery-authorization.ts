import type {
  ClaimedNotificationDelivery,
  NotificationDeliveryGuard,
  NotificationDeliveryGuardDecision,
} from "@chase-sets/outbound-messaging";
import type { FeedbackCase, FeedbackCaseId } from "../../../cases/domain";

type LoadFeedbackCase = (caseId: FeedbackCaseId) => Promise<FeedbackCase | null>;

export function createFeedbackNotificationDeliveryGuard(loadFeedbackCase: LoadFeedbackCase): NotificationDeliveryGuard {
  return {
    async evaluateNotificationDelivery(delivery): Promise<NotificationDeliveryGuardDecision> {
      if (delivery.message.messageType !== "customer-feedback.case.follow-up-requested") {
        return { allowed: true };
      }
      const caseId = templateString(delivery, "caseId");
      const consentVersion = templateString(delivery, "consentVersion");
      if (!caseId || !consentVersion) return { allowed: false, reason: "invalid-follow-up-contract" };
      const feedbackCase = await loadFeedbackCase(caseId as FeedbackCaseId);
      if (!feedbackCase) return { allowed: false, reason: "feedback-case-not-found" };
      if (
        feedbackCase.consent.status !== "granted" ||
        feedbackCase.consent.version !== consentVersion ||
        feedbackCase.consent.grantedAt === null
      ) {
        return { allowed: false, reason: "follow-up-consent-inapplicable" };
      }
      if (["duplicate", "spam", "redacted"].includes(feedbackCase.disposition ?? "")) {
        return { allowed: false, reason: "follow-up-disposition-inapplicable" };
      }
      if (feedbackCase.followUpStatus !== "requested") {
        return { allowed: false, reason: "follow-up-no-longer-pending" };
      }
      if (delivery.message.recipientAccountId !== feedbackCase.sourceResponse.subjectAccountId) {
        return { allowed: false, reason: "follow-up-recipient-mismatch" };
      }
      if (delivery.channel.channel !== feedbackCase.followUpChannel) {
        return { allowed: false, reason: "follow-up-channel-mismatch" };
      }
      if (delivery.message.templateVersion !== feedbackCase.followUpTemplateVersion) {
        return { allowed: false, reason: "follow-up-template-mismatch" };
      }
      return { allowed: true };
    },
  };
}

function templateString(delivery: ClaimedNotificationDelivery, key: string): string | null {
  const value = delivery.message.templateData[key];
  return typeof value === "string" && value.trim() ? value : null;
}
