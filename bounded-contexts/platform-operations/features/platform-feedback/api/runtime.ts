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
  recordOperatorNote: (
    feedbackId: string,
    params: Readonly<{
      body: string;
      recordedByUserId: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ feedbackId: string; version: number; noteId: string }>;
  bulkMarkReviewed: (
    feedbackIds: readonly string[],
    reviewedByUserId: string,
    context: EventStoreContext,
  ) => Promise<{
    action: "reviewed";
    updated: number;
    skipped: number;
    items: readonly { feedbackId: string; version: number }[];
  }>;
  bulkArchive: (
    feedbackIds: readonly string[],
    archivedByUserId: string,
    context: EventStoreContext,
  ) => Promise<{
    action: "archived";
    updated: number;
    skipped: number;
    items: readonly { feedbackId: string; version: number }[];
  }>;
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

  type BulkActionResult<Action extends "reviewed" | "archived"> = {
    action: Action;
    updated: number;
    skipped: number;
    items: { feedbackId: string; version: number }[];
  };

  async function applyBulkAction(
    feedbackIds: readonly string[],
    action: "reviewed",
    userId: string,
    context: EventStoreContext,
  ): Promise<BulkActionResult<"reviewed">>;
  async function applyBulkAction(
    feedbackIds: readonly string[],
    action: "archived",
    userId: string,
    context: EventStoreContext,
  ): Promise<BulkActionResult<"archived">>;
  async function applyBulkAction(
    feedbackIds: readonly string[],
    action: "reviewed" | "archived",
    userId: string,
    context: EventStoreContext,
  ): Promise<BulkActionResult<"reviewed" | "archived">> {
    const uniqueIds = [...new Set(feedbackIds.map((id) => id.trim()).filter(Boolean))];
    const items: { feedbackId: string; version: number }[] = [];
    let skipped = 0;

    for (const feedbackId of uniqueIds) {
      const feedback = await requireFeedback(deps.db, feedbackId);
      if ((action === "reviewed" && feedback.status === "reviewed") || feedback.status === "archived") {
        skipped += 1;
        continue;
      }

      items.push(
        action === "reviewed"
          ? await api.markReviewed(feedbackId, userId, context)
          : await api.archive(feedbackId, userId, context),
      );
    }

    return {
      action,
      updated: items.length,
      skipped,
      items,
    };
  }

  const api: PlatformFeedbackServices = {
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
        streamId: `platform-operations.platform-feedback-${feedbackId}`,
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
        streamId: `platform-operations.platform-feedback-prompt-${promptId}`,
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
        streamId: `platform-operations.platform-feedback-${feedback.feedback_id}`,
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
        streamId: `platform-operations.platform-feedback-${feedback.feedback_id}`,
        command: {
          type: "ArchivePlatformFeedback",
          archivedByUserId,
          archivedAt: new Date().toISOString(),
        },
        context,
      });

      return { feedbackId: feedback.feedback_id, version: result.version };
    },
    async recordOperatorNote(feedbackId, params, context) {
      const feedback = await requireFeedback(deps.db, feedbackId);
      const noteId = createId("pfn");
      const result = await commandHandler({
        streamId: `platform-operations.platform-feedback-${feedback.feedback_id}`,
        command: {
          type: "RecordPlatformFeedbackOperatorNote",
          noteId,
          body: params.body,
          recordedByUserId: params.recordedByUserId,
          recordedAt: new Date().toISOString(),
        },
        context,
      });

      return { feedbackId: feedback.feedback_id, version: result.version, noteId };
    },
    bulkMarkReviewed: (feedbackIds, reviewedByUserId, context) =>
      applyBulkAction(feedbackIds, "reviewed", reviewedByUserId, context),
    bulkArchive: (feedbackIds, archivedByUserId, context) =>
      applyBulkAction(feedbackIds, "archived", archivedByUserId, context),
    listPlatformFeedback: (params) => listPlatformFeedback(deps.db, params),
    getPlatformFeedback: (feedbackId) => getPlatformFeedback(deps.db, feedbackId),
    getPlatformFeedbackMetrics: () => getPlatformFeedbackMetrics(deps.db),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "experience-platform-feedback-projection",
        handlers: buildPlatformFeedbackProjectionHandlers(deps.db),
        streamPrefixes: ["platform-operations."],
      }),
    ],
  };

  return api;
}
