import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { assert } from "../../../support/runtime-support/common";

export const FOUNDERS_COHORT_CAP = 500;

export type QualifyingActType = "listing-created" | "offer-submitted";

export type FounderClaim = Readonly<{
  accountId: AccountId;
  founderNumber: number;
  qualifyingActType: QualifyingActType;
  qualifyingActId: string;
  claimedAt: string;
}>;

export type FoundersCohortState = Readonly<{ claims: readonly FounderClaim[] }>;
export const initialFoundersCohortState: FoundersCohortState = { claims: [] };

export type ClaimFounderNumberCommand = Readonly<{
  type: "ClaimFounderNumber";
  accountId: AccountId;
  qualifyingActType: QualifyingActType;
  qualifyingActId: string;
  claimedAt: string;
}>;

export type FounderNumberClaimedEvent = DomainEvent<"identity.founders-cohort.founder-number-claimed", FounderClaim>;

export const decideFoundersCohort: AggregateDecider<
  FoundersCohortState,
  ClaimFounderNumberCommand,
  FounderNumberClaimedEvent
> = (state, command) => {
  const existing = state.claims.find((claim) => claim.accountId === command.accountId);
  if (existing) {
    return [];
  }

  if (state.claims.length >= FOUNDERS_COHORT_CAP) {
    return [];
  }
  const claimedAt = normalizeIsoTimestamp(command.claimedAt, "Founder claim time");
  const qualifyingActId = command.qualifyingActId.trim();
  assert(qualifyingActId.length > 0, "Qualifying act id is required.");

  return [
    {
      type: "identity.founders-cohort.founder-number-claimed",
      data: {
        accountId: command.accountId,
        founderNumber: state.claims.length + 1,
        qualifyingActType: command.qualifyingActType,
        qualifyingActId,
        claimedAt,
      },
    },
  ];
};

export const evolveFoundersCohort: AggregateEvolver<FoundersCohortState, FounderNumberClaimedEvent> = (
  state,
  event,
) => ({ claims: [...state.claims, event.data] });

function normalizeIsoTimestamp(value: string, fieldName: string) {
  const normalized = value.trim();
  assert(Number.isFinite(Date.parse(normalized)), `${fieldName} must be an ISO timestamp.`);
  return new Date(normalized).toISOString();
}
