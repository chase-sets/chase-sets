import { DomainEvent } from "../../packages/events/domainEvent";
import {
  AccountId,
  ApiKeyId,
  AuthenticationMethodId,
  ConsentId,
  ContactMethodId,
  CredentialId,
  InvitationId,
  MembershipId,
  OrganizationId,
  RoleId,
  SessionId,
  VerificationId,
} from "../../packages/primatives/ids";

export const IDENTITY_AGGREGATE_TYPES = [
  "account",
  "organization",
  "membership",
  "role",
  "invitation",
  "consent",
  "contact_method",
  "verification",
  "credential",
  "authentication_method",
  "session",
  "api_key",
] as const;

export type IdentityAggregateType = (typeof IDENTITY_AGGREGATE_TYPES)[number];

export type AccountKind = "human" | "automation" | "guest";
export type AccountStatus = "active" | "suspended" | "deactivated";

export type OrganizationStatus = "active" | "suspended" | "deactivated";

export type MembershipStatus = "pending" | "active" | "suspended" | "removed";

export type ContactMethodKind = "email" | "phone";
export type VerificationChannel = "email" | "sms" | "voice" | "link";

export type ConsentSubjectType = "account" | "organization";

export type VerificationSubjectType = "contact_method" | "identity_attribute";

export type CredentialKind =
  | "password_hash"
  | "passkey"
  | "oauth_token_reference"
  | "api_key_secret_reference";

export type AuthenticationMethodKind =
  | "password"
  | "passkey"
  | "google_login"
  | "magic_link";

export const IDENTITY_EVENT_DEFINITIONS = {
  "identity.account.created.v1": { aggregate: "account" },
  "identity.account.converted_from_guest.v1": { aggregate: "account" },
  "identity.account.status_changed.v1": { aggregate: "account" },
  "identity.account.profile_updated.v1": { aggregate: "account" },

  "identity.organization.created.v1": { aggregate: "organization" },
  "identity.organization.converted_from_personal.v1": { aggregate: "organization" },
  "identity.organization.status_changed.v1": { aggregate: "organization" },
  "identity.organization.profile_updated.v1": { aggregate: "organization" },

  "identity.membership.created.v1": { aggregate: "membership" },
  "identity.membership.role_changed.v1": { aggregate: "membership" },
  "identity.membership.status_changed.v1": { aggregate: "membership" },

  "identity.role.created.v1": { aggregate: "role" },
  "identity.role.renamed.v1": { aggregate: "role" },
  "identity.role.permission_granted.v1": { aggregate: "role" },
  "identity.role.permission_revoked.v1": { aggregate: "role" },
  "identity.role.archived.v1": { aggregate: "role" },
  "identity.role.restored.v1": { aggregate: "role" },

  "identity.invitation.created.v1": { aggregate: "invitation" },
  "identity.invitation.resent.v1": { aggregate: "invitation" },
  "identity.invitation.accepted.v1": { aggregate: "invitation" },
  "identity.invitation.declined.v1": { aggregate: "invitation" },
  "identity.invitation.revoked.v1": { aggregate: "invitation" },
  "identity.invitation.expired.v1": { aggregate: "invitation" },

  "identity.consent.recorded.v1": { aggregate: "consent" },
  "identity.consent.withdrawn.v1": { aggregate: "consent" },
  "identity.consent.superseded.v1": { aggregate: "consent" },

  "identity.contact_method.added.v1": { aggregate: "contact_method" },
  "identity.contact_method.primary_set.v1": { aggregate: "contact_method" },
  "identity.contact_method.verification_requested.v1": {
    aggregate: "contact_method",
  },
  "identity.contact_method.verified.v1": { aggregate: "contact_method" },
  "identity.contact_method.verification_failed.v1": { aggregate: "contact_method" },
  "identity.contact_method.removed.v1": { aggregate: "contact_method" },

  "identity.verification.requested.v1": { aggregate: "verification" },
  "identity.verification.evidence_submitted.v1": { aggregate: "verification" },
  "identity.verification.completed.v1": { aggregate: "verification" },
  "identity.verification.failed.v1": { aggregate: "verification" },
  "identity.verification.expired.v1": { aggregate: "verification" },
  "identity.verification.revoked.v1": { aggregate: "verification" },

  "identity.credential.created.v1": { aggregate: "credential" },
  "identity.credential.rotated.v1": { aggregate: "credential" },
  "identity.credential.revoked.v1": { aggregate: "credential" },
  "identity.credential.compromise_reported.v1": { aggregate: "credential" },

  "identity.authentication_method.enabled.v1": { aggregate: "authentication_method" },
  "identity.authentication_method.disabled.v1": { aggregate: "authentication_method" },
  "identity.authentication_method.primary_set.v1": { aggregate: "authentication_method" },
  "identity.authentication_method.challenge_policy_changed.v1": {
    aggregate: "authentication_method",
  },

  "identity.session.started.v1": { aggregate: "session" },
  "identity.session.refreshed.v1": { aggregate: "session" },
  "identity.session.revoked.v1": { aggregate: "session" },
  "identity.session.expired.v1": { aggregate: "session" },

  "identity.api_key.created.v1": { aggregate: "api_key" },
  "identity.api_key.scopes_updated.v1": { aggregate: "api_key" },
  "identity.api_key.rotated.v1": { aggregate: "api_key" },
  "identity.api_key.expiration_updated.v1": { aggregate: "api_key" },
  "identity.api_key.revoked.v1": { aggregate: "api_key" },
} as const satisfies Record<string, { aggregate: IdentityAggregateType }>;

export type IdentityEventType = keyof typeof IDENTITY_EVENT_DEFINITIONS;

export type EmptyData = Record<string, never>;

export type IdentityEventDataMap = {
  "identity.account.created.v1": {
    accountKind: AccountKind;
  };
  "identity.account.converted_from_guest.v1": EmptyData;
  "identity.account.status_changed.v1": {
    from: AccountStatus;
    to: AccountStatus;
    reason: string;
  };
  "identity.account.profile_updated.v1": {
    displayName?: string;
    avatarUrl?: string;
    publicBio?: string;
  };

  "identity.organization.created.v1": {
    isPersonal: boolean;
  };
  "identity.organization.converted_from_personal.v1": EmptyData;
  "identity.organization.status_changed.v1": {
    from: OrganizationStatus;
    to: OrganizationStatus;
    reason: string;
  };
  "identity.organization.profile_updated.v1": {
    storeName?: string;
    avatarUrl?: string;
    publicBio?: string;
  };

  "identity.membership.created.v1": {
    accountId: AccountId;
    organizationId: OrganizationId;
    roleId: RoleId;
    status: "pending" | "active";
  };
  "identity.membership.role_changed.v1": {
    fromRoleId: RoleId;
    toRoleId: RoleId;
  };
  "identity.membership.status_changed.v1": {
    from: MembershipStatus;
    to: MembershipStatus;
    reason: string;
  };

  "identity.role.created.v1": {
    organizationId: OrganizationId;
    name: string;
  };
  "identity.role.renamed.v1": {
    fromName: string;
    toName: string;
  };
  "identity.role.permission_granted.v1": {
    permission: string;
  };
  "identity.role.permission_revoked.v1": {
    permission: string;
  };
  "identity.role.archived.v1": {
    reason: string;
  };
  "identity.role.restored.v1": EmptyData;

  "identity.invitation.created.v1": {
    organizationId: OrganizationId;
    invitedEmail: string;
    roleId: RoleId;
    expiresAt: string;
  };
  "identity.invitation.resent.v1": {
    expiresAt: string;
  };
  "identity.invitation.accepted.v1": {
    acceptedByAccountId: AccountId;
    membershipId: MembershipId;
  };
  "identity.invitation.declined.v1": {
    declinedByAccountId: AccountId;
  };
  "identity.invitation.revoked.v1": {
    reason: string;
  };
  "identity.invitation.expired.v1": EmptyData;

  "identity.consent.recorded.v1": {
    subjectType: ConsentSubjectType;
    subjectId: string;
    policyType: string;
    policyVersion: string;
    acceptedAt: string;
  };
  "identity.consent.withdrawn.v1": {
    withdrawnAt: string;
    reason: string;
  };
  "identity.consent.superseded.v1": {
    supersededByConsentId: ConsentId;
  };

  "identity.contact_method.added.v1": {
    accountId: AccountId;
    type: ContactMethodKind;
    normalizedValue: string;
    isPrimary: boolean;
  };
  "identity.contact_method.primary_set.v1": EmptyData;
  "identity.contact_method.verification_requested.v1": {
    verificationId: VerificationId;
    channel: VerificationChannel;
  };
  "identity.contact_method.verified.v1": {
    verifiedAt: string;
    method: string;
  };
  "identity.contact_method.verification_failed.v1": {
    reason: string;
  };
  "identity.contact_method.removed.v1": EmptyData;

  "identity.verification.requested.v1": {
    subjectType: VerificationSubjectType;
    subjectId: string;
    verificationType: string;
  };
  "identity.verification.evidence_submitted.v1": {
    evidenceRef: string;
  };
  "identity.verification.completed.v1": {
    completedAt: string;
  };
  "identity.verification.failed.v1": {
    reason: string;
  };
  "identity.verification.expired.v1": EmptyData;
  "identity.verification.revoked.v1": {
    reason: string;
  };

  "identity.credential.created.v1": {
    accountId: AccountId;
    kind: CredentialKind;
    authenticationMethodId?: AuthenticationMethodId;
  };
  "identity.credential.rotated.v1": {
    replacedCredentialId?: CredentialId;
  };
  "identity.credential.revoked.v1": {
    reason: string;
  };
  "identity.credential.compromise_reported.v1": {
    source: string;
  };

  "identity.authentication_method.enabled.v1": {
    accountId: AccountId;
    method: AuthenticationMethodKind;
    credentialId?: CredentialId;
  };
  "identity.authentication_method.disabled.v1": {
    reason: string;
  };
  "identity.authentication_method.primary_set.v1": EmptyData;
  "identity.authentication_method.challenge_policy_changed.v1": {
    requiresStepUp: boolean;
  };

  "identity.session.started.v1": {
    accountId: AccountId;
    organizationId: OrganizationId;
    authenticationMethodId: AuthenticationMethodId;
    issuedAt: string;
    expiresAt: string;
    clientFingerprint: string;
  };
  "identity.session.refreshed.v1": {
    expiresAt: string;
  };
  "identity.session.revoked.v1": {
    reason: string;
  };
  "identity.session.expired.v1": EmptyData;

  "identity.api_key.created.v1": {
    accountId: AccountId;
    label: string;
    scopes: string[];
    credentialId: CredentialId;
    expiresAt?: string;
  };
  "identity.api_key.scopes_updated.v1": {
    scopes: string[];
  };
  "identity.api_key.rotated.v1": {
    credentialId: CredentialId;
  };
  "identity.api_key.expiration_updated.v1": {
    expiresAt?: string;
  };
  "identity.api_key.revoked.v1": {
    reason: string;
  };
};

export type IdentityEventAggregateByType = {
  [TType in IdentityEventType]: (typeof IDENTITY_EVENT_DEFINITIONS)[TType]["aggregate"];
};

export type IdentityAggregateIdMap = {
  account: AccountId;
  organization: OrganizationId;
  membership: MembershipId;
  role: RoleId;
  invitation: InvitationId;
  consent: ConsentId;
  contact_method: ContactMethodId;
  verification: VerificationId;
  credential: CredentialId;
  authentication_method: AuthenticationMethodId;
  session: SessionId;
  api_key: ApiKeyId;
};

export type IdentityEvent<TType extends IdentityEventType = IdentityEventType> =
  TType extends IdentityEventType
    ? DomainEvent<
        IdentityEventAggregateByType[TType],
        IdentityAggregateIdMap[IdentityEventAggregateByType[TType]],
        IdentityEventDataMap[TType]
      > & {
        type: TType;
        aggregate: {
          type: IdentityEventAggregateByType[TType];
          id: IdentityAggregateIdMap[IdentityEventAggregateByType[TType]];
        };
      }
    : never;

export type IdentityEventTypeForAggregate<TAggregate extends IdentityAggregateType> = {
  [TType in IdentityEventType]: IdentityEventAggregateByType[TType] extends TAggregate
    ? TType
    : never;
}[IdentityEventType];

export type IdentityEventForAggregate<TAggregate extends IdentityAggregateType> =
  IdentityEvent<IdentityEventTypeForAggregate<TAggregate>>;

export type IdentityFlowStep = IdentityEventType | readonly IdentityEventType[];

export type IdentityEventFlow = {
  name: string;
  happyPath: readonly IdentityFlowStep[];
  alternatives?: readonly (readonly IdentityFlowStep[])[];
};

export const IDENTITY_EVENT_FLOWS: readonly IdentityEventFlow[] = [
  {
    name: "account_onboarding",
    happyPath: [
      "identity.account.created.v1",
      "identity.organization.created.v1",
      "identity.membership.created.v1",
      "identity.consent.recorded.v1",
    ],
  },
  {
    name: "guest_conversion",
    happyPath: [
      "identity.account.created.v1",
      "identity.account.converted_from_guest.v1",
    ],
  },
  {
    name: "staff_invitation",
    happyPath: [
      "identity.invitation.created.v1",
      "identity.invitation.accepted.v1",
      "identity.membership.created.v1",
    ],
    alternatives: [
      ["identity.invitation.created.v1", "identity.invitation.declined.v1"],
      ["identity.invitation.created.v1", "identity.invitation.revoked.v1"],
      ["identity.invitation.created.v1", "identity.invitation.expired.v1"],
    ],
  },
  {
    name: "role_administration",
    happyPath: [
      "identity.role.created.v1",
      "identity.role.permission_granted.v1",
      "identity.membership.role_changed.v1",
    ],
    alternatives: [
      [
        "identity.role.created.v1",
        "identity.role.permission_revoked.v1",
        "identity.membership.role_changed.v1",
      ],
    ],
  },
  {
    name: "contact_verification",
    happyPath: [
      "identity.contact_method.added.v1",
      "identity.contact_method.verification_requested.v1",
      "identity.verification.requested.v1",
      "identity.verification.completed.v1",
      "identity.contact_method.verified.v1",
    ],
  },
  {
    name: "interactive_auth_session",
    happyPath: [
      [
        "identity.authentication_method.enabled.v1",
        "identity.credential.created.v1",
      ],
      "identity.session.started.v1",
      "identity.session.refreshed.v1",
      "identity.session.revoked.v1",
    ],
    alternatives: [
      [
        ["identity.authentication_method.enabled.v1", "identity.credential.created.v1"],
        "identity.session.started.v1",
        "identity.session.expired.v1",
      ],
    ],
  },
  {
    name: "api_key_lifecycle",
    happyPath: [
      "identity.credential.created.v1",
      "identity.api_key.created.v1",
      ["identity.api_key.rotated.v1", "identity.credential.rotated.v1"],
      "identity.api_key.revoked.v1",
    ],
  },
] as const;

export const IDENTITY_EVENT_TYPE_PATTERN = /^identity\.[a-z_]+\.[a-z_]+\.v[1-9]\d*$/;

const identityAggregateTypeSet = new Set<string>(IDENTITY_AGGREGATE_TYPES);
const identityEventTypeSet = new Set<string>(Object.keys(IDENTITY_EVENT_DEFINITIONS));

export const isIdentityAggregateType = (value: string): value is IdentityAggregateType =>
  identityAggregateTypeSet.has(value);

export const isIdentityEventType = (value: string): value is IdentityEventType =>
  identityEventTypeSet.has(value);

export const getIdentityAggregateForEventType = (
  eventType: IdentityEventType
): IdentityEventAggregateByType[IdentityEventType] =>
  IDENTITY_EVENT_DEFINITIONS[eventType].aggregate;

export const isEventTypeForAggregate = (
  eventType: IdentityEventType,
  aggregateType: IdentityAggregateType
): boolean => IDENTITY_EVENT_DEFINITIONS[eventType].aggregate === aggregateType;

type CompileTimeAssert<T extends true> = T;

type AllEventsHaveData = CompileTimeAssert<
  Exclude<IdentityEventType, keyof IdentityEventDataMap> extends never ? true : false
>;

type NoOrphanDataTypes = CompileTimeAssert<
  Exclude<keyof IdentityEventDataMap, IdentityEventType> extends never ? true : false
>;
