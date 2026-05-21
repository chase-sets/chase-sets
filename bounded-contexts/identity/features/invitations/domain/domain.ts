import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId, InvitationId, UserId } from "@chase-sets/primitives/typed-ids";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  normalizeEmail,
  type EmptyEventData,
  type InvitationStatus,
  type RoleKey,
} from "../../../support/runtime-support/common";

export type InvitationState = Readonly<{
  id: InvitationId | null;
  accountId: AccountId | null;
  email: string | null;
  roleKey: RoleKey | null;
  status: InvitationStatus;
  expiresAt: string | null;
  acceptedByUserId: UserId | null;
}>;

export const initialInvitationState: InvitationState = {
  id: null,
  accountId: null,
  email: null,
  roleKey: null,
  status: "pending",
  expiresAt: null,
  acceptedByUserId: null,
};

export type CreateInvitationCommand = Readonly<{
  type: "CreateInvitation";
  invitationId: InvitationId;
  accountId: AccountId;
  email: string;
  roleKey: RoleKey;
  expiresAt: string;
}>;

export type ResendInvitationCommand = Readonly<{
  type: "ResendInvitation";
  expiresAt: string;
}>;

export type CancelInvitationCommand = Readonly<{ type: "CancelInvitation" }>;
export type AcceptInvitationCommand = Readonly<{
  type: "AcceptInvitation";
  userId: UserId;
}>;
export type DeclineInvitationCommand = Readonly<{ type: "DeclineInvitation" }>;
export type ExpireInvitationCommand = Readonly<{ type: "ExpireInvitation" }>;

export type InvitationCommand =
  | CreateInvitationCommand
  | ResendInvitationCommand
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
export type InvitationCancelledEvent = DomainEvent<"identity.invitation.cancelled", EmptyEventData>;
export type InvitationAcceptedEvent = DomainEvent<"identity.invitation.accepted", Readonly<{ userId: UserId }>>;
export type InvitationDeclinedEvent = DomainEvent<"identity.invitation.declined", EmptyEventData>;
export type InvitationExpiredEvent = DomainEvent<"identity.invitation.expired", EmptyEventData>;

export type InvitationEvent =
  | InvitationCreatedEvent
  | InvitationResentEvent
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
    case "CancelInvitation":
      requirePendingInvitation(state);
      return [{ type: "identity.invitation.cancelled", data: EMPTY_EVENT_DATA }];
    case "AcceptInvitation":
      requirePendingInvitation(state);
      return [
        {
          type: "identity.invitation.accepted",
          data: { userId: command.userId },
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
      };
    case "identity.invitation.resent":
      return { ...state, expiresAt: event.data.expiresAt };
    case "identity.invitation.cancelled":
      return { ...state, status: "cancelled" };
    case "identity.invitation.accepted":
      return {
        ...state,
        status: "accepted",
        acceptedByUserId: event.data.userId,
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
