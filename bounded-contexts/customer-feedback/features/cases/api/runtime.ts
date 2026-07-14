import { createHash } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { CsatInvitationId, CsatSurveySubmittedEvent } from "../../csat/domain/invitation";
import {
  decideFeedbackCase,
  evolveFeedbackCase,
  initialFeedbackCaseState,
  FeedbackCaseDecisionError,
  type FeedbackCaseActor,
  type FeedbackCaseCommand,
  type FeedbackCaseEvent,
  type FeedbackCaseId,
  type FeedbackCaseOpenReason,
} from "../domain";
import { buildFeedbackCaseProjectionHandlers } from "../read-model/projection";
import { getFeedbackCaseStreamId } from "../read-model/queries";
import { getSubmittedCsatResponseForCase } from "../integrations/csat/submitted-response-source";

export type FeedbackCaseRuntimeDeps = Readonly<{ eventStore: EventStore; db: PgQueryable }>;

export type OpenFeedbackCaseFromSubmissionParams = Readonly<{
  submission: CsatSurveySubmittedEvent["data"];
  openReason: FeedbackCaseOpenReason;
  actor: FeedbackCaseActor;
  openedAt?: string;
}>;

export type FeedbackCaseLifecycleCommand = Exclude<FeedbackCaseCommand, { type: "OpenFeedbackCase" }>;

export function createFeedbackCaseRuntime(deps: FeedbackCaseRuntimeDeps) {
  const codec = createPassthroughDomainEventCodec<FeedbackCaseEvent>();
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec,
    initialState: () => initialFeedbackCaseState,
    evolve: evolveFeedbackCase,
    decide: decideFeedbackCase,
  });

  const openFromSubmission = async (params: OpenFeedbackCaseFromSubmissionParams, context: EventStoreContext) => {
    const streamId = feedbackCaseStreamId(params.submission.invitationId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await repository.load(streamId);
      if (existing.state.feedbackCase) {
        if (existing.state.feedbackCase.sourceResponse.invitationId !== params.submission.invitationId) {
          throw new FeedbackCaseDecisionError(
            "case-already-opened",
            "Feedback case stream belongs to a different response.",
            existing.state.feedbackCase.status,
          );
        }
        return existing.state.feedbackCase;
      }

      const command: FeedbackCaseCommand = {
        type: "OpenFeedbackCase",
        caseId: createId("fbcase"),
        submission: params.submission,
        openReason: params.openReason,
        actor: params.actor,
        actedAt: params.openedAt ?? params.submission.submittedAt,
      };
      const events = decideFeedbackCase(initialFeedbackCaseState, command);
      try {
        await deps.eventStore.appendToStream({
          streamId,
          expectedVersion: "no_stream",
          context,
          events: events.map(codec.encode),
        });
        return requireCase(events.reduce(evolveFeedbackCase, initialFeedbackCaseState).feedbackCase);
      } catch (error) {
        if (!isConcurrencyConflict(error)) throw error;
      }
    }
    throw new Error("Feedback case opening exceeded its concurrency retry budget.");
  };

  return {
    openFromSubmission,
    flagSubmittedResponse: async (
      invitationId: CsatInvitationId,
      actor: FeedbackCaseActor,
      flaggedAt: string,
      context: EventStoreContext,
    ) => {
      const submission = await getSubmittedCsatResponseForCase(deps.db, invitationId);
      if (!submission) {
        throw new FeedbackCaseDecisionError(
          "invalid-source-response",
          "Only a projected submitted CSAT response can be flagged for case work.",
          null,
        );
      }
      return openFromSubmission({ submission, openReason: "flagged", actor, openedAt: flaggedAt }, context);
    },
    executeByCaseId: async (
      caseId: FeedbackCaseId,
      command: FeedbackCaseLifecycleCommand,
      context: EventStoreContext,
    ) => {
      const streamId = await getFeedbackCaseStreamId(deps.db, caseId);
      if (!streamId) throw new FeedbackCaseDecisionError("case-not-found", "Feedback case does not exist.", null);
      const result = await commandHandler({ streamId, command, context });
      return requireCase(result.state.feedbackCase);
    },
    commandHandler,
    projectors: [
      createProjectionHandlerSet({
        projectionName: "customer-feedback-feedback-case-projection",
        handlers: buildFeedbackCaseProjectionHandlers(deps.db),
      }),
    ] as readonly ProjectionHandlerSet[],
  };
}

export function feedbackCaseStreamId(invitationId: string): string {
  const digest = createHash("sha256").update(invitationId).digest("hex");
  return `customer-feedback.feedback-case-${digest}`;
}

function requireCase<T>(feedbackCase: T | null): T {
  if (feedbackCase === null) throw new Error("Feedback case command completed without aggregate state.");
  return feedbackCase;
}

function isConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}
