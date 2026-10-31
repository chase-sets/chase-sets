export type RiskAlertKind =
  | "chargeback-velocity"
  | "new-seller-listing-velocity"
  | "review-velocity"
  | "young-buyer-spend-velocity";

export type RiskAlertStatus = "needs-review" | "manual-payout-review-requested" | "acknowledged";

export type RiskAlertAction = "request-manual-payout-review" | "acknowledge";

/** Bounded reasons an operator action is refused before anything is appended. */
export const riskAlertActionRejectionCodes = ["alert-not-found", "action-not-allowed"] as const;

export type RiskAlertActionRejectionCode = (typeof riskAlertActionRejectionCodes)[number];

/** A refused risk-alert action; it carries only its bounded code, never request text. */
export class RiskAlertActionRejectedError extends Error {
  constructor(readonly code: RiskAlertActionRejectionCode) {
    super(`Risk alert action rejected: ${code}.`);
    this.name = "RiskAlertActionRejectedError";
  }
}

export type RiskAlertQueueItem = Readonly<{
  alert_id: string;
  account_id: string;
  alert_kind: RiskAlertKind;
  status: RiskAlertStatus;
  severity: "medium" | "high";
  manual_payout_review_candidate: boolean;
  evidence: Record<string, unknown>;
  threshold: Record<string, unknown>;
  first_triggered_at: string;
  last_triggered_at: string;
  last_action: RiskAlertAction | null;
  last_action_at: string | null;
  last_action_note: string | null;
  last_action_by_user_id: string | null;
  updated_at: string;
}>;

export type RiskAlertQueueDetail = RiskAlertQueueItem;

export type RiskAlertQueueMetrics = Readonly<{
  total_count: number;
  needs_review_count: number;
  manual_payout_review_candidate_count: number;
}>;
