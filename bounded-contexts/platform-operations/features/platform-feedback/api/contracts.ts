import type {
  PlatformFeedbackRelatedEntity,
  PlatformFeedbackStatus,
  PlatformFeedbackTopic,
  PlatformFeedbackWorkflow,
} from "../domain/common";

export type PlatformFeedbackListItem = Readonly<{
  feedback_id: string;
  user_id: string;
  account_id: string;
  rating: number;
  topic: PlatformFeedbackTopic;
  comment: string | null;
  follow_up_consent: boolean;
  workflow: PlatformFeedbackWorkflow;
  source_route_path: string;
  related_entities: readonly PlatformFeedbackRelatedEntity[];
  related_entity_key: string | null;
  status: PlatformFeedbackStatus;
  submitted_at: string;
  updated_at: string;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  archived_by_user_id: string | null;
  archived_at: string | null;
  operator_notes: readonly PlatformFeedbackOperatorNote[];
}>;

export type PlatformFeedbackDetail = PlatformFeedbackListItem;

export type PlatformFeedbackOperatorNote = Readonly<{
  noteId: string;
  body: string;
  recordedByUserId: string;
  recordedAt: string;
}>;

export type PlatformFeedbackMetrics = Readonly<{
  total_count: number;
  new_count: number;
  reviewed_count: number;
  archived_count: number;
  average_rating: string | null;
  by_topic: readonly { topic: string; count: number; averageRating: string | null }[];
  by_workflow: readonly { workflow: string; count: number; averageRating: string | null }[];
}>;

export type PlatformFeedbackPromptEligibility = Readonly<{
  shouldPrompt: boolean;
  reason: "eligible" | "recent-submission" | "snoozed";
}>;

export type PlatformFeedbackSubmissionSnapshot = Readonly<{
  id: string;
  version: number;
  status: "submitted";
}>;

export type PlatformFeedbackPromptDismissalSnapshot = Readonly<{
  id: string;
  version: number;
  snoozedUntil: string;
}>;

export type PlatformFeedbackReviewSnapshot = Readonly<{
  id: string;
  version: number;
  status: "reviewed" | "archived";
}>;

export type PlatformFeedbackOperatorNoteSnapshot = Readonly<{
  id: string;
  version: number;
  noteId: string;
}>;

export type PlatformFeedbackBulkActionSnapshot = Readonly<{
  action: "reviewed" | "archived";
  updated: number;
  skipped: number;
  items: readonly PlatformFeedbackReviewSnapshot[];
}>;

export type SubmitPlatformFeedbackRequest = Readonly<{
  rating: number;
  topic: PlatformFeedbackTopic;
  comment?: string | null;
  followUpConsent?: boolean;
  workflow: PlatformFeedbackWorkflow;
  sourceRoutePath: string;
  relatedEntities?: readonly PlatformFeedbackRelatedEntity[];
}>;

export type DismissPlatformFeedbackPromptRequest = Readonly<{
  workflow: PlatformFeedbackWorkflow;
  sourceRoutePath: string;
  relatedEntities?: readonly PlatformFeedbackRelatedEntity[];
}>;

export type RecordPlatformFeedbackOperatorNoteRequest = Readonly<{
  body: string;
}>;

export type PlatformFeedbackBulkActionRequest = Readonly<{
  feedbackIds: readonly string[];
}>;
