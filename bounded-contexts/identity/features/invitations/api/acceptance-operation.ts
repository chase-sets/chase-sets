import { createHash } from "node:crypto";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { MembershipId, UserId } from "@chase-sets/primitives/typed-ids";
import { IdentityDomainError, normalizeEmail, parseGrantableRoleKey } from "../../../support/runtime-support/common";
import { decideInvitation, evolveInvitation, initialInvitationState, type InvitationEvent } from "../domain/domain";
import {
  decideMembership,
  evolveMembership,
  initialMembershipState,
  type MembershipEvent,
} from "../../memberships/domain/domain";
import { evolveUser, initialUserState, type UserEvent } from "../../users/domain/domain";
import { evolveAccount, initialAccountState, type AccountEvent } from "../../accounts/domain/domain";

export type InvitationAcceptanceOperation = Readonly<{
  version: 1;
  attemptId: string;
  invitationId: string;
  accountId: string;
  roleKey: string;
  emailFingerprint: string;
  userId: string;
  membershipId: string;
  bindingDigest: string;
}>;

export const INVITATION_ACCEPTANCE_RECEIPT_EVENT = "identity.invitation-acceptance.completed";
export const INVITATION_ACCEPTANCE_MAX_EVENTS = 1024;
const MAX_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const OPERATION_FIELDS = [
  "version",
  "attemptId",
  "invitationId",
  "accountId",
  "roleKey",
  "emailFingerprint",
  "userId",
  "membershipId",
  "bindingDigest",
];

function refuse(): never {
  throw new IdentityDomainError("Invitation acceptance authority is unavailable.");
}

export function invitationEmailFingerprint(email: string): string {
  return createHash("sha256")
    .update(`invitation-recipient:v1:${normalizeEmail(email)}`)
    .digest("hex");
}

export function parseInvitationAcceptanceOperation(value: unknown): InvitationAcceptanceOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== OPERATION_FIELDS.length || OPERATION_FIELDS.some((key) => !(key in data)))
    return refuse();
  if (data.version !== 1 || typeof data.attemptId !== "string" || !UUID.test(data.attemptId)) return refuse();
  for (const [field, prefix] of [
    ["invitationId", "ivt"],
    ["accountId", "acc"],
    ["userId", "usr"],
    ["membershipId", "mbr"],
  ]) {
    const id = data[field];
    if (typeof id !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,80}$`).test(id)) return refuse();
  }
  if (typeof data.roleKey !== "string" || !parseGrantableRoleKey(data.roleKey)) return refuse();
  if (typeof data.emailFingerprint !== "string" || !DIGEST.test(data.emailFingerprint)) return refuse();
  if (typeof data.bindingDigest !== "string" || !DIGEST.test(data.bindingDigest)) return refuse();
  return data as InvitationAcceptanceOperation;
}

function agrees(left: InvitationAcceptanceOperation, right: InvitationAcceptanceOperation): boolean {
  return OPERATION_FIELDS.every(
    (key) => left[key as keyof InvitationAcceptanceOperation] === right[key as keyof InvitationAcceptanceOperation],
  );
}

export async function readInvitationAcceptanceHistory(store: EventStore, streamId: string, context: EventStoreContext) {
  const events = await readCompleteStream(store, { streamId, maxEvents: INVITATION_ACCEPTANCE_MAX_EVENTS });
  let bytes = 0;
  for (const event of events) {
    bytes += Buffer.byteLength(JSON.stringify(event.payload), "utf8");
    if (bytes > MAX_BYTES || event.tenantId !== context.tenantId) refuse();
  }
  return events;
}

function invitationState(events: readonly StoredEvent[]) {
  let state = initialInvitationState;
  let created = false;
  for (const event of events) {
    const data = event.payload;
    const pending = created && state.status === "pending";
    switch (event.eventType) {
      case "identity.invitation.created":
        closed(data, ["invitationId", "accountId", "email", "roleKey", "expiresAt"]);
        if (
          created ||
          typeof data.invitationId !== "string" ||
          typeof data.accountId !== "string" ||
          typeof data.email !== "string" ||
          !parseGrantableRoleKey(data.roleKey) ||
          !instant(data.expiresAt)
        )
          refuse();
        created = true;
        break;
      case "identity.invitation.resent":
        closed(data, ["expiresAt"]);
        if (!pending || !instant(data.expiresAt)) refuse();
        break;
      case "identity.invitation.acceptance-token-issued":
        closed(data, ["tokenHash", "expiresAt"]);
        if (
          !pending ||
          typeof data.tokenHash !== "string" ||
          !data.tokenHash ||
          !instant(data.expiresAt) ||
          Date.parse(data.expiresAt) > Date.parse(state.expiresAt ?? "")
        )
          refuse();
        break;
      case "identity.invitation.accepted":
        closed(data, ["userId", "acceptedAt"]);
        if (
          !pending ||
          typeof data.userId !== "string" ||
          !instant(data.acceptedAt) ||
          !state.acceptanceTokenHash ||
          Date.parse(state.expiresAt ?? "") <= Date.parse(data.acceptedAt) ||
          Date.parse(state.acceptanceTokenExpiresAt ?? "") <= Date.parse(data.acceptedAt)
        )
          refuse();
        break;
      case "identity.invitation.cancelled":
      case "identity.invitation.declined":
      case "identity.invitation.expired":
        if (!pending || Object.keys(data).length !== 0) refuse();
        break;
      default:
        refuse();
    }
    state = evolveInvitation(state, { type: event.eventType, data } as InvitationEvent);
  }
  return state;
}

function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function closed(data: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []) {
  if (
    keys.some((key) => !(key in data)) ||
    Object.keys(data).some((key) => !keys.includes(key) && !optional.includes(key))
  )
    refuse();
}

function accountState(events: readonly StoredEvent[]) {
  let state = initialAccountState;
  for (const event of events) {
    const data = event.payload;
    if (event.eventType === "identity.account.created") {
      closed(data, ["accountId", "accountType", "name", "displayName"]);
      if (
        state.id ||
        typeof data.accountId !== "string" ||
        typeof data.name !== "string" ||
        typeof data.displayName !== "string"
      )
        refuse();
    } else {
      if (!state.id || state.status === "closed") refuse();
      if (event.eventType === "identity.account.suspended" && state.status !== "active") refuse();
      if (event.eventType === "identity.account.reactivated" && state.status !== "suspended") refuse();
      switch (event.eventType) {
        case "identity.account.profile-updated":
          closed(data, ["name", "displayName"]);
          if (typeof data.name !== "string" || typeof data.displayName !== "string") refuse();
          break;
        case "identity.account.founders-window-opened":
          closed(data, ["betaAccessStartedAt", "foundersWindowEndsAt"], ["recipientEmail"]);
          if (
            state.foundersWindow ||
            !instant(data.betaAccessStartedAt) ||
            !instant(data.foundersWindowEndsAt) ||
            Date.parse(data.betaAccessStartedAt) >= Date.parse(data.foundersWindowEndsAt)
          )
            refuse();
          break;
        case "identity.account.badge-assigned":
          closed(data, ["badgeKey"], ["founderNumber"]);
          if (
            typeof data.badgeKey !== "string" ||
            state.badges.includes(data.badgeKey as (typeof state.badges)[number]) ||
            (data.founderNumber !== undefined &&
              (!Number.isSafeInteger(data.founderNumber) || Number(data.founderNumber) < 1))
          )
            refuse();
          break;
        case "identity.account.badge-removed":
          closed(data, ["badgeKey"]);
          if (
            !state.badges.includes(data.badgeKey as (typeof state.badges)[number]) ||
            data.badgeKey === "founding-account"
          )
            refuse();
          break;
        case "identity.account.suspended":
        case "identity.account.reactivated":
        case "identity.account.closed":
          break; // The Account evolver closes and validates enforcement recursively, including legacy empty events.
        default:
          refuse();
      }
    }
    try {
      state = evolveAccount(state, { type: event.eventType, data } as AccountEvent);
    } catch {
      refuse();
    }
  }
  return state;
}

function userState(events: readonly StoredEvent[]) {
  let state = initialUserState;
  for (const event of events) {
    const data = event.payload;
    if (event.eventType === "identity.user.created") {
      closed(data, ["userId", "displayName", "primaryEmail", "primaryContactMethod"], ["givenName", "familyName"]);
      if (state.id || typeof data.userId !== "string" || typeof data.displayName !== "string") refuse();
      if (
        !data.primaryContactMethod ||
        typeof data.primaryContactMethod !== "object" ||
        Array.isArray(data.primaryContactMethod)
      )
        refuse();
      const contact = data.primaryContactMethod as Record<string, unknown>;
      closed(contact, ["contactMethodId", "type", "value", "verifiedAt"]);
      if (
        typeof contact.contactMethodId !== "string" ||
        typeof contact.value !== "string" ||
        (contact.verifiedAt !== null && !instant(contact.verifiedAt))
      )
        refuse();
    } else {
      if (!state.id) refuse();
      switch (event.eventType) {
        case "identity.user.profile-updated":
          closed(data, ["displayName", "givenName", "familyName"]);
          break;
        case "identity.user.contact-method-added":
          closed(data, ["contactMethodId", "contactMethodType", "value"]);
          if (state.contactMethods.some((contact) => contact.contactMethodId === data.contactMethodId)) refuse();
          break;
        case "identity.user.contact-method-verified":
          closed(data, ["contactMethodId", "verifiedAt"]);
          if (
            !instant(data.verifiedAt) ||
            !state.contactMethods.some(
              (contact) => contact.contactMethodId === data.contactMethodId && contact.verifiedAt === null,
            )
          )
            refuse();
          break;
        case "identity.user.auth-method-enabled":
        case "identity.user.auth-method-disabled":
          closed(data, ["authMethod"]);
          if (
            typeof data.authMethod !== "string" ||
            state.authMethods.includes(data.authMethod as (typeof state.authMethods)[number]) ===
              event.eventType.endsWith("enabled")
          )
            refuse();
          break;
        case "identity.user.password-credential-attached":
          closed(data, ["credentialId"]);
          if (state.passwordCredentialId || typeof data.credentialId !== "string") refuse();
          break;
        case "identity.user.passkey-registered":
          closed(data, ["credentialId"]);
          if (typeof data.credentialId !== "string" || state.passkeyCredentialIds.includes(data.credentialId)) refuse();
          break;
        case "identity.user.social-login-linked":
          closed(data, ["providerName", "providerSubject", "email", "linkedAt"]);
          if (!instant(data.linkedAt)) refuse();
          break;
        case "identity.user.suspended":
          closed(data, []);
          if (state.status !== "active") refuse();
          break;
        case "identity.user.reactivated":
          closed(data, []);
          if (state.status !== "suspended") refuse();
          break;
        default:
          refuse();
      }
    }
    try {
      state = evolveUser(state, { type: event.eventType, data } as UserEvent);
    } catch {
      refuse();
    }
  }
  return state;
}

function membershipState(events: readonly StoredEvent[]) {
  let state = initialMembershipState;
  for (const event of events) {
    const data = event.payload;
    switch (event.eventType) {
      case "identity.membership.granted":
        closed(data, ["membershipId", "userId", "accountId", "roleKey"]);
        if (
          state.id ||
          !parseGrantableRoleKey(data.roleKey) ||
          [data.membershipId, data.userId, data.accountId].some((id) => typeof id !== "string")
        )
          refuse();
        break;
      case "identity.membership.role-changed":
        closed(data, ["roleKey"]);
        if (!state.id || state.status !== "active" || !parseGrantableRoleKey(data.roleKey)) refuse();
        break;
      case "identity.membership.revoked":
        closed(data, []);
        if (!state.id || state.status !== "active") refuse();
        break;
      case "identity.membership.reinstated":
        closed(data, []);
        if (!state.id || state.status !== "revoked") refuse();
        break;
      default:
        refuse();
    }
    state = evolveMembership(state, { type: event.eventType, data } as MembershipEvent);
  }
  return state;
}

function input(
  streamId: string,
  history: readonly StoredEvent[],
  events: readonly Readonly<{ type: string; data: unknown }>[],
  context: EventStoreContext,
): AppendToStreamInput {
  return {
    streamId,
    expectedVersion: history.length ? history[history.length - 1].streamVersion : "no_stream",
    context,
    events: events.map((event) => ({ eventType: event.type, payload: event.data as JsonObject })),
  };
}

export async function readInvitationAcceptanceAuthority(
  store: EventStore,
  params: Readonly<{
    invitationId: string;
    acceptanceTokenHash: string;
    operation?: InvitationAcceptanceOperation;
    recipientUserId?: string;
    context: EventStoreContext;
  }>,
) {
  const history = await readInvitationAcceptanceHistory(
    store,
    `identity.invitation-${params.invitationId}`,
    params.context,
  );
  const invitation = invitationState(history);
  if (
    !invitation.id ||
    invitation.id !== params.invitationId ||
    !invitation.accountId ||
    !invitation.email ||
    !invitation.roleKey ||
    invitation.acceptanceTokenHash !== params.acceptanceTokenHash ||
    !params.acceptanceTokenHash ||
    !instant(invitation.expiresAt) ||
    !instant(invitation.acceptanceTokenExpiresAt) ||
    (invitation.status !== "pending" && invitation.status !== "accepted")
  )
    refuse();
  const tokenExpired = Date.parse(invitation.acceptanceTokenExpiresAt!) <= Date.now();
  if (invitation.status === "pending" && (Date.parse(invitation.expiresAt!) <= Date.now() || tokenExpired)) refuse();
  const accountHistory = await readInvitationAcceptanceHistory(
    store,
    `identity.account-${invitation.accountId}`,
    params.context,
  );
  const account = accountState(accountHistory);
  if (account.id !== invitation.accountId || account.status !== "active") refuse();
  let receiptHistory: readonly StoredEvent[] = [];
  if (params.operation) {
    const operation = parseInvitationAcceptanceOperation(params.operation);
    if (
      operation.invitationId !== invitation.id ||
      operation.accountId !== invitation.accountId ||
      operation.roleKey !== invitation.roleKey ||
      operation.emailFingerprint !== invitationEmailFingerprint(invitation.email)
    )
      refuse();
    receiptHistory = await readInvitationAcceptanceHistory(
      store,
      `identity.invitation-acceptance-${operation.attemptId}`,
      params.context,
    );
    if (receiptHistory.length > 1) refuse();
    if (receiptHistory.length) {
      if (
        receiptHistory[0].eventType !== INVITATION_ACCEPTANCE_RECEIPT_EVENT ||
        !agrees(parseInvitationAcceptanceOperation(receiptHistory[0].payload), operation)
      )
        refuse();
    }
    const userHistory = await readInvitationAcceptanceHistory(
      store,
      `identity.user-${operation.userId}`,
      params.context,
    );
    const membershipHistory = await readInvitationAcceptanceHistory(
      store,
      `identity.membership-${operation.membershipId}`,
      params.context,
    );
    if (receiptHistory.length || membershipHistory.length) {
      if (!store.appendToStreams) refuse();
      // Separate reads may straddle acceptance; prove their versions before judging their agreement.
      await store.appendToStreams([
        input(`identity.invitation-${operation.invitationId}`, history, [], params.context),
        input(`identity.account-${operation.accountId}`, accountHistory, [], params.context),
        input(`identity.user-${operation.userId}`, userHistory, [], params.context),
        input(`identity.membership-${operation.membershipId}`, membershipHistory, [], params.context),
        input(`identity.invitation-acceptance-${operation.attemptId}`, receiptHistory, [], params.context),
      ]);
    }
    if (receiptHistory.length && (invitation.status !== "accepted" || invitation.acceptedByUserId !== operation.userId))
      refuse();
    if (invitation.status === "accepted" && !receiptHistory.length) refuse();
    const user = userState(userHistory);
    if (
      userHistory.length &&
      (user.id !== operation.userId ||
        user.status !== "active" ||
        !user.contactMethods.some(
          (contact) => contact.type === "email" && normalizeEmail(contact.value) === normalizeEmail(invitation.email!),
        ))
    )
      refuse();
    if (receiptHistory.length && !user.id) refuse();
    const membership = membershipState(membershipHistory);
    if (
      receiptHistory.length &&
      (membership.id !== operation.membershipId ||
        membership.userId !== operation.userId ||
        membership.accountId !== invitation.accountId ||
        membership.roleKey !== invitation.roleKey ||
        membership.status !== "active")
    )
      refuse();
    if (!receiptHistory.length && membershipHistory.length) refuse();
    return {
      invitation,
      history,
      accountHistory,
      receiptHistory,
      userHistory,
      user,
      membershipHistory,
      membership,
      tokenExpired,
    };
  }
  if (invitation.status !== "pending") refuse();
  if (params.recipientUserId) {
    const userHistory = await readInvitationAcceptanceHistory(
      store,
      `identity.user-${params.recipientUserId}`,
      params.context,
    );
    const user = userState(userHistory);
    if (
      user.id !== params.recipientUserId ||
      user.status !== "active" ||
      !user.contactMethods.some(
        (contact) => contact.type === "email" && normalizeEmail(contact.value) === normalizeEmail(invitation.email!),
      )
    )
      refuse();
    return {
      invitation,
      history,
      accountHistory,
      receiptHistory,
      user,
      userHistory,
      membership: undefined,
      membershipHistory: undefined,
      tokenExpired,
    };
  }
  return {
    invitation,
    history,
    accountHistory,
    receiptHistory,
    user: undefined,
    userHistory: undefined,
    membership: undefined,
    membershipHistory: undefined,
    tokenExpired,
  };
}

export async function acceptInvitationOperation(
  store: EventStore,
  params: Readonly<{
    operation: InvitationAcceptanceOperation;
    acceptanceTokenHash: string;
    context: EventStoreContext;
  }>,
) {
  const operation = parseInvitationAcceptanceOperation(params.operation);
  if (!store.appendToStreams) throw new Error("Atomic Invitation acceptance requires appendToStreams.");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const authority = await readInvitationAcceptanceAuthority(store, {
        ...params,
        invitationId: operation.invitationId,
        operation,
      });
      if (!authority.userHistory || !authority.user?.id || !authority.membershipHistory || !authority.membership)
        return refuse();
      if (authority.receiptHistory.length) return { membershipId: operation.membershipId, snapshots: [] };
      const accepted = decideInvitation(authority.invitation, {
        type: "AcceptInvitation",
        userId: operation.userId as UserId,
        acceptanceTokenHash: params.acceptanceTokenHash,
        acceptedAt: new Date().toISOString(),
      });
      const granted = decideMembership(authority.membership, {
        type: "GrantMembership",
        membershipId: operation.membershipId as MembershipId,
        userId: operation.userId as UserId,
        accountId: authority.invitation.accountId!,
        roleKey: parseGrantableRoleKey(operation.roleKey)!,
        assignmentAuthority: { type: "system" },
      });
      const results = await store.appendToStreams([
        input(`identity.invitation-${operation.invitationId}`, authority.history, accepted, params.context),
        input(`identity.membership-${operation.membershipId}`, authority.membershipHistory, granted, params.context),
        input(
          `identity.invitation-acceptance-${operation.attemptId}`,
          authority.receiptHistory,
          [{ type: INVITATION_ACCEPTANCE_RECEIPT_EVENT, data: operation }],
          params.context,
        ),
        input(`identity.account-${operation.accountId}`, authority.accountHistory, [], params.context),
        input(`identity.user-${operation.userId}`, authority.userHistory, [], params.context),
      ]);
      return {
        membershipId: operation.membershipId,
        snapshots: results.slice(0, 2).map((result, index) => ({
          aggregate: index === 0 ? ("invitation" as const) : ("membership" as const),
          id: index === 0 ? operation.invitationId : operation.membershipId,
          version: result.storedEvents[result.storedEvents.length - 1].streamVersion,
          status: index === 0 ? "accepted" : "active",
        })),
      };
    } catch (error) {
      if (
        attempt === 0 &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "concurrency_conflict"
      )
        continue;
      throw error;
    }
  }
  return refuse();
}
