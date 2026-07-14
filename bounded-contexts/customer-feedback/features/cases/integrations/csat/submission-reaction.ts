import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CsatSurveySubmittedEvent } from "../../../csat/domain/invitation";
import type { OpenFeedbackCaseFromSubmissionParams } from "../../api/runtime";

type OpenFromSubmission = (
  params: OpenFeedbackCaseFromSubmissionParams,
  context: EventStoreContext,
) => Promise<unknown>;

const automatedCaseActor = {
  actorId: "customer-feedback.case-opening-policy",
  authority: "manage-feedback-cases",
} as const;

export function buildFeedbackCaseOpeningReactionHandlers(openFromSubmission: OpenFromSubmission): ProjectorHandlerMap {
  return {
    "customer-feedback.survey.submitted": async (event) => {
      const submission = event.data as CsatSurveySubmittedEvent["data"];
      if (submission.rating > 3) return;
      await openFromSubmission(
        {
          submission,
          openReason: "low-score",
          actor: automatedCaseActor,
          openedAt: submission.submittedAt,
        },
        { tenantId: event.tenantId, audit: event.audit, trace: event.trace },
      );
    },
  };
}
