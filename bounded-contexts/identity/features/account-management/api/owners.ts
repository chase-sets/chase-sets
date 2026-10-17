import type { DomainEvent } from "@chase-sets/event-core";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import { decideAccount, evolveAccount, initialAccountState, type AccountEvent } from "../../accounts/domain/domain";
import { decideUser, evolveUser, initialUserState, type UserEvent } from "../../users/domain/domain";
import {
  decideMembership,
  evolveMembership,
  initialMembershipState,
  type MembershipEvent,
} from "../../memberships/domain/domain";
import {
  decideInvitation,
  evolveInvitation,
  initialInvitationState,
  type InvitationEvent,
} from "../../invitations/domain/domain";
import {
  decideAuthorizedConsent,
  evolveConsent,
  initialConsentState,
  type ConsentEvent,
} from "../../consents/domain/domain";
import { authorizeConsentForActor } from "../../consents/domain/consent-recording-authorization";
import { decideApiKey, evolveApiKey, initialApiKeyState, type ApiKeyEvent } from "../../api-keys/domain/domain";
import {
  decideShippingAddressBook,
  evolveShippingAddressBook,
  initialShippingAddressBookState,
  normalizeShippingAddressSnapshot,
  type ShippingAddressEvent,
} from "../../shipping-addresses/domain/domain";
import type { IdentityServices } from "../../../support/runtime-support/services";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { hasPermission } from "../../../support/request-support/permissions";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  assertRoleAssignmentAllowed,
  parseGrantableRoleKey,
  parseRoleKey,
} from "../../../support/runtime-support/common";
import { digest, type CanonicalRequest } from "../domain/attempt";
import { validateOwnerEvent, validateShippingAddressSnapshot } from "../domain/owner-event";

export class AddressChoiceRequired extends Error {
  constructor(readonly suggestedAddress: ReturnType<typeof validateShippingAddressSnapshot>) {
    super("address-standardization-suggested");
  }
}

export type OwnerKind =
  | "account"
  | "shipping-address-book"
  | "consent"
  | "user"
  | "api-key"
  | "membership"
  | "invitation";

function fold<State, Event extends DomainEvent>(
  history: readonly StoredEvent[],
  initial: State,
  evolve: (state: State, event: Event) => State,
): State {
  return history.reduce(
    (state, event) => evolve(state, { type: event.eventType, data: event.payload } as Event),
    initial,
  );
}

export function ownerState(kind: OwnerKind, history: readonly StoredEvent[]) {
  switch (kind) {
    case "account":
      return { kind, state: fold<AccountState, AccountEvent>(history, initialAccountState, evolveAccount) } as const;
    case "shipping-address-book":
      return { kind, state: fold(history, initialShippingAddressBookState, evolveShippingAddressBook) } as const;
    case "consent":
      return { kind, state: fold(history, initialConsentState, evolveConsent) } as const;
    case "user":
      return { kind, state: fold(history, initialUserState, evolveUser) } as const;
    case "api-key":
      return { kind, state: fold(history, initialApiKeyState, evolveApiKey) } as const;
    case "membership":
      return { kind, state: fold(history, initialMembershipState, evolveMembership) } as const;
    case "invitation":
      return { kind, state: fold(history, initialInvitationState, evolveInvitation) } as const;
  }
}
type AccountState = typeof initialAccountState;
export type Owner = ReturnType<typeof ownerState>;

export function ownerForRequest(
  request: CanonicalRequest,
  actor: ResolvedActor,
  generatedId: string,
): Readonly<{ kind: OwnerKind; id: string; streamId: string }> {
  const target = request.target ?? generatedId;
  switch (request.action) {
    case "update-profile":
      return { kind: "account", id: actor.accountId, streamId: `identity.account-${actor.accountId}` };
    case "create":
    case "update":
    case "default":
    case "archive":
      return {
        kind: "shipping-address-book",
        id: actor.accountId,
        streamId: `identity.shipping-address-book-${actor.accountId}`,
      };
    case "withdraw":
      return { kind: "consent", id: target, streamId: `identity.consent-${target}` };
    case "update-user":
      return { kind: "user", id: actor.userId, streamId: `identity.user-${actor.userId}` };
    case "create-api-key":
    case "rotate-api-key":
    case "revoke-api-key":
      return { kind: "api-key", id: target, streamId: `identity.api-key-${target}` };
    case "create-invitation":
    case "cancel-invitation":
      return { kind: "invitation", id: target, streamId: `identity.invitation-${target}` };
    case "change-role":
    case "revoke":
    case "reinstate":
      return { kind: "membership", id: target, streamId: `identity.membership-${target}` };
  }
}

export function assertOwnerAuthorization(owner: Owner, request: CanonicalRequest, actor: ResolvedActor): void {
  if (request.action === "update-profile" && request.target !== actor.accountId)
    throw new Error("authorization_forbidden");
  if (request.action === "update-user" && request.target !== actor.userId) throw new Error("authorization_forbidden");
  if (request.fields.userId !== undefined && request.fields.userId !== actor.userId)
    throw new Error("authorization_forbidden");
  if (request.fields.accountId !== undefined && request.fields.accountId !== actor.accountId)
    throw new Error("authorization_forbidden");
  switch (owner.kind) {
    case "membership":
    case "invitation":
      if (owner.state.id && owner.state.accountId !== actor.accountId) throw new Error("authorization_forbidden");
      break;
    case "api-key":
      if (owner.state.id && owner.state.userId !== actor.userId) throw new Error("authorization_forbidden");
      break;
    case "consent":
      if (
        !owner.state.id ||
        owner.state.userId !== actor.userId ||
        (owner.state.subjectType === "account" && owner.state.accountId !== actor.accountId)
      )
        throw new Error("authorization_forbidden");
      if (
        owner.state.subjectType === "account" &&
        actor.roleKey !== "platform-admin" &&
        !hasPermission(actor, "accounts.manage") &&
        !hasPermission(actor, "security.manage")
      )
        throw new Error("authorization_forbidden");
      break;
    case "shipping-address-book":
      if (owner.state.accountId && owner.state.accountId !== actor.accountId)
        throw new Error("authorization_forbidden");
      break;
  }
}

export async function planOwnerMutation(
  args: Readonly<{
    owner: Owner;
    history: readonly StoredEvent[];
    request: CanonicalRequest;
    actor: ResolvedActor;
    context: EventStoreContext;
    id: string;
    services: Pick<IdentityServices, "auth" | "shippingAddresses">;
  }>,
) {
  const { owner, history, request, actor, context, id, services } = args;
  const fields = request.fields;
  const text = (name: string) => String(fields[name] ?? "");
  const now = new Date().toISOString();
  const roleKey = parseGrantableRoleKey(fields.roleKey);
  const actorRole = parseRoleKey(actor.roleKey);
  const assignmentAuthority = actorRole ? { type: "actor" as const, roleKey: actorRole } : null;
  let events: readonly DomainEvent[];
  let secret: string | undefined;
  switch (owner.kind) {
    case "account": {
      events = decideAccount(owner.state, {
        type: "UpdateAccountProfile",
        name: text("name"),
        displayName: fields.displayName === undefined ? text("name") : text("displayName"),
      });
      if (events[0]?.data.name === owner.state.name && events[0]?.data.displayName === owner.state.displayName)
        events = [];
      break;
    }
    case "user": {
      events = decideUser(owner.state, {
        type: "UpdateUserProfile",
        displayName: text("displayName"),
        givenName: text("givenName"),
        familyName: text("familyName"),
      });
      if (
        events[0]?.data.displayName === owner.state.displayName &&
        events[0]?.data.givenName === owner.state.givenName &&
        events[0]?.data.familyName === owner.state.familyName
      )
        events = [];
      break;
    }
    case "membership": {
      if (!owner.state.id) throw new Error("conflict");
      if (request.action === "change-role") {
        if (!roleKey || !assignmentAuthority) throw new Error("authorization_forbidden");
        // The decider's assignment check still applies to an otherwise equal request.
        if (owner.state.status === "active" && owner.state.roleKey === roleKey) {
          assertRoleAssignmentAllowed(roleKey, assignmentAuthority);
          events = [];
        } else events = decideMembership(owner.state, { type: "ChangeMembershipRole", roleKey, assignmentAuthority });
      } else if (request.action === "revoke") {
        events = owner.state.status === "revoked" ? [] : decideMembership(owner.state, { type: "RevokeMembership" });
      } else {
        if (owner.state.status === "active") {
          if (
            !history.some((event) => event.eventType === "identity.membership.revoked") ||
            !history.some((event) => event.eventType === "identity.membership.reinstated")
          )
            throw new Error("conflict");
          events = [];
        } else events = decideMembership(owner.state, { type: "ReinstateMembership" });
      }
      break;
    }
    case "consent":
      events = decideAuthorizedConsent(owner.state, {
        command: { type: "WithdrawConsent", withdrawnAt: now },
        authorization: authorizeConsentForActor(context),
      });
      break;
    case "invitation":
      if (request.action === "create-invitation") {
        if (!roleKey || !assignmentAuthority) throw new Error("authorization_forbidden");
        events = decideInvitation(owner.state, {
          type: "CreateInvitation",
          invitationId: parseTypedId(id, "ivt"),
          accountId: parseTypedId(actor.accountId, "acc"),
          email: text("email"),
          roleKey,
          expiresAt: text("expiresAt"),
          assignmentAuthority,
        });
      } else {
        if (owner.state.status === "cancelled") events = [];
        else {
          if (owner.state.expiresAt && Date.parse(owner.state.expiresAt) <= Date.parse(now))
            throw new Error("conflict");
          events = decideInvitation(owner.state, { type: "CancelInvitation" });
        }
      }
      break;
    case "api-key":
      if (request.action === "revoke-api-key")
        events =
          owner.state.id && owner.state.status === "revoked" ? [] : decideApiKey(owner.state, { type: "RevokeApiKey" });
      else {
        if (request.action === "rotate-api-key" && (!owner.state.id || owner.state.status !== "active"))
          throw new Error("conflict");
        secret = services.auth.issueOpaqueToken("key");
        const keyPrefix = secret.slice(0, 12);
        const business =
          request.action === "create-api-key"
            ? decideApiKey(owner.state, {
                type: "CreateApiKey",
                apiKeyId: parseTypedId(id, "key"),
                userId: parseTypedId(actor.userId, "usr"),
                name: text("name"),
                keyPrefix,
              })
            : decideApiKey(owner.state, { type: "RotateApiKey", keyPrefix });
        events = [
          ...business,
          {
            type: "identity.api-key.verifier-recorded",
            data: { keyPrefix, secretHash: services.auth.hashSecret(secret) },
          },
        ];
      }
      break;
    case "shipping-address-book": {
      const shippingAddressId = parseTypedId(request.target ?? id, "adr");
      if (request.action === "default")
        events = decideShippingAddressBook(owner.state, {
          type: "SetDefaultShippingAddress",
          shippingAddressId,
          setAt: now,
        });
      else if (request.action === "archive")
        events = decideShippingAddressBook(owner.state, {
          type: "ArchiveShippingAddress",
          shippingAddressId,
          archivedAt: now,
        });
      else {
        const address = normalizeShippingAddressSnapshot({
          name: text("name"),
          company: text("company") || null,
          line1: text("line1"),
          line2: text("line2") || null,
          city: text("city"),
          state: text("state"),
          postalCode: text("postalCode"),
          country: text("country") || "US",
          phone: text("phone") || null,
          email: text("email") || null,
        });
        const choice =
          fields.addressVerificationDecision === "accept-suggested" ||
          fields.addressVerificationDecision === "keep-original"
            ? fields.addressVerificationDecision
            : null;
        const verified = await services.shippingAddresses.verifyShippingAddress(address, choice);
        if (verified.status !== "accepted")
          throw new AddressChoiceRequired(validateShippingAddressSnapshot(verified.suggestedAddress));
        const command =
          request.action === "create"
            ? {
                type: "AddShippingAddress" as const,
                accountId: parseTypedId(actor.accountId, "acc"),
                shippingAddressId,
                label: text("label"),
                address: verified.address,
                makeDefault: fields.makeDefault === true,
                addedAt: now,
              }
            : {
                type: "UpdateShippingAddress" as const,
                shippingAddressId,
                label: text("label"),
                address: verified.address,
                makeDefault: fields.makeDefault === true,
                updatedAt: now,
              };
        events = decideShippingAddressBook(owner.state, command);
        const existing = owner.state.addresses.find((entry) => entry.shippingAddressId === shippingAddressId);
        if (existing && !existing.isArchived && request.action === "update") {
          const comparable = (value: typeof address) => ({
            ...value,
            verification: value.verification ? { ...value.verification, checkedAt: null } : null,
          });
          const acceptedAddress = normalizeShippingAddressSnapshot(verified.address);
          const label = text("label") || `${acceptedAddress.name} - ${acceptedAddress.city}, ${acceptedAddress.state}`;
          if (
            digest(comparable(acceptedAddress)) === digest(comparable(normalizeShippingAddressSnapshot(existing))) &&
            existing.label === label &&
            (fields.makeDefault !== true || existing.isDefault)
          )
            events = [];
        }
      }
      break;
    }
  }
  return { events, secret };
}

export function validateOwnerHistory(kind: OwnerKind, history: readonly StoredEvent[], tenantId: string): Owner {
  if (history.length > 10000) throw new Error("INDETERMINATE");
  const ids = new Set<string>();
  let created = false;
  let current = ownerState(kind, []);
  for (let index = 0; index < history.length; index++) {
    const event = history[index];
    if (
      event.tenantId !== tenantId ||
      event.streamVersion !== index + 1 ||
      ids.has(event.eventId) ||
      event.streamId !== history[0].streamId
    )
      throw new Error("INDETERMINATE");
    ids.add(event.eventId);
    const prefix = kind === "shipping-address-book" ? "identity.shipping-address." : `identity.${kind}.`;
    if (!event.eventType.startsWith(prefix)) throw new Error("INDETERMINATE");
    const isCreation =
      event.eventType.endsWith(".created") ||
      event.eventType.endsWith(".granted") ||
      event.eventType.endsWith(".recorded") ||
      event.eventType.endsWith(".added");
    if (!created && !isCreation) throw new Error("INDETERMINATE");
    if (created && isCreation && kind !== "shipping-address-book") throw new Error("INDETERMINATE");
    created = true;
    validateOwnerEvent(event.eventType, event.payload);
    const streamPrefix = `identity.${kind}-`;
    if (!event.streamId.startsWith(streamPrefix)) throw new Error("INDETERMINATE");
    const ownerId = event.streamId.slice(streamPrefix.length);
    const identityField = {
      account: "accountId",
      user: "userId",
      consent: "consentId",
      "api-key": "apiKeyId",
      membership: "membershipId",
      invitation: "invitationId",
      "shipping-address-book": "accountId",
    }[kind];
    if ((isCreation || kind === "shipping-address-book") && event.payload[identityField] !== ownerId)
      throw new Error("INDETERMINATE");
    if (current.kind === "account") {
      if (
        (event.eventType === "identity.account.suspended" && current.state.status !== "active") ||
        (event.eventType === "identity.account.reactivated" && current.state.status !== "suspended") ||
        (!isCreation && current.state.status === "closed")
      )
        throw new Error("INDETERMINATE");
    }
    if (current.kind === "membership") {
      if (event.eventType === "identity.membership.revoked" && current.state.status !== "active")
        throw new Error("INDETERMINATE");
      if (event.eventType === "identity.membership.reinstated" && current.state.status !== "revoked")
        throw new Error("INDETERMINATE");
      if (
        event.eventType === "identity.membership.role-changed" &&
        (current.state.status !== "active" || current.state.roleKey === event.payload.roleKey)
      )
        throw new Error("INDETERMINATE");
    }
    if (
      current.kind === "consent" &&
      event.eventType === "identity.consent.withdrawn" &&
      current.state.status !== "recorded"
    )
      throw new Error("INDETERMINATE");
    if (current.kind === "consent" && event.eventType === "identity.consent.withdrawn") {
      for (const field of ["consentId", "subjectType", "userId", "accountId", "policyKey", "policyVersion"] as const) {
        const expected = field === "consentId" ? current.state.id : current.state[field];
        if (event.payload[field] !== expected) throw new Error("INDETERMINATE");
      }
    }
    if (current.kind === "api-key" && !isCreation && current.state.status !== "active")
      throw new Error("INDETERMINATE");
    if (
      current.kind === "api-key" &&
      event.eventType === "identity.api-key.verifier-recorded" &&
      (!["identity.api-key.created", "identity.api-key.rotated"].includes(history[index - 1]?.eventType) ||
        current.state.keyPrefix !== event.payload.keyPrefix)
    )
      throw new Error("INDETERMINATE");
    if (current.kind === "invitation" && !isCreation && current.state.status !== "pending")
      throw new Error("INDETERMINATE");
    if (current.kind === "shipping-address-book") {
      const existing = current.state.addresses.find(
        (address) => address.shippingAddressId === event.payload.shippingAddressId,
      );
      if (isCreation ? existing !== undefined : !existing || existing.isArchived) throw new Error("INDETERMINATE");
      if (event.eventType === "identity.shipping-address.default-set" && existing?.isDefault)
        throw new Error("INDETERMINATE");
      if (event.eventType === "identity.shipping-address.archived") {
        const proposed = decideShippingAddressBook(current.state, {
          type: "ArchiveShippingAddress",
          shippingAddressId: parseTypedId(String(event.payload.shippingAddressId), "adr"),
          archivedAt: String(event.payload.archivedAt),
        });
        if (digest(proposed[0].data) !== digest(event.payload)) throw new Error("INDETERMINATE");
      }
    }
    current = evolveOwner(current, event);
  }
  return current;
}

function evolveOwner(owner: Owner, event: StoredEvent): Owner {
  const domainEvent = { type: event.eventType, data: event.payload };
  switch (owner.kind) {
    case "account":
      return { kind: owner.kind, state: evolveAccount(owner.state, domainEvent as AccountEvent) };
    case "shipping-address-book":
      return { kind: owner.kind, state: evolveShippingAddressBook(owner.state, domainEvent as ShippingAddressEvent) };
    case "consent":
      return { kind: owner.kind, state: evolveConsent(owner.state, domainEvent as ConsentEvent) };
    case "user":
      return { kind: owner.kind, state: evolveUser(owner.state, domainEvent as UserEvent) };
    case "api-key":
      return { kind: owner.kind, state: evolveApiKey(owner.state, domainEvent as ApiKeyEvent) };
    case "membership":
      return { kind: owner.kind, state: evolveMembership(owner.state, domainEvent as MembershipEvent) };
    case "invitation":
      return { kind: owner.kind, state: evolveInvitation(owner.state, domainEvent as InvitationEvent) };
  }
}
