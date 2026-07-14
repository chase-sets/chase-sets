import type { AggregateDecider, AggregateEvolver } from "@chase-sets/event-core";
import type { CsatSurveySubmittedEvent } from "../../csat/domain/invitation";
import {
  feedbackCaseDispositions,
  feedbackCaseFollowUpOutcomes,
  feedbackCasePriorities,
  feedbackCaseWorkItemKinds,
  type FeedbackCase,
  type FeedbackCaseActor,
  type FeedbackCaseDisposition,
  type FeedbackCaseEvent,
  type FeedbackCaseFollowUpOutcome,
  type FeedbackCaseId,
  type FeedbackCaseOpenReason,
  type FeedbackCasePriority,
  type FeedbackCaseWorkItem,
} from "./feedback-case";

type AttributedCommand = Readonly<{ actor: FeedbackCaseActor; actedAt: string }>;

export type OpenFeedbackCaseCommand = AttributedCommand &
  Readonly<{
    type: "OpenFeedbackCase";
    caseId: FeedbackCaseId;
    submission: CsatSurveySubmittedEvent["data"];
    openReason: FeedbackCaseOpenReason;
  }>;
export type TriageFeedbackCaseCommand = AttributedCommand & Readonly<{ type: "TriageFeedbackCase" }>;
export type AssignFeedbackCaseCommand = AttributedCommand & Readonly<{ type: "AssignFeedbackCase"; ownerId: string }>;
export type UnassignFeedbackCaseCommand = AttributedCommand & Readonly<{ type: "UnassignFeedbackCase" }>;
export type SetFeedbackCasePriorityCommand = AttributedCommand &
  Readonly<{ type: "SetFeedbackCasePriority"; priority: FeedbackCasePriority }>;
export type SetFeedbackCaseDueDateCommand = AttributedCommand &
  Readonly<{ type: "SetFeedbackCaseDueDate"; dueAt: string | null }>;
export type SetFeedbackCaseDispositionCommand = AttributedCommand &
  Readonly<{
    type: "SetFeedbackCaseDisposition";
    disposition: FeedbackCaseDisposition;
    duplicateOfCaseId?: FeedbackCaseId | null;
  }>;
export type LinkFeedbackCaseWorkItemCommand = AttributedCommand &
  Readonly<{ type: "LinkFeedbackCaseWorkItem"; workItem: FeedbackCaseWorkItem }>;
export type UnlinkFeedbackCaseWorkItemCommand = AttributedCommand &
  Readonly<{ type: "UnlinkFeedbackCaseWorkItem"; workItem: FeedbackCaseWorkItem }>;
export type RequestFeedbackCaseFollowUpCommand = AttributedCommand &
  Readonly<{ type: "RequestFeedbackCaseFollowUp"; consentVersion: string }>;
export type MarkFeedbackCaseFollowUpSentCommand = AttributedCommand &
  Readonly<{ type: "MarkFeedbackCaseFollowUpSent"; deliveryReference: string }>;
export type RecordFeedbackCaseFollowUpOutcomeCommand = AttributedCommand &
  Readonly<{ type: "RecordFeedbackCaseFollowUpOutcome"; outcome: FeedbackCaseFollowUpOutcome }>;
export type WithdrawFeedbackCaseFollowUpConsentCommand = AttributedCommand &
  Readonly<{ type: "WithdrawFeedbackCaseFollowUpConsent"; consentVersion: string }>;
export type CloseFeedbackCaseCommand = AttributedCommand & Readonly<{ type: "CloseFeedbackCase" }>;
export type ReopenFeedbackCaseCommand = AttributedCommand & Readonly<{ type: "ReopenFeedbackCase" }>;

export type FeedbackCaseCommand =
  | OpenFeedbackCaseCommand
  | TriageFeedbackCaseCommand
  | AssignFeedbackCaseCommand
  | UnassignFeedbackCaseCommand
  | SetFeedbackCasePriorityCommand
  | SetFeedbackCaseDueDateCommand
  | SetFeedbackCaseDispositionCommand
  | LinkFeedbackCaseWorkItemCommand
  | UnlinkFeedbackCaseWorkItemCommand
  | RequestFeedbackCaseFollowUpCommand
  | MarkFeedbackCaseFollowUpSentCommand
  | RecordFeedbackCaseFollowUpOutcomeCommand
  | WithdrawFeedbackCaseFollowUpConsentCommand
  | CloseFeedbackCaseCommand
  | ReopenFeedbackCaseCommand;

export type FeedbackCaseAggregateState = Readonly<{ feedbackCase: FeedbackCase | null }>;

export const initialFeedbackCaseState: FeedbackCaseAggregateState = { feedbackCase: null };

export type FeedbackCaseDecisionErrorCode =
  | "forbidden"
  | "case-not-found"
  | "case-already-opened"
  | "invalid-source-response"
  | "invalid-transition"
  | "invalid-field"
  | "follow-up-not-consented";

export class FeedbackCaseDecisionError extends Error {
  readonly name = "FeedbackCaseDecisionError";

  constructor(
    readonly code: FeedbackCaseDecisionErrorCode,
    message: string,
    readonly currentStatus: FeedbackCase["status"] | null,
  ) {
    super(message);
  }
}

export const decideFeedbackCase: AggregateDecider<
  FeedbackCaseAggregateState,
  FeedbackCaseCommand,
  FeedbackCaseEvent
> = (state, command) => {
  requireManager(command.actor, state.feedbackCase?.status ?? null);
  const actedAt = requireTimestamp(command.actedAt, "Case action timestamp");
  const actorId = requireText(command.actor.actorId, "Case action requires an actor.");

  if (command.type === "OpenFeedbackCase") {
    if (state.feedbackCase) fail("case-already-opened", "Feedback case has already been opened.", state.feedbackCase);
    validateOpening(command);
    const consentGranted = command.submission.followUpConsent && command.submission.followUpConsentAt !== null;
    return [
      {
        type: "customer-feedback.case.opened",
        data: {
          eventSchemaVersion: 1,
          caseId: command.caseId,
          sourceResponse: {
            invitationId: command.submission.invitationId,
            surveyVersion: command.submission.surveyVersion,
            rating: command.submission.rating,
            submissionIdempotencyKey: command.submission.submissionIdempotencyKey,
            submittedAt: command.submission.submittedAt,
          },
          openReason: command.openReason,
          priority: command.openReason === "flagged" ? "normal" : priorityForRating(command.submission.rating),
          consent: {
            status: consentGranted ? "granted" : "not-granted",
            version: requireText(command.submission.followUpConsentVersion, "Follow-up consent version is required."),
            grantedAt: consentGranted ? command.submission.followUpConsentAt : null,
            withdrawnAt: null,
          },
          actorId,
          actedAt,
        },
      },
    ];
  }

  const feedbackCase = requireCase(state);
  switch (command.type) {
    case "TriageFeedbackCase":
      requireStatus(feedbackCase, ["new"], "Only a new feedback case can be triaged.");
      return [attributed("customer-feedback.case.triaged", feedbackCase.caseId, actorId, actedAt)];
    case "AssignFeedbackCase": {
      requireOpen(feedbackCase, "Closed feedback cases cannot be assigned.");
      const ownerId = requireText(command.ownerId, "Feedback case assignment requires an owner.");
      if (feedbackCase.ownerId === ownerId) return [];
      return [
        {
          type: "customer-feedback.case.assigned",
          data: { eventSchemaVersion: 1, caseId: feedbackCase.caseId, ownerId, actorId, actedAt },
        },
      ];
    }
    case "UnassignFeedbackCase":
      requireOpen(feedbackCase, "Closed feedback cases cannot be unassigned.");
      if (feedbackCase.ownerId === null) return [];
      return [
        {
          type: "customer-feedback.case.unassigned",
          data: {
            eventSchemaVersion: 1,
            caseId: feedbackCase.caseId,
            previousOwnerId: feedbackCase.ownerId,
            actorId,
            actedAt,
          },
        },
      ];
    case "SetFeedbackCasePriority":
      requireOpen(feedbackCase, "Closed feedback cases cannot change priority.");
      requireMember(feedbackCasePriorities, command.priority, "Unsupported feedback case priority.");
      if (feedbackCase.priority === command.priority) return [];
      return [
        {
          type: "customer-feedback.case.priority-set",
          data: {
            eventSchemaVersion: 1,
            caseId: feedbackCase.caseId,
            priority: command.priority,
            actorId,
            actedAt,
          },
        },
      ];
    case "SetFeedbackCaseDueDate": {
      requireOpen(feedbackCase, "Closed feedback cases cannot change due date.");
      const dueAt = command.dueAt === null ? null : requireTimestamp(command.dueAt, "Feedback case due date");
      if (dueAt !== null && Date.parse(dueAt) <= Date.parse(actedAt)) {
        fail("invalid-field", "Feedback case due date must be after the action time.", feedbackCase);
      }
      if (feedbackCase.dueAt === dueAt) return [];
      return [
        {
          type: "customer-feedback.case.due-date-set",
          data: { eventSchemaVersion: 1, caseId: feedbackCase.caseId, dueAt, actorId, actedAt },
        },
      ];
    }
    case "SetFeedbackCaseDisposition": {
      requireStatus(
        feedbackCase,
        ["triaged", "actioned"],
        "A feedback case must be triaged before a disposition is recorded.",
      );
      requireMember(feedbackCaseDispositions, command.disposition, "Unsupported feedback case disposition.");
      const duplicateOfCaseId = command.duplicateOfCaseId ?? null;
      if (command.disposition === "duplicate") {
        if (!duplicateOfCaseId || duplicateOfCaseId === feedbackCase.caseId) {
          fail("invalid-field", "Duplicate disposition requires a different primary feedback case.", feedbackCase);
        }
      } else if (duplicateOfCaseId !== null) {
        fail("invalid-field", "Only duplicate disposition can reference a primary feedback case.", feedbackCase);
      }
      if (feedbackCase.disposition === command.disposition && feedbackCase.duplicateOfCaseId === duplicateOfCaseId) {
        return [];
      }
      return [
        {
          type: "customer-feedback.case.disposition-set",
          data: {
            eventSchemaVersion: 1,
            caseId: feedbackCase.caseId,
            disposition: command.disposition,
            duplicateOfCaseId,
            actorId,
            actedAt,
          },
        },
      ];
    }
    case "LinkFeedbackCaseWorkItem": {
      requireOpen(feedbackCase, "Closed feedback cases cannot link work items.");
      const workItem = normalizeWorkItem(command.workItem, feedbackCase);
      if (feedbackCase.workItems.some((item) => workItemsEqual(item, workItem))) return [];
      return [
        {
          type: "customer-feedback.case.work-item-linked",
          data: { eventSchemaVersion: 1, caseId: feedbackCase.caseId, workItem, actorId, actedAt },
        },
      ];
    }
    case "UnlinkFeedbackCaseWorkItem": {
      requireOpen(feedbackCase, "Closed feedback cases cannot unlink work items.");
      const workItem = normalizeWorkItem(command.workItem, feedbackCase);
      if (!feedbackCase.workItems.some((item) => workItemsEqual(item, workItem))) return [];
      return [
        {
          type: "customer-feedback.case.work-item-unlinked",
          data: { eventSchemaVersion: 1, caseId: feedbackCase.caseId, workItem, actorId, actedAt },
        },
      ];
    }
    case "RequestFeedbackCaseFollowUp":
      requireStatus(
        feedbackCase,
        ["triaged", "actioned"],
        "Follow-up can only be requested for a triaged or actioned feedback case.",
      );
      requireFollowUpConsent(feedbackCase, command.consentVersion);
      requireFollowUpAllowedDisposition(feedbackCase);
      if (feedbackCase.followUpStatus !== "not-requested") {
        fail("invalid-transition", "Follow-up has already been requested for this feedback case.", feedbackCase);
      }
      return [
        {
          type: "customer-feedback.case.follow-up-requested",
          data: {
            eventSchemaVersion: 1,
            caseId: feedbackCase.caseId,
            consentVersion: feedbackCase.consent.version,
            actorId,
            actedAt,
          },
        },
      ];
    case "MarkFeedbackCaseFollowUpSent": {
      requireFollowUpConsent(feedbackCase, feedbackCase.consent.version);
      requireFollowUpAllowedDisposition(feedbackCase);
      requireFollowUpStatus(feedbackCase, "requested", "Only requested follow-up can be marked sent.");
      const deliveryReference = requireText(
        command.deliveryReference,
        "Sent follow-up requires a stable delivery reference.",
      );
      return [
        {
          type: "customer-feedback.case.follow-up-sent",
          data: { eventSchemaVersion: 1, caseId: feedbackCase.caseId, deliveryReference, actorId, actedAt },
        },
      ];
    }
    case "RecordFeedbackCaseFollowUpOutcome":
      requireFollowUpConsent(feedbackCase, feedbackCase.consent.version);
      requireFollowUpStatus(feedbackCase, "sent", "A follow-up outcome requires a sent follow-up.");
      requireMember(feedbackCaseFollowUpOutcomes, command.outcome, "Unsupported follow-up outcome.");
      return [
        {
          type: "customer-feedback.case.follow-up-outcome-recorded",
          data: {
            eventSchemaVersion: 1,
            caseId: feedbackCase.caseId,
            outcome: command.outcome,
            actorId,
            actedAt,
          },
        },
      ];
    case "WithdrawFeedbackCaseFollowUpConsent":
      if (feedbackCase.consent.version !== command.consentVersion) {
        fail("invalid-field", "Consent withdrawal version does not match the case consent version.", feedbackCase);
      }
      if (feedbackCase.consent.status === "withdrawn") return [];
      return [
        {
          type: "customer-feedback.case.follow-up-consent-withdrawn",
          data: {
            eventSchemaVersion: 1,
            caseId: feedbackCase.caseId,
            consentVersion: command.consentVersion,
            actorId,
            actedAt,
          },
        },
      ];
    case "CloseFeedbackCase":
      requireStatus(feedbackCase, ["actioned"], "Only an actioned feedback case can be closed.");
      if (feedbackCase.disposition === null) {
        fail("invalid-transition", "Feedback case requires a disposition before it can be closed.", feedbackCase);
      }
      if (feedbackCase.followUpStatus === "requested" || feedbackCase.followUpStatus === "sent") {
        fail(
          "invalid-transition",
          "Pending customer follow-up must finish or be cancelled before closure.",
          feedbackCase,
        );
      }
      return [attributed("customer-feedback.case.closed", feedbackCase.caseId, actorId, actedAt)];
    case "ReopenFeedbackCase":
      requireStatus(feedbackCase, ["closed"], "Only a closed feedback case can be reopened.");
      return [attributed("customer-feedback.case.reopened", feedbackCase.caseId, actorId, actedAt)];
    default:
      return assertNever(command);
  }
};

export const evolveFeedbackCase: AggregateEvolver<FeedbackCaseAggregateState, FeedbackCaseEvent> = (state, event) => {
  if (event.type === "customer-feedback.case.opened") {
    return {
      feedbackCase: {
        caseId: event.data.caseId,
        sourceResponse: event.data.sourceResponse,
        openReason: event.data.openReason,
        status: "new",
        ownerId: null,
        priority: event.data.priority,
        dueAt: null,
        disposition: null,
        duplicateOfCaseId: null,
        workItems: [],
        consent: event.data.consent,
        followUpStatus: "not-requested",
        followUpDeliveryReference: null,
        followUpOutcome: null,
        openedAt: event.data.actedAt,
        triagedAt: null,
        actionedAt: null,
        closedAt: null,
        reopenedAt: null,
      },
    };
  }
  const feedbackCase = requireCase(state);
  switch (event.type) {
    case "customer-feedback.case.triaged":
      return update(feedbackCase, { status: "triaged", triagedAt: event.data.actedAt });
    case "customer-feedback.case.assigned":
      return update(feedbackCase, { ownerId: event.data.ownerId });
    case "customer-feedback.case.unassigned":
      return update(feedbackCase, { ownerId: null });
    case "customer-feedback.case.priority-set":
      return update(feedbackCase, { priority: event.data.priority });
    case "customer-feedback.case.due-date-set":
      return update(feedbackCase, { dueAt: event.data.dueAt });
    case "customer-feedback.case.disposition-set":
      return update(feedbackCase, {
        status: "actioned",
        disposition: event.data.disposition,
        duplicateOfCaseId: event.data.duplicateOfCaseId,
        actionedAt: event.data.actedAt,
        followUpStatus:
          ["duplicate", "spam", "redacted"].includes(event.data.disposition) &&
          (feedbackCase.followUpStatus === "requested" || feedbackCase.followUpStatus === "sent")
            ? "cancelled"
            : feedbackCase.followUpStatus,
      });
    case "customer-feedback.case.work-item-linked":
      return update(feedbackCase, { workItems: [...feedbackCase.workItems, event.data.workItem] });
    case "customer-feedback.case.work-item-unlinked":
      return update(feedbackCase, {
        workItems: feedbackCase.workItems.filter((item) => !workItemsEqual(item, event.data.workItem)),
      });
    case "customer-feedback.case.follow-up-requested":
      return update(feedbackCase, { followUpStatus: "requested" });
    case "customer-feedback.case.follow-up-sent":
      return update(feedbackCase, {
        followUpStatus: "sent",
        followUpDeliveryReference: event.data.deliveryReference,
      });
    case "customer-feedback.case.follow-up-outcome-recorded":
      return update(feedbackCase, { followUpStatus: "completed", followUpOutcome: event.data.outcome });
    case "customer-feedback.case.follow-up-consent-withdrawn":
      return update(feedbackCase, {
        consent: { ...feedbackCase.consent, status: "withdrawn", withdrawnAt: event.data.actedAt },
        followUpStatus:
          feedbackCase.followUpStatus === "requested" || feedbackCase.followUpStatus === "sent"
            ? "cancelled"
            : feedbackCase.followUpStatus,
      });
    case "customer-feedback.case.closed":
      return update(feedbackCase, { status: "closed", closedAt: event.data.actedAt });
    case "customer-feedback.case.reopened":
      return update(feedbackCase, {
        status: "triaged",
        disposition: null,
        duplicateOfCaseId: null,
        actionedAt: null,
        closedAt: null,
        reopenedAt: event.data.actedAt,
        followUpStatus: feedbackCase.followUpStatus === "cancelled" ? "not-requested" : feedbackCase.followUpStatus,
      });
    default:
      return assertNever(event);
  }
};

function validateOpening(command: OpenFeedbackCaseCommand): void {
  requireTimestamp(command.submission.submittedAt, "Source response submission timestamp");
  requireText(command.submission.submissionIdempotencyKey, "Source response idempotency key is required.");
  if (command.openReason === "low-score" && command.submission.rating > 3) {
    throw new FeedbackCaseDecisionError(
      "invalid-source-response",
      "Automatic feedback cases require a submitted rating of 1 through 3.",
      null,
    );
  }
  if (command.submission.followUpConsent && command.submission.followUpConsentAt === null) {
    throw new FeedbackCaseDecisionError(
      "invalid-source-response",
      "Affirmative follow-up consent requires its captured timestamp.",
      null,
    );
  }
}

function requireManager(actor: FeedbackCaseActor, status: FeedbackCase["status"] | null): void {
  if (actor.authority !== "manage-feedback-cases") {
    throw new FeedbackCaseDecisionError("forbidden", "Managing feedback cases requires manager authority.", status);
  }
}

function requireCase(state: FeedbackCaseAggregateState): FeedbackCase {
  if (!state.feedbackCase) throw new FeedbackCaseDecisionError("case-not-found", "Feedback case does not exist.", null);
  return state.feedbackCase;
}

function requireOpen(feedbackCase: FeedbackCase, message: string): void {
  if (feedbackCase.status === "closed") fail("invalid-transition", message, feedbackCase);
}

function requireStatus(feedbackCase: FeedbackCase, allowed: readonly FeedbackCase["status"][], message: string): void {
  if (!allowed.includes(feedbackCase.status)) fail("invalid-transition", message, feedbackCase);
}

function requireFollowUpStatus(feedbackCase: FeedbackCase, status: FeedbackCase["followUpStatus"], message: string) {
  if (feedbackCase.followUpStatus !== status) fail("invalid-transition", message, feedbackCase);
}

function requireFollowUpConsent(feedbackCase: FeedbackCase, consentVersion: string): void {
  if (
    feedbackCase.consent.status !== "granted" ||
    feedbackCase.consent.grantedAt === null ||
    feedbackCase.consent.version !== consentVersion
  ) {
    fail(
      "follow-up-not-consented",
      "Customer follow-up requires applicable affirmative consent for this consent version.",
      feedbackCase,
    );
  }
}

function requireFollowUpAllowedDisposition(feedbackCase: FeedbackCase): void {
  if (["duplicate", "spam", "redacted"].includes(feedbackCase.disposition ?? "")) {
    fail("invalid-transition", "This feedback case disposition does not allow customer follow-up.", feedbackCase);
  }
}

function normalizeWorkItem(workItem: FeedbackCaseWorkItem, feedbackCase: FeedbackCase): FeedbackCaseWorkItem {
  requireMember(feedbackCaseWorkItemKinds, workItem.kind, "Unsupported linked work item kind.");
  const reference = requireText(workItem.reference, "Linked work item requires a stable reference.");
  if (/^https?:\/\//i.test(reference)) {
    fail("invalid-field", "Linked work items store stable references, not URLs.", feedbackCase);
  }
  return { kind: workItem.kind, reference };
}

function workItemsEqual(left: FeedbackCaseWorkItem, right: FeedbackCaseWorkItem): boolean {
  return left.kind === right.kind && left.reference === right.reference;
}

function priorityForRating(rating: number): FeedbackCasePriority {
  return rating === 1 ? "urgent" : rating === 2 ? "high" : "normal";
}

function attributed<
  TType extends "customer-feedback.case.triaged" | "customer-feedback.case.closed" | "customer-feedback.case.reopened",
>(type: TType, caseId: FeedbackCaseId, actorId: string, actedAt: string): Extract<FeedbackCaseEvent, { type: TType }> {
  return { type, data: { eventSchemaVersion: 1, caseId, actorId, actedAt } } as Extract<
    FeedbackCaseEvent,
    { type: TType }
  >;
}

function update(feedbackCase: FeedbackCase, changes: Partial<FeedbackCase>): FeedbackCaseAggregateState {
  return { feedbackCase: { ...feedbackCase, ...changes } };
}

function requireText(value: string, message: string): string {
  const normalized = value.trim();
  if (!normalized) throw new FeedbackCaseDecisionError("invalid-field", message, null);
  return normalized;
}

function requireTimestamp(value: string, label: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new FeedbackCaseDecisionError("invalid-field", `${label} must be a valid timestamp.`, null);
  }
  return new Date(value).toISOString();
}

function requireMember<T extends string>(values: readonly T[], value: T, message: string): void {
  if (!(values as readonly string[]).includes(value)) {
    throw new FeedbackCaseDecisionError("invalid-field", message, null);
  }
}

function fail(code: FeedbackCaseDecisionErrorCode, message: string, feedbackCase: FeedbackCase): never {
  throw new FeedbackCaseDecisionError(code, message, feedbackCase.status);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported feedback case value: ${JSON.stringify(value)}`);
}
