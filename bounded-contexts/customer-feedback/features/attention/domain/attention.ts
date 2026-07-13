import type { FeedbackCase, FeedbackCasePriority, FeedbackCaseStatus } from "../../cases/domain";

export const feedbackAttentionRule = {
  version: "low-score-v1",
  maximumRating: 2,
  triageSlaMinutes: {
    urgent: 60,
    high: 240,
    normal: 1_440,
    low: 2_880,
  },
} as const;

export type FeedbackAttentionReason = "low-score" | "reopened" | "sla-breach";
export type FeedbackAttentionState = "active" | "resolved";
export type FeedbackSlaBreach = "triage" | "due" | null;

export type FeedbackAttentionItem = Readonly<{
  attentionId: string;
  caseId: string;
  state: FeedbackAttentionState;
  reason: FeedbackAttentionReason;
  ruleVersion: string;
  rating: number;
  priority: FeedbackCasePriority;
  ownerId: string | null;
  openedAt: string;
  triagedAt: string | null;
  dueAt: string | null;
  triageDueAt: string;
  closedAt: string | null;
}>;

export type FeedbackSlaState = Readonly<{
  triageDueAt: string;
  effectiveDueAt: string | null;
  timeToTriageMs: number | null;
  breach: FeedbackSlaBreach;
  overdue: boolean;
}>;

export function classifyFeedbackAttention(
  rating: number,
  policy: Pick<typeof feedbackAttentionRule, "version" | "maximumRating"> = feedbackAttentionRule,
): Readonly<{ requiresAttention: boolean; ruleVersion: string; reason: "low-score" | null }> {
  return {
    requiresAttention: rating <= policy.maximumRating,
    ruleVersion: policy.version,
    reason: rating <= policy.maximumRating ? "low-score" : null,
  };
}

export function triageDueAt(
  openedAt: string,
  priority: FeedbackCasePriority,
  policy: Pick<typeof feedbackAttentionRule, "triageSlaMinutes"> = feedbackAttentionRule,
): string {
  const minutes = policy.triageSlaMinutes[priority];
  return new Date(Date.parse(openedAt) + minutes * 60_000).toISOString();
}

export function feedbackCaseSlaState(
  feedbackCase: Pick<FeedbackCase, "openedAt" | "priority" | "triagedAt" | "dueAt" | "status" | "closedAt">,
  now: string,
  policy: Pick<typeof feedbackAttentionRule, "triageSlaMinutes"> = feedbackAttentionRule,
): FeedbackSlaState {
  const triageDeadline = triageDueAt(feedbackCase.openedAt, feedbackCase.priority, policy);
  const effectiveDueAt = feedbackCase.dueAt ?? (feedbackCase.triagedAt ? null : triageDeadline);
  const timeToTriageMs = feedbackCase.triagedAt
    ? Math.max(0, Date.parse(feedbackCase.triagedAt) - Date.parse(feedbackCase.openedAt))
    : null;
  const isClosed = feedbackCase.status === "closed" || feedbackCase.closedAt !== null;
  const breach: FeedbackSlaBreach = isClosed
    ? null
    : feedbackCase.triagedAt === null && Date.parse(now) > Date.parse(triageDeadline)
      ? "triage"
      : feedbackCase.dueAt !== null && Date.parse(now) > Date.parse(feedbackCase.dueAt)
        ? "due"
        : null;

  return {
    triageDueAt: triageDeadline,
    effectiveDueAt,
    timeToTriageMs,
    breach,
    overdue: breach !== null,
  };
}

export type FeedbackAttentionDigestInput = Readonly<{
  attentionId: string;
  caseId: string;
  teamKey: string;
  ownerId: string | null;
  priority: FeedbackCasePriority;
  reason: FeedbackAttentionReason;
  dueAt: string | null;
  adminHref: string;
}>;

export type FeedbackAttentionDigest = Readonly<{
  windowStart: string;
  windowEnd: string;
  capped: boolean;
  groups: readonly Readonly<{
    teamKey: string;
    items: readonly FeedbackAttentionDigestInput[];
  }>[];
}>;

export function buildFeedbackAttentionDigest(
  items: readonly FeedbackAttentionDigestInput[],
  window: Readonly<{ start: string; end: string }>,
  options: Readonly<{ maxItems?: number }> = {},
): FeedbackAttentionDigest {
  const maxItems = Math.max(1, options.maxItems ?? 25);
  const unique = new Map<string, FeedbackAttentionDigestInput>();
  for (const item of items) {
    if (!unique.has(item.attentionId)) unique.set(item.attentionId, item);
  }

  const selected = [...unique.values()]
    .sort((left, right) => {
      const priority = priorityWeight(right.priority) - priorityWeight(left.priority);
      return (
        priority ||
        (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999") ||
        left.caseId.localeCompare(right.caseId)
      );
    })
    .slice(0, maxItems);
  const groups = new Map<string, FeedbackAttentionDigestInput[]>();
  for (const item of selected) groups.set(item.teamKey, [...(groups.get(item.teamKey) ?? []), item]);

  return {
    windowStart: new Date(window.start).toISOString(),
    windowEnd: new Date(window.end).toISOString(),
    capped: unique.size > selected.length,
    groups: [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([teamKey, grouped]) => ({ teamKey, items: grouped })),
  };
}

function priorityWeight(priority: FeedbackCasePriority): number {
  return priority === "urgent" ? 4 : priority === "high" ? 3 : priority === "normal" ? 2 : 1;
}

export function isAttentionOpen(status: FeedbackCaseStatus, reason: FeedbackAttentionReason): boolean {
  return status !== "closed" && (reason === "low-score" || reason === "reopened" || reason === "sla-breach");
}
