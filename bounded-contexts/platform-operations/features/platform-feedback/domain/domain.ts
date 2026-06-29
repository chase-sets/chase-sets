import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import {
  assert,
  assertNever,
  ensureIsoTimestamp,
  normalizeComment,
  normalizeRating,
  normalizeRelatedEntities,
  normalizeRequiredText,
  normalizeStatus,
  normalizeTopic,
  normalizeWorkflow,
  relatedEntityKey,
  type PlatformFeedbackRelatedEntity,
  type PlatformFeedbackStatus,
  type PlatformFeedbackTopic,
  type PlatformFeedbackWorkflow,
} from "./common";

export type PlatformFeedbackState = Readonly<{
  feedbackId: string | null;
  accountId: string | null;
  userId: string | null;
  workflow: PlatformFeedbackWorkflow | null;
  relatedEntityKey: string | null;
  status: PlatformFeedbackStatus | null;
  dismissedAt: string | null;
}>;

export const initialPlatformFeedbackState: PlatformFeedbackState = {
  feedbackId: null,
  accountId: null,
  userId: null,
  workflow: null,
  relatedEntityKey: null,
  status: null,
  dismissedAt: null,
};

export type SubmitPlatformFeedbackCommand = Readonly<{
  type: "SubmitPlatformFeedback";
  feedbackId: string;
  userId: string;
  accountId: string;
  rating: number;
  topic: PlatformFeedbackTopic;
  comment?: string | null;
  followUpConsent: boolean;
  workflow: PlatformFeedbackWorkflow;
  sourceRoutePath: string;
  relatedEntities?: readonly PlatformFeedbackRelatedEntity[];
  submittedAt: string;
}>;

export type DismissPlatformFeedbackPromptCommand = Readonly<{
  type: "DismissPlatformFeedbackPrompt";
  promptId: string;
  userId: string;
  accountId: string;
  workflow: PlatformFeedbackWorkflow;
  sourceRoutePath: string;
  relatedEntities?: readonly PlatformFeedbackRelatedEntity[];
  dismissedAt: string;
  snoozedUntil: string;
}>;

export type MarkPlatformFeedbackReviewedCommand = Readonly<{
  type: "MarkPlatformFeedbackReviewed";
  reviewedByUserId: string;
  reviewedAt: string;
}>;

export type ArchivePlatformFeedbackCommand = Readonly<{
  type: "ArchivePlatformFeedback";
  archivedByUserId: string;
  archivedAt: string;
}>;

export type RecordPlatformFeedbackOperatorNoteCommand = Readonly<{
  type: "RecordPlatformFeedbackOperatorNote";
  noteId: string;
  body: string;
  recordedByUserId: string;
  recordedAt: string;
}>;

export type PlatformFeedbackCommand =
  | SubmitPlatformFeedbackCommand
  | DismissPlatformFeedbackPromptCommand
  | MarkPlatformFeedbackReviewedCommand
  | ArchivePlatformFeedbackCommand
  | RecordPlatformFeedbackOperatorNoteCommand;

export type PlatformFeedbackSubmittedEvent = DomainEvent<
  "experience.platform-feedback.submitted",
  Readonly<{
    feedbackId: string;
    userId: string;
    accountId: string;
    rating: number;
    topic: PlatformFeedbackTopic;
    comment: string | null;
    followUpConsent: boolean;
    workflow: PlatformFeedbackWorkflow;
    sourceRoutePath: string;
    relatedEntities: PlatformFeedbackRelatedEntity[];
    relatedEntityKey: string | null;
    submittedAt: string;
  }>
>;

export type PlatformFeedbackPromptDismissedEvent = DomainEvent<
  "experience.platform-feedback.prompt-dismissed",
  Readonly<{
    promptId: string;
    userId: string;
    accountId: string;
    workflow: PlatformFeedbackWorkflow;
    sourceRoutePath: string;
    relatedEntities: PlatformFeedbackRelatedEntity[];
    relatedEntityKey: string | null;
    dismissedAt: string;
    snoozedUntil: string;
  }>
>;

export type PlatformFeedbackReviewedEvent = DomainEvent<
  "experience.platform-feedback.reviewed",
  Readonly<{
    feedbackId: string;
    reviewedByUserId: string;
    reviewedAt: string;
  }>
>;

export type PlatformFeedbackArchivedEvent = DomainEvent<
  "experience.platform-feedback.archived",
  Readonly<{
    feedbackId: string;
    archivedByUserId: string;
    archivedAt: string;
  }>
>;

export type PlatformFeedbackOperatorNoteRecordedEvent = DomainEvent<
  "experience.platform-feedback.operator-note-recorded",
  Readonly<{
    feedbackId: string;
    noteId: string;
    body: string;
    recordedByUserId: string;
    recordedAt: string;
  }>
>;

export type PlatformFeedbackEvent =
  | PlatformFeedbackSubmittedEvent
  | PlatformFeedbackPromptDismissedEvent
  | PlatformFeedbackReviewedEvent
  | PlatformFeedbackArchivedEvent
  | PlatformFeedbackOperatorNoteRecordedEvent;

function normalizeOperatorNoteBody(value: string) {
  const body = normalizeRequiredText(value, "Operator note is required.");
  assert(body.length <= 2000, "Operator note must be 2000 characters or fewer.");
  return body;
}

export const decidePlatformFeedback: AggregateDecider<
  PlatformFeedbackState,
  PlatformFeedbackCommand,
  PlatformFeedbackEvent
> = (state, command) => {
  switch (command.type) {
    case "SubmitPlatformFeedback": {
      assert(state.feedbackId === null, "Platform feedback has already been submitted.");
      const relatedEntities = normalizeRelatedEntities(command.relatedEntities);

      return [
        {
          type: "experience.platform-feedback.submitted",
          data: {
            feedbackId: normalizeRequiredText(command.feedbackId, "Feedback ID is required."),
            userId: normalizeRequiredText(command.userId, "User is required."),
            accountId: normalizeRequiredText(command.accountId, "Account is required."),
            rating: normalizeRating(command.rating),
            topic: normalizeTopic(command.topic),
            comment: normalizeComment(command.comment),
            followUpConsent: Boolean(command.followUpConsent),
            workflow: normalizeWorkflow(command.workflow),
            sourceRoutePath: normalizeRequiredText(command.sourceRoutePath, "Source route path is required."),
            relatedEntities,
            relatedEntityKey: relatedEntityKey(relatedEntities),
            submittedAt: ensureIsoTimestamp(command.submittedAt, "Submission must record a timestamp."),
          },
        },
      ];
    }
    case "DismissPlatformFeedbackPrompt": {
      const relatedEntities = normalizeRelatedEntities(command.relatedEntities);

      return [
        {
          type: "experience.platform-feedback.prompt-dismissed",
          data: {
            promptId: normalizeRequiredText(command.promptId, "Prompt ID is required."),
            userId: normalizeRequiredText(command.userId, "User is required."),
            accountId: normalizeRequiredText(command.accountId, "Account is required."),
            workflow: normalizeWorkflow(command.workflow),
            sourceRoutePath: normalizeRequiredText(command.sourceRoutePath, "Source route path is required."),
            relatedEntities,
            relatedEntityKey: relatedEntityKey(relatedEntities),
            dismissedAt: ensureIsoTimestamp(command.dismissedAt, "Dismissal must record a timestamp."),
            snoozedUntil: ensureIsoTimestamp(command.snoozedUntil, "Dismissal must record a snooze timestamp."),
          },
        },
      ];
    }
    case "MarkPlatformFeedbackReviewed":
      assert(state.feedbackId !== null, "Platform feedback must be submitted first.");
      if (state.status === "reviewed") {
        return [];
      }
      assert(state.status !== "archived", "Archived platform feedback cannot be reviewed.");

      return [
        {
          type: "experience.platform-feedback.reviewed",
          data: {
            feedbackId: state.feedbackId,
            reviewedByUserId: normalizeRequiredText(command.reviewedByUserId, "Reviewer is required."),
            reviewedAt: ensureIsoTimestamp(command.reviewedAt, "Review must record a timestamp."),
          },
        },
      ];
    case "ArchivePlatformFeedback":
      assert(state.feedbackId !== null, "Platform feedback must be submitted first.");
      if (state.status === "archived") {
        return [];
      }

      return [
        {
          type: "experience.platform-feedback.archived",
          data: {
            feedbackId: state.feedbackId,
            archivedByUserId: normalizeRequiredText(command.archivedByUserId, "Archiver is required."),
            archivedAt: ensureIsoTimestamp(command.archivedAt, "Archive must record a timestamp."),
          },
        },
      ];
    case "RecordPlatformFeedbackOperatorNote":
      assert(state.feedbackId !== null, "Platform feedback must be submitted first.");

      return [
        {
          type: "experience.platform-feedback.operator-note-recorded",
          data: {
            feedbackId: state.feedbackId,
            noteId: normalizeRequiredText(command.noteId, "Operator note ID is required."),
            body: normalizeOperatorNoteBody(command.body),
            recordedByUserId: normalizeRequiredText(command.recordedByUserId, "Operator is required."),
            recordedAt: ensureIsoTimestamp(command.recordedAt, "Operator note must record a timestamp."),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolvePlatformFeedback: AggregateEvolver<PlatformFeedbackState, PlatformFeedbackEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "experience.platform-feedback.submitted":
      return {
        feedbackId: event.data.feedbackId,
        accountId: event.data.accountId,
        userId: event.data.userId,
        workflow: event.data.workflow,
        relatedEntityKey: event.data.relatedEntityKey,
        status: "new",
        dismissedAt: state.dismissedAt,
      };
    case "experience.platform-feedback.prompt-dismissed":
      return {
        ...state,
        accountId: event.data.accountId,
        userId: event.data.userId,
        workflow: event.data.workflow,
        relatedEntityKey: event.data.relatedEntityKey,
        dismissedAt: event.data.dismissedAt,
      };
    case "experience.platform-feedback.reviewed":
      return {
        ...state,
        status: normalizeStatus("reviewed"),
      };
    case "experience.platform-feedback.archived":
      return {
        ...state,
        status: normalizeStatus("archived"),
      };
    case "experience.platform-feedback.operator-note-recorded":
      return state;
    default:
      return assertNever(event);
  }
};
