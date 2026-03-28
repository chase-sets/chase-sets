import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId, MembershipId, UserId } from "@chase-sets/primitives/typed-ids";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  type EmptyEventData,
  type MembershipStatus,
  type RoleKey,
} from "../common";

export type MembershipState = Readonly<{
  id: MembershipId | null;
  userId: UserId | null;
  accountId: AccountId | null;
  roleKey: RoleKey | null;
  status: MembershipStatus;
}>;

export const initialMembershipState: MembershipState = {
  id: null,
  userId: null,
  accountId: null,
  roleKey: null,
  status: "active",
};

export type GrantMembershipCommand = Readonly<{
  type: "GrantMembership";
  membershipId: MembershipId;
  userId: UserId;
  accountId: AccountId;
  roleKey: RoleKey;
}>;

export type ChangeMembershipRoleCommand = Readonly<{
  type: "ChangeMembershipRole";
  roleKey: RoleKey;
}>;

export type RevokeMembershipCommand = Readonly<{ type: "RevokeMembership" }>;
export type ReinstateMembershipCommand = Readonly<{ type: "ReinstateMembership" }>;

export type MembershipCommand =
  | GrantMembershipCommand
  | ChangeMembershipRoleCommand
  | RevokeMembershipCommand
  | ReinstateMembershipCommand;

export type MembershipGrantedEvent = DomainEvent<
  "identity.membership.granted",
  Readonly<{
    membershipId: MembershipId;
    userId: UserId;
    accountId: AccountId;
    roleKey: RoleKey;
  }>
>;

export type MembershipRoleChangedEvent = DomainEvent<
  "identity.membership.role-changed",
  Readonly<{
    roleKey: RoleKey;
  }>
>;

export type MembershipRevokedEvent = DomainEvent<
  "identity.membership.revoked",
  EmptyEventData
>;

export type MembershipReinstatedEvent = DomainEvent<
  "identity.membership.reinstated",
  EmptyEventData
>;

export type MembershipEvent =
  | MembershipGrantedEvent
  | MembershipRoleChangedEvent
  | MembershipRevokedEvent
  | MembershipReinstatedEvent;

export const decideMembership: AggregateDecider<
  MembershipState,
  MembershipCommand,
  MembershipEvent
> = (state, command) => {
  switch (command.type) {
    case "GrantMembership":
      assert(state.id === null, "Membership has already been created.");
      return [
        {
          type: "identity.membership.granted",
          data: {
            membershipId: command.membershipId,
            userId: command.userId,
            accountId: command.accountId,
            roleKey: command.roleKey,
          },
        },
      ];
    case "ChangeMembershipRole":
      requireCreatedMembership(state);
      assert(state.status === "active", "Only active memberships can change roles.");
      assert(state.roleKey !== command.roleKey, "Membership already uses that role.");
      return [
        {
          type: "identity.membership.role-changed",
          data: { roleKey: command.roleKey },
        },
      ];
    case "RevokeMembership":
      requireCreatedMembership(state);
      assert(state.status === "active", "Only active memberships can be revoked.");
      return [{ type: "identity.membership.revoked", data: EMPTY_EVENT_DATA }];
    case "ReinstateMembership":
      requireCreatedMembership(state);
      assert(
        state.status === "revoked",
        "Only revoked memberships can be reinstated.",
      );
      return [{ type: "identity.membership.reinstated", data: EMPTY_EVENT_DATA }];
    default:
      return assertNever(command);
  }
};

export const evolveMembership: AggregateEvolver<
  MembershipState,
  MembershipEvent
> = (state, event) => {
  switch (event.type) {
    case "identity.membership.granted":
      return {
        id: event.data.membershipId,
        userId: event.data.userId,
        accountId: event.data.accountId,
        roleKey: event.data.roleKey,
        status: "active",
      };
    case "identity.membership.role-changed":
      return { ...state, roleKey: event.data.roleKey };
    case "identity.membership.revoked":
      return { ...state, status: "revoked" };
    case "identity.membership.reinstated":
      return { ...state, status: "active" };
    default:
      return assertNever(event);
  }
};

function requireCreatedMembership(state: MembershipState) {
  assert(state.id !== null, "Membership must be granted first.");
}
