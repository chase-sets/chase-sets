// Identity-owned public event payloads.
import type { AccountId, EnforcementActionId, SupportRequestId } from "../../primitives/typed-ids";
import type { EmptyEventPayload } from "./event-core";

/** Closed provenance for suspension/closure; `operator-other` means a manual action with no more-specific cause. */
export const accountEnforcementReasonCodes = [
  "policy-violation",
  "fulfillment-failure",
  "payment-risk",
  "identity-verification",
  "seller-requested",
  "operator-other",
] as const;

export type AccountEnforcementReasonCode = (typeof accountEnforcementReasonCodes)[number];

/** Closed provenance for reactivation; no reason grants authority or changes lifecycle preconditions. */
export const accountEnforcementReversalReasonCodes = [
  "appeal-upheld",
  "issue-resolved",
  "operator-error",
  "operator-other",
] as const;

export type AccountEnforcementReversalReasonCode = (typeof accountEnforcementReversalReasonCodes)[number];

export type AccountEnforcementReference = Readonly<{
  kind: "support-request";
  supportRequestId: SupportRequestId;
}>;

export type AccountEnforcementData<Reason extends string> = Readonly<{
  version: 1;
  enforcementActionId: EnforcementActionId;
  reason: Reason;
  reference: AccountEnforcementReference | null;
}>;

export type AccountEnforcementEventPayload<Reason extends string> =
  | EmptyEventPayload
  | Readonly<{ enforcement: AccountEnforcementData<Reason> }>;

export type IdentityAccountSuspendedPayload = AccountEnforcementEventPayload<AccountEnforcementReasonCode>;
export type IdentityAccountReactivatedPayload = AccountEnforcementEventPayload<AccountEnforcementReversalReasonCode>;
export type IdentityAccountClosedPayload = AccountEnforcementEventPayload<AccountEnforcementReasonCode>;

export type IdentityFoundersWindowOpenedPayload = Readonly<{
  betaAccessStartedAt: string;
  foundersWindowEndsAt: string;
  /** Additive grant-time recipient for downstream access notifications. */
  recipientEmail?: string;
}>;

export type IdentityFounderNumberClaimedPayload = Readonly<{
  accountId: AccountId;
  founderNumber: number;
  qualifyingActType: "listing-created" | "offer-submitted";
  qualifyingActId: string;
  claimedAt: string;
}>;

export type IdentityAccountBadgeAssignedPayload = Readonly<{
  badgeKey: string;
  founderNumber?: number;
}>;

export type IdentityEventPayloads = Readonly<{
  "identity.account.suspended": IdentityAccountSuspendedPayload;
  "identity.account.reactivated": IdentityAccountReactivatedPayload;
  "identity.account.closed": IdentityAccountClosedPayload;
  "identity.account.founders-window-opened": IdentityFoundersWindowOpenedPayload;
  "identity.founders-cohort.founder-number-claimed": IdentityFounderNumberClaimedPayload;
  "identity.account.badge-assigned": IdentityAccountBadgeAssignedPayload;
}>;
