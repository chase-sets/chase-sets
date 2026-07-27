// Identity-owned public event payloads.
import type { AccountId } from "../../primitives/typed-ids";

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
  "identity.account.founders-window-opened": IdentityFoundersWindowOpenedPayload;
  "identity.founders-cohort.founder-number-claimed": IdentityFounderNumberClaimedPayload;
  "identity.account.badge-assigned": IdentityAccountBadgeAssignedPayload;
}>;
