import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { UserId } from "@chase-sets/primitives/typed-ids";
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
export type ReactivateUserCommand = Readonly<{ type: "ReactivateUser" }>;

export type UserCommand =
  | CreateUserCommand
  | UpdateUserProfileCommand
  | AddContactMethodCommand
  | VerifyContactMethodCommand
  | EnableAuthMethodCommand
  | AttachPasswordCredentialCommand
  | RegisterPasskeyCredentialCommand
  | LinkSocialLoginCommand
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

export type SocialLoginLinkedEvent = DomainEvent<"identity.user.social-login-linked", SocialLoginLink>;

export type UserSuspendedEvent = DomainEvent<"identity.user.suspended", EmptyEventData>;
export type UserReactivatedEvent = DomainEvent<"identity.user.reactivated", EmptyEventData>;

export type UserEvent =
  | UserCreatedEvent
  | UserProfileUpdatedEvent
  | ContactMethodAddedEvent
  | ContactMethodVerifiedEvent
  | AuthMethodEnabledEvent
  | PasswordCredentialAttachedEvent
  | PasskeyCredentialRegisteredEvent
  | SocialLoginLinkedEvent
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
    case "identity.user.social-login-linked":
      return {
        ...state,
        socialLoginLinks: [
          ...state.socialLoginLinks,
          {
            providerName: event.data.providerName,
            providerSubject: event.data.providerSubject,
            email: event.data.email,
            linkedAt: event.data.linkedAt,
          },
        ].sort((left, right) =>
          `${left.providerName}:${left.providerSubject}`.localeCompare(
            `${right.providerName}:${right.providerSubject}`,
          ),
        ),
      };
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
