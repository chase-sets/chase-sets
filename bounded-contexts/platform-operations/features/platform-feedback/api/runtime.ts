import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  ExperienceDomainError,
  normalizeRelatedEntities,
  normalizeRequiredText,
  normalizeWorkflow,
  relatedEntityKey,
  type PlatformFeedbackRelatedEntity,
  type PlatformFeedbackTopic,
  type PlatformFeedbackWorkflow,
} from "../domain/common";
import {
  decidePlatformFeedback,
  evolvePlatformFeedback,
  initialPlatformFeedbackState,
  type PlatformFeedbackCommand,
  type PlatformFeedbackEvent,
  type PlatformFeedbackState,
} from "../domain/domain";
import { buildPlatformFeedbackProjectionHandlers } from "../read-model/projection";
import {
  getPlatformFeedback,
  getPlatformFeedbackMetrics,
  hasActivePromptSnooze,
  hasRecentPlatformFeedbackSubmission,
  listPlatformFeedback,
} from "../read-model/queries";

type PlatformFeedbackRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
}>;

export type PlatformFeedbackServices = Readonly<{
  commandHandler: CommandHandler<PlatformFeedbackCommand, PlatformFeedbackState, PlatformFeedbackEvent>;
  submitPlatformFeedback: (
    params: Readonly<{
      userId: string;
      accountId: string;
      rating: number;
      topic: PlatformFeedbackTopic;
      comment?: string | null;
      followUpConsent: boolean;
      workflow: PlatformFeedbackWorkflow;
      sourceRoutePath: string;
      relatedEntities?: readonly PlatformFeedbackRelatedEntity[];
    }>,
    context: EventStoreContext,
  ) => Promise<{ feedbackId: string; version: number }>;
  dismissPrompt: (
    params: Readonly<{
      userId: string;
      accountId: string;
      workflow: PlatformFeedbackWorkflow;
      sourceRoutePath: string;
      relatedEntities?: readonly PlatformFeedbackRelatedEntity[];
    }>,
    context: EventStoreContext,
  ) => Promise<{ promptId: string; version: number; snoozedUntil: string }>;
  getPromptEligibility: (
    params: Readonly<{
      accountId: string;
      workflow: PlatformFeedbackWorkflow;
      relatedEntities?: readonly PlatformFeedbackRelatedEntity[];
    }>,
  ) => Promise<{ shouldPrompt: boolean; reason: "eligible" | "recent-submission" | "snoozed" }>;
  markReviewed: (
    feedbackId: string,
    reviewedByUserId: string,
    context: EventStoreContext,
  ) => Promise<{ feedbackId: string; version: number }>;
  archive: (
    feedbackId: string,
    archivedByUserId: string,
    context: EventStoreContext,
  ) => Promise<{ feedbackId: string; version: number }>;
  listPlatformFeedback: (params: Parameters<typeof listPlatformFeedback>[1]) => ReturnType<typeof listPlatformFeedback>;
  getPlatformFeedback: (feedbackId: string) => ReturnType<typeof getPlatformFeedback>;
  getPlatformFeedbackMetrics: () => ReturnType<typeof getPlatformFeedbackMetrics>;
  projectors: readonly ProjectionHandlerSet[];
}>;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function submissionWindowStart(now: Date) {
  return new Date(now.getTime() - THIRTY_DAYS_MS).toISOString();
}

function snoozedUntil(now: Date) {
  return new Date(now.getTime() + SEVEN_DAYS_MS).toISOString();
}

function stablePromptId(accountId: string, workflow: string, key: string | null) {
  return ["pfp", accountId, workflow, key ?? "workflow"].join("-").replace(/[^A-Za-z0-9_-]/g, "-");
}

async function requireFeedback(db: PgQueryable, feedbackId: string) {
  const feedback = await getPlatformFeedback(db, feedbackId);
  if (!feedback) {
    throw new ExperienceDomainError("Platform feedback not found.");
  }

  return feedback;
}

export function createPlatformFeedbackRuntime(deps: PlatformFeedbackRuntimeDeps): PlatformFeedbackServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<PlatformFeedbackEvent>(),
    initialState: () => initialPlatformFeedbackState,
    evolve: evolvePlatformFeedback,
    decide: decidePlatformFeedback,
  });

  async function ensureSubmissionAllowed(
    params: Readonly<{
      accountId: string;
      workflow: string;
      relatedEntityKey: string | null;
      now: Date;
    }>,
  ) {
    const hasDuplicate = await hasRecentPlatformFeedbackSubmission(deps.db, {
      accountId: params.accountId,
      workflow: params.workflow,
      relatedEntityKey: params.relatedEntityKey,
      submittedAfter: submissionWindowStart(params.now),
    });

    if (hasDuplicate) {
      throw new ExperienceDomainError("Platform feedback has already been submitted for this workflow.");
    }
  }

  return {
    commandHandler,
    async submitPlatformFeedback(params, context) {
      const now = new Date();
      const workflow = normalizeWorkflow(params.workflow);
      const relatedEntities = normalizeRelatedEntities(params.relatedEntities);
      const key = relatedEntityKey(relatedEntities);
      await ensureSubmissionAllowed({
        accountId: params.accountId,
        workflow,
        relatedEntityKey: key,
        now,
      });

      const feedbackId = createId("pfb");
      const result = await commandHandler({
        streamId: `experience.platform-feedback-${feedbackId}`,
        command: {
          type: "SubmitPlatformFeedback",
          feedbackId,
          userId: normalizeRequiredText(params.userId, "User is required."),
          accountId: normalizeRequiredText(params.accountId, "Account is required."),
          rating: params.rating,
          topic: params.topic,
          comment: params.comment,
          followUpConsent: Boolean(params.followUpConsent),
          workflow,
          sourceRoutePath: params.sourceRoutePath,
          relatedEntities,
          submittedAt: now.toISOString(),
        },
        context,
      });

      return { feedbackId, version: result.version };
    },
    async dismissPrompt(params, context) {
      const now = new Date();
      const workflow = normalizeWorkflow(params.workflow);
      const relatedEntities = normalizeRelatedEntities(params.relatedEntities);
      const key = relatedEntityKey(relatedEntities);
      const promptId = stablePromptId(params.accountId, workflow, key);
      const until = snoozedUntil(now);
      const result = await commandHandler({
        streamId: `experience.platform-feedback-prompt-${promptId}`,
        command: {
          type: "DismissPlatformFeedbackPrompt",
          promptId,
          userId: normalizeRequiredText(params.userId, "User is required."),
          accountId: normalizeRequiredText(params.accountId, "Account is required."),
          workflow,
          sourceRoutePath: params.sourceRoutePath,
          relatedEntities,
          dismissedAt: now.toISOString(),
          snoozedUntil: until,
        },
        context,
      });

      return { promptId, version: result.version, snoozedUntil: until };
    },
    async getPromptEligibility(params) {
      const now = new Date();
      const workflow = normalizeWorkflow(params.workflow);
      const key = relatedEntityKey(params.relatedEntities);
      const hasSubmission = await hasRecentPlatformFeedbackSubmission(deps.db, {
        accountId: params.accountId,
        workflow,
        relatedEntityKey: key,
        submittedAfter: submissionWindowStart(now),
      });
      if (hasSubmission) {
        return { shouldPrompt: false, reason: "recent-submission" };
      }

      const isSnoozed = await hasActivePromptSnooze(deps.db, {
        accountId: params.accountId,
        workflow,
        relatedEntityKey: key,
        now: now.toISOString(),
      });
      if (isSnoozed) {
        return { shouldPrompt: false, reason: "snoozed" };
      }

      return { shouldPrompt: true, reason: "eligible" };
    },
    async markReviewed(feedbackId, reviewedByUserId, context) {
      const feedback = await requireFeedback(deps.db, feedbackId);
      const result = await commandHandler({
        streamId: `experience.platform-feedback-${feedback.feedback_id}`,
        command: {
          type: "MarkPlatformFeedbackReviewed",
          reviewedByUserId,
          reviewedAt: new Date().toISOString(),
        },
        context,
      });

      return { feedbackId: feedback.feedback_id, version: result.version };
    },
    async archive(feedbackId, archivedByUserId, context) {
      const feedback = await requireFeedback(deps.db, feedbackId);
      const result = await commandHandler({
        streamId: `experience.platform-feedback-${feedback.feedback_id}`,
        command: {
          type: "ArchivePlatformFeedback",
          archivedByUserId,
          archivedAt: new Date().toISOString(),
        },
        context,
      });

      return { feedbackId: feedback.feedback_id, version: result.version };
    },
    listPlatformFeedback: (params) => listPlatformFeedback(deps.db, params),
    getPlatformFeedback: (feedbackId) => getPlatformFeedback(deps.db, feedbackId),
    getPlatformFeedbackMetrics: () => getPlatformFeedbackMetrics(deps.db),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "experience-platform-feedback-projection",
        handlers: buildPlatformFeedbackProjectionHandlers(deps.db),
        // Feedback events keep their durable experience. stream prefix, so the
        // platform-operations default (`platform-operations.`) must not apply.
        streamPrefixes: ["experience."],
      }),
    ],
  };
}
