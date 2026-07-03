import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId, InvitationId, UserId } from "@chase-sets/primitives/typed-ids";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  assertRoleAssignmentAllowed,
  normalizeEmail,
  type EmptyEventData,
  type InvitationStatus,
  type RoleAssignmentAuthority,
  type RoleKey,
} from "../../../support/runtime-support/common";

export type InvitationState = Readonly<{
  id: InvitationId | null;
  accountId: AccountId | null;
  email: string | null;
  roleKey: RoleKey | null;
  status: InvitationStatus;
  expiresAt: string | null;
  acceptanceTokenHash: string | null;
  acceptanceTokenExpiresAt: string | null;
  acceptanceTokenConsumedAt: string | null;
  acceptedByUserId: UserId | null;
}>;

export const initialInvitationState: InvitationState = {
  id: null,
  accountId: null,
  email: null,
  roleKey: null,
  status: "pending",
  expiresAt: null,
  acceptanceTokenHash: null,
  acceptanceTokenExpiresAt: null,
  acceptanceTokenConsumedAt: null,
  acceptedByUserId: null,
};

export type CreateInvitationCommand = Readonly<{
  type: "CreateInvitation";
  invitationId: InvitationId;
  accountId: AccountId;
  email: string;
  roleKey: RoleKey;
  expiresAt: string;
  assignmentAuthority: RoleAssignmentAuthority;
}>;

export type ResendInvitationCommand = Readonly<{
  type: "ResendInvitation";
  expiresAt: string;
}>;

export type IssueInvitationAcceptanceTokenCommand = Readonly<{
  type: "IssueInvitationAcceptanceToken";
  tokenHash: string;
  expiresAt: string;
}>;
export type CancelInvitationCommand = Readonly<{ type: "CancelInvitation" }>;
export type AcceptInvitationCommand = Readonly<{
  type: "AcceptInvitation";
  userId: UserId;
  acceptanceTokenHash: string;
  acceptedAt: string;
}>;
export type DeclineInvitationCommand = Readonly<{ type: "DeclineInvitation" }>;
export type ExpireInvitationCommand = Readonly<{ type: "ExpireInvitation" }>;

export type InvitationCommand =
  | CreateInvitationCommand
  | ResendInvitationCommand
  | IssueInvitationAcceptanceTokenCommand
  | CancelInvitationCommand
  | AcceptInvitationCommand
  | DeclineInvitationCommand
  | ExpireInvitationCommand;

export type InvitationCreatedEvent = DomainEvent<
  "identity.invitation.created",
  Readonly<{
    invitationId: InvitationId;
    accountId: AccountId;
    email: string;
    roleKey: RoleKey;
    expiresAt: string;
  }>
>;

export type InvitationResentEvent = DomainEvent<"identity.invitation.resent", Readonly<{ expiresAt: string }>>;
export type InvitationAcceptanceTokenIssuedEvent = DomainEvent<
  "identity.invitation.acceptance-token-issued",
  Readonly<{ tokenHash: string; expiresAt: string }>
>;
export type InvitationCancelledEvent = DomainEvent<"identity.invitation.cancelled", EmptyEventData>;
export type InvitationAcceptedEvent = DomainEvent<
  "identity.invitation.accepted",
  Readonly<{ userId: UserId; acceptedAt: string }>
>;
export type InvitationDeclinedEvent = DomainEvent<"identity.invitation.declined", EmptyEventData>;
export type InvitationExpiredEvent = DomainEvent<"identity.invitation.expired", EmptyEventData>;

export type InvitationEvent =
  | InvitationCreatedEvent
  | InvitationResentEvent
  | InvitationAcceptanceTokenIssuedEvent
  | InvitationCancelledEvent
  | InvitationAcceptedEvent
  | InvitationDeclinedEvent
  | InvitationExpiredEvent;

export const decideInvitation: AggregateDecider<InvitationState, InvitationCommand, InvitationEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "CreateInvitation":
      assert(state.id === null, "Invitation has already been created.");
      assertRoleAssignmentAllowed(command.roleKey, command.assignmentAuthority);
      return [
        {
          type: "identity.invitation.created",
          data: {
            invitationId: command.invitationId,
            accountId: command.accountId,
            email: normalizeEmail(command.email),
            roleKey: command.roleKey,
            expiresAt: command.expiresAt,
          },
        },
      ];
    case "ResendInvitation":
      requirePendingInvitation(state);
      return [
        {
          type: "identity.invitation.resent",
          data: { expiresAt: command.expiresAt },
        },
      ];
    case "IssueInvitationAcceptanceToken":
      requirePendingInvitation(state);
      assert(command.tokenHash.trim().length > 0, "Invitation acceptance token hash is required.");
      assert(command.expiresAt.trim().length > 0, "Invitation acceptance token expiry is required.");
      assert(!Number.isNaN(Date.parse(command.expiresAt)), "Invitation acceptance token expiry is invalid.");
      assert(
        state.expiresAt === null || Date.parse(command.expiresAt) <= Date.parse(state.expiresAt),
        "Invitation acceptance token cannot outlive the invitation.",
      );
      return [
        {
          type: "identity.invitation.acceptance-token-issued",
          data: { tokenHash: command.tokenHash, expiresAt: command.expiresAt },
        },
      ];
    case "CancelInvitation":
      requirePendingInvitation(state);
      return [{ type: "identity.invitation.cancelled", data: EMPTY_EVENT_DATA }];
    case "AcceptInvitation":
      requirePendingInvitation(state);
      validateInvitationAcceptanceToken(state, command.acceptanceTokenHash, command.acceptedAt);
      return [
        {
          type: "identity.invitation.accepted",
          data: { userId: command.userId, acceptedAt: command.acceptedAt },
        },
      ];
    case "DeclineInvitation":
      requirePendingInvitation(state);
      return [{ type: "identity.invitation.declined", data: EMPTY_EVENT_DATA }];
    case "ExpireInvitation":
      requirePendingInvitation(state);
      return [{ type: "identity.invitation.expired", data: EMPTY_EVENT_DATA }];
    default:
      return assertNever(command);
  }
};

export const evolveInvitation: AggregateEvolver<InvitationState, InvitationEvent> = (state, event) => {
  switch (event.type) {
    case "identity.invitation.created":
      return {
        id: event.data.invitationId,
        accountId: event.data.accountId,
        email: event.data.email,
        roleKey: event.data.roleKey,
        status: "pending",
        expiresAt: event.data.expiresAt,
        acceptedByUserId: null,
        acceptanceTokenHash: null,
        acceptanceTokenExpiresAt: null,
        acceptanceTokenConsumedAt: null,
      };
    case "identity.invitation.resent":
      return { ...state, expiresAt: event.data.expiresAt };
    case "identity.invitation.acceptance-token-issued":
      return {
        ...state,
        acceptanceTokenHash: event.data.tokenHash,
        acceptanceTokenExpiresAt: event.data.expiresAt,
        acceptanceTokenConsumedAt: null,
      };
    case "identity.invitation.cancelled":
      return { ...state, status: "cancelled" };
    case "identity.invitation.accepted":
      return {
        ...state,
        status: "accepted",
        acceptedByUserId: event.data.userId,
        acceptanceTokenConsumedAt: event.data.acceptedAt,
      };
    case "identity.invitation.declined":
      return { ...state, status: "declined" };
    case "identity.invitation.expired":
      return { ...state, status: "expired" };
    default:
      return assertNever(event);
  }
};

function requirePendingInvitation(state: InvitationState) {
  assert(state.id !== null, "Invitation must be created first.");
  assert(state.status === "pending", "Only pending invitations can change.");
}

export function validateInvitationAcceptanceToken(state: InvitationState, tokenHash: string, verifiedAt: string) {
  requirePendingInvitation(state);
  assert(state.expiresAt !== null && Date.parse(state.expiresAt) > Date.parse(verifiedAt), "Invitation is expired.");
  assert(state.acceptanceTokenHash !== null, "Invitation acceptance token is required.");
  assert(state.acceptanceTokenConsumedAt === null, "Invitation acceptance token has already been used.");
  assert(
    state.acceptanceTokenExpiresAt !== null && Date.parse(state.acceptanceTokenExpiresAt) > Date.parse(verifiedAt),
    "Invitation acceptance token is expired.",
  );
  assert(state.acceptanceTokenHash === tokenHash, "Invitation acceptance token is invalid.");
}
