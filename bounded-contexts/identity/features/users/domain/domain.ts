import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { UserId } from "@chase-sets/primitives/typed-ids";
import { resolveRecentAuthenticationStatus, type ResolvedActor } from "@chase-sets/auth-context";
import {
  isSocialLoginInstant,
  socialLoginLinkKey,
  SocialLoginUnlinkRefusal,
  type SocialLoginLinkState,
} from "./social-login-link";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  normalizeEmail,
  normalizeLabel,
  normalizePhoneNumber,
  toSortedUniqueList,
  type AuthMethodKey,
  type ContactMethod,
  type ContactMethodType,
  type EmptyEventData,
  type SocialLoginProviderKey,
  type UserStatus,
} from "../../../support/runtime-support/common";

export type SocialLoginLink = Readonly<{
  providerName: SocialLoginProviderKey;
  providerSubject: string;
  email: string;
  linkedAt: string;
  state?: SocialLoginLinkState;
  requestedAt?: string;
  revokedAt?: string;
}>;

export type UserState = Readonly<{
  id: UserId | null;
  displayName: string;
  givenName: string;
  familyName: string;
  status: UserStatus;
  primaryEmail: string | null;
  contactMethods: readonly ContactMethod[];
  authMethods: readonly AuthMethodKey[];
  passwordCredentialId: string | null;
  passkeyCredentialIds: readonly string[];
  socialLoginLinks: readonly SocialLoginLink[];
}>;

export const initialUserState: UserState = {
  id: null,
  displayName: "",
  givenName: "",
  familyName: "",
  status: "active",
  primaryEmail: null,
  contactMethods: [],
  authMethods: [],
  passwordCredentialId: null,
  passkeyCredentialIds: [],
  socialLoginLinks: [],
};

export type CreateUserCommand = Readonly<{
  type: "CreateUser";
  userId: UserId;
  displayName: string;
  givenName?: string;
  familyName?: string;
  primaryEmail?: string | null;
  primaryContactMethod?: Readonly<{
    contactMethodId?: string;
    type: ContactMethodType;
    value: string;
    verifiedAt?: string | null;
  }>;
}>;

export type UpdateUserProfileCommand = Readonly<{
  type: "UpdateUserProfile";
  displayName: string;
  givenName?: string;
  familyName?: string;
}>;

export type AddContactMethodCommand = Readonly<{
  type: "AddContactMethod";
  contactMethodId: string;
  contactMethodType: ContactMethodType;
  value: string;
}>;

export type VerifyContactMethodCommand = Readonly<{
  type: "VerifyContactMethod";
  contactMethodId: string;
  verifiedAt: string;
}>;

export type EnableAuthMethodCommand = Readonly<{
  type: "EnableAuthMethod";
  authMethod: AuthMethodKey;
}>;

export type DisableAuthMethodCommand = Readonly<{
  type: "DisableAuthMethod";
  authMethod: AuthMethodKey;
}>;

export type AttachPasswordCredentialCommand = Readonly<{
  type: "AttachPasswordCredential";
  credentialId: string;
}>;

export type RegisterPasskeyCredentialCommand = Readonly<{
  type: "RegisterPasskeyCredential";
  credentialId: string;
}>;

export type LinkSocialLoginCommand = Readonly<{
  type: "LinkSocialLogin";
  providerName: SocialLoginProviderKey;
  providerSubject: string;
  email: string;
  linkedAt: string;
}>;

export type SuspendUserCommand = Readonly<{ type: "SuspendUser" }>;
export type UnlinkSocialLoginCommand = Readonly<{
  type: "UnlinkSocialLogin";
  linkKey: string;
  authenticationMethod?: ResolvedActor["authenticationMethod"];
  authenticatedAt?: string | null;
}>;
export type ReactivateUserCommand = Readonly<{ type: "ReactivateUser" }>;

export type UserCommand =
  | CreateUserCommand
  | UpdateUserProfileCommand
  | AddContactMethodCommand
  | VerifyContactMethodCommand
  | EnableAuthMethodCommand
  | DisableAuthMethodCommand
  | AttachPasswordCredentialCommand
  | RegisterPasskeyCredentialCommand
  | LinkSocialLoginCommand
  | UnlinkSocialLoginCommand
  | SuspendUserCommand
  | ReactivateUserCommand;

type UserProfile = Readonly<{
  displayName: string;
  givenName: string;
  familyName: string;
  primaryEmail: string | null;
  primaryContactMethod: ContactMethod;
}>;

export type UserCreatedEvent = DomainEvent<"identity.user.created", Readonly<{ userId: UserId }> & UserProfile>;

export type UserProfileUpdatedEvent = DomainEvent<
  "identity.user.profile-updated",
  Readonly<{
    displayName: string;
    givenName: string;
    familyName: string;
  }>
>;

export type ContactMethodAddedEvent = DomainEvent<
  "identity.user.contact-method-added",
  Readonly<{
    contactMethodId: string;
    contactMethodType: ContactMethodType;
    value: string;
  }>
>;

export type ContactMethodVerifiedEvent = DomainEvent<
  "identity.user.contact-method-verified",
  Readonly<{
    contactMethodId: string;
    verifiedAt: string;
  }>
>;

export type AuthMethodEnabledEvent = DomainEvent<
  "identity.user.auth-method-enabled",
  Readonly<{
    authMethod: AuthMethodKey;
  }>
>;

export type AuthMethodDisabledEvent = DomainEvent<
  "identity.user.auth-method-disabled",
  Readonly<{
    authMethod: AuthMethodKey;
  }>
>;

export type PasswordCredentialAttachedEvent = DomainEvent<
  "identity.user.password-credential-attached",
  Readonly<{
    credentialId: string;
  }>
>;

export type PasskeyCredentialRegisteredEvent = DomainEvent<
  "identity.user.passkey-registered",
  Readonly<{
    credentialId: string;
  }>
>;

export type SocialLoginLinkedEvent = DomainEvent<
  "identity.user.social-login-linked",
  Pick<SocialLoginLink, "providerName" | "providerSubject" | "email" | "linkedAt">
>;
export type SocialLoginRevocationRequestedEvent = DomainEvent<
  "identity.user.social-login-revocation-requested",
  Readonly<{ providerName: SocialLoginProviderKey; linkKey: string; requestedAt: string }>
>;
export type SocialLoginRevokedEvent = DomainEvent<
  "identity.user.social-login-revoked",
  Readonly<{ providerName: SocialLoginProviderKey; linkKey: string; revokedAt: string }>
>;

export function assertUserSocialLoginEventSequence(
  state: UserState,
  event: Readonly<{ type: string; data: Readonly<Record<string, unknown>> }>,
  previous?: Readonly<{ type: string; data: Readonly<Record<string, unknown>> }>,
  next?: Readonly<{ type: string; data: Readonly<Record<string, unknown>> }>,
) {
  if (event.type === "identity.user.social-login-revocation-requested" && next)
    assert(
      next.type === "identity.user.social-login-revoked" &&
        next.data.linkKey === event.data.linkKey &&
        next.data.providerName === event.data.providerName,
      "INDETERMINATE",
    );
  if (event.type === "identity.user.social-login-revoked") {
    assert(
      previous?.type === "identity.user.social-login-revocation-requested" &&
        previous.data.linkKey === event.data.linkKey &&
        previous.data.providerName === event.data.providerName,
      "INDETERMINATE",
    );
    const anotherActiveLink = state.socialLoginLinks.some((link) => (link.state ?? "active") === "active");
    const disablesSocialLogin =
      next?.type === "identity.user.auth-method-disabled" && next.data.authMethod === "social-login";
    assert(anotherActiveLink !== disablesSocialLogin, "INDETERMINATE");
  }
}

export type UserSuspendedEvent = DomainEvent<"identity.user.suspended", EmptyEventData>;
export type UserReactivatedEvent = DomainEvent<"identity.user.reactivated", EmptyEventData>;

export type UserEvent =
  | UserCreatedEvent
  | UserProfileUpdatedEvent
  | ContactMethodAddedEvent
  | ContactMethodVerifiedEvent
  | AuthMethodEnabledEvent
  | AuthMethodDisabledEvent
  | PasswordCredentialAttachedEvent
  | PasskeyCredentialRegisteredEvent
  | SocialLoginLinkedEvent
  | SocialLoginRevocationRequestedEvent
  | SocialLoginRevokedEvent
  | UserSuspendedEvent
  | UserReactivatedEvent;

export const decideUser: AggregateDecider<UserState, UserCommand, UserEvent> = (state, command) => {
  switch (command.type) {
    case "CreateUser":
      assert(state.id === null, "User has already been created.");
      const primaryContactMethod = normalizePrimaryContactMethod(command);
      return [
        {
          type: "identity.user.created",
          data: {
            userId: command.userId,
            displayName: normalizeLabel(command.displayName),
            givenName: normalizeLabel(command.givenName ?? ""),
            familyName: normalizeLabel(command.familyName ?? ""),
            primaryEmail: primaryContactMethod.type === "email" ? primaryContactMethod.value : null,
            primaryContactMethod,
          },
        },
      ];
    case "UpdateUserProfile":
      requireCreatedUser(state);
      return [
        {
          type: "identity.user.profile-updated",
          data: {
            displayName: normalizeLabel(command.displayName),
            givenName: normalizeLabel(command.givenName ?? ""),
            familyName: normalizeLabel(command.familyName ?? ""),
          },
        },
      ];
    case "AddContactMethod":
      requireCreatedUser(state);
      assert(
        !state.contactMethods.some(
          (method) =>
            method.type === command.contactMethodType &&
            method.value === normalizeContactValue(command.contactMethodType, command.value),
        ),
        "Contact method already exists.",
      );
      return [
        {
          type: "identity.user.contact-method-added",
          data: {
            contactMethodId: command.contactMethodId,
            contactMethodType: command.contactMethodType,
            value: normalizeContactValue(command.contactMethodType, command.value),
          },
        },
      ];
    case "VerifyContactMethod":
      requireCreatedUser(state);
      assert(
        state.contactMethods.some((method) => method.contactMethodId === command.contactMethodId),
        "Contact method does not exist.",
      );
      return [
        {
          type: "identity.user.contact-method-verified",
          data: {
            contactMethodId: command.contactMethodId,
            verifiedAt: command.verifiedAt,
          },
        },
      ];
    case "EnableAuthMethod":
      requireCreatedUser(state);
      if (state.authMethods.includes(command.authMethod)) {
        return [];
      }
      return [
        {
          type: "identity.user.auth-method-enabled",
          data: { authMethod: command.authMethod },
        },
      ];
    case "DisableAuthMethod":
      requireCreatedUser(state);
      if (!state.authMethods.includes(command.authMethod)) {
        return [];
      }
      return [
        {
          type: "identity.user.auth-method-disabled",
          data: { authMethod: command.authMethod },
        },
      ];
    case "AttachPasswordCredential":
      requireCreatedUser(state);
      return [
        {
          type: "identity.user.password-credential-attached",
          data: { credentialId: command.credentialId },
        },
      ];
    case "RegisterPasskeyCredential":
      requireCreatedUser(state);
      assert(!state.passkeyCredentialIds.includes(command.credentialId), "Passkey has already been registered.");
      return [
        {
          type: "identity.user.passkey-registered",
          data: { credentialId: command.credentialId },
        },
      ];
    case "LinkSocialLogin": {
      requireCreatedUser(state);
      const providerSubject = normalizeLabel(command.providerSubject);
      assert(providerSubject.length > 0, "Social login subject is required.");
      if (
        state.socialLoginLinks.some(
          (link) => link.providerName === command.providerName && link.providerSubject === providerSubject,
        )
      ) {
        const existing = state.socialLoginLinks.find(
          (link) => link.providerName === command.providerName && link.providerSubject === providerSubject,
        )!;
        assert((existing.state ?? "active") === "active", "social_login_revoked");
        return [];
      }
      return [
        {
          type: "identity.user.social-login-linked",
          data: {
            providerName: command.providerName,
            providerSubject,
            email: normalizeEmail(command.email),
            linkedAt: command.linkedAt,
          },
        },
      ];
    }
    case "UnlinkSocialLogin": {
      requireCreatedUser(state);
      const target = state.socialLoginLinks.find(
        (link) => socialLoginLinkKey(link.providerName, link.providerSubject) === command.linkKey,
      );
      if (!target || (target.state ?? "active") !== "active")
        throw new SocialLoginUnlinkRefusal("social-login-link-not-active");
      const now = new Date();
      if (
        !isSocialLoginInstant(command.authenticatedAt) ||
        !resolveRecentAuthenticationStatus(command, { maxAgeMinutes: 15, now }).recentlyAuthenticated
      )
        throw new SocialLoginUnlinkRefusal("recent-authentication-required");
      const activeLinks = state.socialLoginLinks.filter((link) => (link.state ?? "active") === "active");
      const otherMethods = state.authMethods.filter((method) => method !== "social-login");
      if (!otherMethods.length && !activeLinks.some((link) => link !== target))
        throw new SocialLoginUnlinkRefusal("last-authentication-method");
      const method = command.authenticationMethod;
      if (
        !method ||
        method === target.providerName ||
        !(method === "google" || method === "facebook"
          ? activeLinks.some((link) => link.providerName === method)
          : otherMethods.includes(method))
      )
        throw new SocialLoginUnlinkRefusal("authentication-method-not-different");
      const at = now.toISOString();
      return [
        {
          type: "identity.user.social-login-revocation-requested",
          data: { providerName: target.providerName, linkKey: command.linkKey, requestedAt: at },
        },
        {
          type: "identity.user.social-login-revoked",
          data: { providerName: target.providerName, linkKey: command.linkKey, revokedAt: at },
        },
        ...(activeLinks.length === 1
          ? [{ type: "identity.user.auth-method-disabled" as const, data: { authMethod: "social-login" as const } }]
          : []),
      ];
    }
    case "SuspendUser":
      requireCreatedUser(state);
      assert(state.status === "active", "Only active users can be suspended.");
      return [{ type: "identity.user.suspended", data: EMPTY_EVENT_DATA }];
    case "ReactivateUser":
      requireCreatedUser(state);
      assert(state.status === "suspended", "Only suspended users can be reactivated.");
      return [{ type: "identity.user.reactivated", data: EMPTY_EVENT_DATA }];
    default:
      return assertNever(command);
  }
};

export const evolveUser: AggregateEvolver<UserState, UserEvent> = (state, event) => {
  switch (event.type) {
    case "identity.user.created":
      const primaryContactMethod = event.data.primaryContactMethod ?? {
        contactMethodId: `${event.data.userId}-primary-email`,
        type: "email" as const,
        value: event.data.primaryEmail ?? "",
        verifiedAt: null,
      };
      return {
        id: event.data.userId,
        displayName: event.data.displayName,
        givenName: event.data.givenName,
        familyName: event.data.familyName,
        status: "active",
        primaryEmail: event.data.primaryEmail,
        contactMethods: primaryContactMethod.value ? [primaryContactMethod] : [],
        authMethods: [],
        passwordCredentialId: null,
        passkeyCredentialIds: [],
        socialLoginLinks: [],
      };
    case "identity.user.profile-updated":
      return {
        ...state,
        displayName: event.data.displayName,
        givenName: event.data.givenName,
        familyName: event.data.familyName,
      };
    case "identity.user.contact-method-added":
      return {
        ...state,
        contactMethods: [
          ...state.contactMethods,
          {
            contactMethodId: event.data.contactMethodId,
            type: event.data.contactMethodType,
            value: event.data.value,
            verifiedAt: null,
          },
        ],
      };
    case "identity.user.contact-method-verified":
      return {
        ...state,
        contactMethods: state.contactMethods.map((method) =>
          method.contactMethodId === event.data.contactMethodId
            ? { ...method, verifiedAt: event.data.verifiedAt }
            : method,
        ),
      };
    case "identity.user.auth-method-enabled":
      return {
        ...state,
        authMethods: toSortedUniqueList([...state.authMethods, event.data.authMethod]),
      };
    case "identity.user.auth-method-disabled":
      return {
        ...state,
        authMethods: state.authMethods.filter((authMethod) => authMethod !== event.data.authMethod),
      };
    case "identity.user.password-credential-attached":
      return {
        ...state,
        passwordCredentialId: event.data.credentialId,
      };
    case "identity.user.passkey-registered":
      return {
        ...state,
        passkeyCredentialIds: toSortedUniqueList([...state.passkeyCredentialIds, event.data.credentialId]),
      };
    case "identity.user.social-login-linked": {
      const link = event.data;
      assert(
        Object.keys(link).every((key) => ["providerName", "providerSubject", "email", "linkedAt"].includes(key)) &&
          ["google", "facebook"].includes(link.providerName) &&
          typeof link.providerSubject === "string" &&
          link.providerSubject.length > 0 &&
          link.providerSubject.length <= 512 &&
          typeof link.email === "string" &&
          link.email.length <= 320 &&
          isSocialLoginInstant(link.linkedAt),
        "INDETERMINATE",
      );
      const existing = state.socialLoginLinks.find(
        (candidate) =>
          socialLoginLinkKey(candidate.providerName, candidate.providerSubject) ===
          socialLoginLinkKey(link.providerName, link.providerSubject),
      );
      if (existing) {
        assert(existing.linkedAt === link.linkedAt && existing.email === link.email, "INDETERMINATE");
        return state;
      }
      return {
        ...state,
        socialLoginLinks: [
          ...state.socialLoginLinks,
          {
            providerName: event.data.providerName,
            providerSubject: event.data.providerSubject,
            email: event.data.email,
            linkedAt: event.data.linkedAt,
            state: "active",
          },
        ].sort((left, right) =>
          `${left.providerName}:${left.providerSubject}`.localeCompare(
            `${right.providerName}:${right.providerSubject}`,
          ),
        ),
      };
    }
    case "identity.user.social-login-revocation-requested":
    case "identity.user.social-login-revoked": {
      const requested = event.type === "identity.user.social-login-revocation-requested";
      const data = event.data;
      const at = requested
        ? (event as SocialLoginRevocationRequestedEvent).data.requestedAt
        : (event as SocialLoginRevokedEvent).data.revokedAt;
      assert(
        Object.keys(data).length === 3 &&
          Object.keys(data).every((key) =>
            ["providerName", "linkKey", requested ? "requestedAt" : "revokedAt"].includes(key),
          ) &&
          /^[a-f0-9]{64}$/.test(data.linkKey) &&
          isSocialLoginInstant(at),
        "INDETERMINATE",
      );
      const target = state.socialLoginLinks.find(
        (link) =>
          link.providerName === data.providerName &&
          socialLoginLinkKey(link.providerName, link.providerSubject) === data.linkKey,
      );
      assert(
        !!target &&
          (target.state ?? "active") === (requested ? "active" : "revocation-requested") &&
          Date.parse(at) >= Date.parse(requested ? target.linkedAt : target.requestedAt!),
        "INDETERMINATE",
      );
      return {
        ...state,
        socialLoginLinks: state.socialLoginLinks.map((link) =>
          link !== target
            ? link
            : {
                ...link,
                state: requested ? "revocation-requested" : "revoked",
                ...(requested ? { requestedAt: at } : { revokedAt: at }),
              },
        ),
      };
    }
    case "identity.user.suspended":
      return { ...state, status: "suspended" };
    case "identity.user.reactivated":
      return { ...state, status: "active" };
    default:
      return assertNever(event);
  }
};

function normalizeContactValue(contactMethodType: ContactMethodType, value: string): string {
  if (contactMethodType === "email") {
    return normalizeEmail(value);
  }
  if (contactMethodType === "phone") {
    return normalizePhoneNumber(value);
  }
  return normalizeLabel(value);
}

function normalizePrimaryContactMethod(command: CreateUserCommand): ContactMethod {
  const method = command.primaryContactMethod ?? {
    contactMethodId: `${command.userId}-primary-email`,
    type: "email" as const,
    value: command.primaryEmail ?? "",
    verifiedAt: null,
  };
  const value = normalizeContactValue(method.type, method.value);
  assert(value.length > 0, "Primary contact method is required.");

  return {
    contactMethodId: method.contactMethodId ?? `${command.userId}-primary-${method.type}`,
    type: method.type,
    value,
    verifiedAt: method.verifiedAt ?? null,
  };
}

function requireCreatedUser(state: UserState) {
  assert(state.id !== null, "User must be created first.");
}
