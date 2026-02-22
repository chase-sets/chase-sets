import { AccountId, OrganizationId } from "../../packages/primatives/ids";
import {
  AccountKind,
  AccountStatus,
  AuthenticationMethodKind,
  ContactMethodKind,
  CredentialKind,
  IdentityAggregateIdMap,
  IdentityAggregateType,
  IdentityEventForAggregate,
  MembershipStatus,
  OrganizationStatus,
  VerificationSubjectType,
} from "./events";

export class IdentityInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityInvariantError";
  }
}

function assertInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new IdentityInvariantError(message);
  }
}

type RehydrateApply<TAggregate extends IdentityAggregateType, TState> = (
  state: TState,
  event: IdentityEventForAggregate<TAggregate>
) => TState;

const rehydrateAggregate = <TAggregate extends IdentityAggregateType, TState>(
  aggregateType: TAggregate,
  aggregateId: IdentityAggregateIdMap[TAggregate],
  events: readonly IdentityEventForAggregate<TAggregate>[],
  initialState: TState,
  apply: RehydrateApply<TAggregate, TState>
): TState => {
  let state = initialState;

  for (const event of events) {
    assertInvariant(
      event.aggregate.type === aggregateType,
      `Expected aggregate type '${aggregateType}' but received '${event.aggregate.type}'.`
    );

    assertInvariant(
      event.aggregate.id === aggregateId,
      `Expected aggregate id '${aggregateId}' but received '${event.aggregate.id}'.`
    );

    state = apply(state, event);
  }

  return state;
};

export type AccountProfile = {
  displayName?: string;
  avatarUrl?: string;
  publicBio?: string;
};

export type AccountState = {
  id: IdentityAggregateIdMap["account"];
  exists: boolean;
  kind?: AccountKind;
  status?: AccountStatus;
  convertedFromGuest: boolean;
  profile: AccountProfile;
};

export const createAccountState = (
  id: IdentityAggregateIdMap["account"]
): AccountState => ({
  id,
  exists: false,
  convertedFromGuest: false,
  profile: {},
});

export const applyAccountEvent = (
  state: AccountState,
  event: IdentityEventForAggregate<"account">
): AccountState => {
  switch (event.type) {
    case "identity.account.created.v1":
      assertInvariant(!state.exists, "AccountCreated requires a non-existent account.");
      return {
        ...state,
        exists: true,
        kind: event.data.accountKind,
        status: "active",
      };

    case "identity.account.converted_from_guest.v1":
      assertInvariant(state.exists, "Guest conversion requires an existing account.");
      assertInvariant(
        state.kind === "guest",
        "Guest conversion requires account kind to be 'guest'."
      );
      return {
        ...state,
        kind: "human",
        convertedFromGuest: true,
      };

    case "identity.account.status_changed.v1":
      assertInvariant(state.exists, "Status changes require an existing account.");
      assertInvariant(
        state.status === event.data.from,
        `Account status mismatch: expected '${state.status}', event from '${event.data.from}'.`
      );
      return {
        ...state,
        status: event.data.to,
      };

    case "identity.account.profile_updated.v1":
      assertInvariant(state.exists, "Profile updates require an existing account.");
      return {
        ...state,
        profile: {
          ...state.profile,
          ...event.data,
        },
      };
  }
};

export const rehydrateAccount = (
  accountId: IdentityAggregateIdMap["account"],
  events: readonly IdentityEventForAggregate<"account">[]
): AccountState =>
  rehydrateAggregate("account", accountId, events, createAccountState(accountId), applyAccountEvent);

export type OrganizationProfile = {
  storeName?: string;
  avatarUrl?: string;
  publicBio?: string;
};

export type OrganizationState = {
  id: IdentityAggregateIdMap["organization"];
  exists: boolean;
  isPersonal?: boolean;
  status?: OrganizationStatus;
  convertedFromPersonal: boolean;
  profile: OrganizationProfile;
};

export const createOrganizationState = (
  id: IdentityAggregateIdMap["organization"]
): OrganizationState => ({
  id,
  exists: false,
  convertedFromPersonal: false,
  profile: {},
});

export const applyOrganizationEvent = (
  state: OrganizationState,
  event: IdentityEventForAggregate<"organization">
): OrganizationState => {
  switch (event.type) {
    case "identity.organization.created.v1":
      assertInvariant(
        !state.exists,
        "OrganizationCreated requires a non-existent organization."
      );
      return {
        ...state,
        exists: true,
        isPersonal: event.data.isPersonal,
        status: "active",
      };

    case "identity.organization.converted_from_personal.v1":
      assertInvariant(
        state.exists,
        "ConvertedFromPersonal requires an existing organization."
      );
      assertInvariant(
        state.isPersonal === true,
        "ConvertedFromPersonal requires the organization to be personal."
      );
      return {
        ...state,
        isPersonal: false,
        convertedFromPersonal: true,
      };

    case "identity.organization.status_changed.v1":
      assertInvariant(state.exists, "Status changes require an existing organization.");
      assertInvariant(
        state.status === event.data.from,
        `Organization status mismatch: expected '${state.status}', event from '${event.data.from}'.`
      );
      return {
        ...state,
        status: event.data.to,
      };

    case "identity.organization.profile_updated.v1":
      assertInvariant(state.exists, "Profile updates require an existing organization.");
      return {
        ...state,
        profile: {
          ...state.profile,
          ...event.data,
        },
      };
  }
};

export const rehydrateOrganization = (
  organizationId: IdentityAggregateIdMap["organization"],
  events: readonly IdentityEventForAggregate<"organization">[]
): OrganizationState =>
  rehydrateAggregate(
    "organization",
    organizationId,
    events,
    createOrganizationState(organizationId),
    applyOrganizationEvent
  );

export type MembershipState = {
  id: IdentityAggregateIdMap["membership"];
  exists: boolean;
  accountId?: AccountId;
  organizationId?: OrganizationId;
  roleId?: IdentityAggregateIdMap["role"];
  status?: MembershipStatus;
};

export const createMembershipState = (
  id: IdentityAggregateIdMap["membership"]
): MembershipState => ({
  id,
  exists: false,
});

export const applyMembershipEvent = (
  state: MembershipState,
  event: IdentityEventForAggregate<"membership">
): MembershipState => {
  switch (event.type) {
    case "identity.membership.created.v1":
      assertInvariant(
        !state.exists,
        "MembershipCreated requires a non-existent membership."
      );
      return {
        ...state,
        exists: true,
        accountId: event.data.accountId,
        organizationId: event.data.organizationId,
        roleId: event.data.roleId,
        status: event.data.status,
      };

    case "identity.membership.role_changed.v1":
      assertInvariant(state.exists, "Role changes require an existing membership.");
      assertInvariant(
        state.status !== "removed",
        "MembershipRoleChanged is invalid when membership status is 'removed'."
      );
      assertInvariant(
        state.roleId === event.data.fromRoleId,
        `Membership role mismatch: expected '${state.roleId}', event from '${event.data.fromRoleId}'.`
      );
      return {
        ...state,
        roleId: event.data.toRoleId,
      };

    case "identity.membership.status_changed.v1":
      assertInvariant(state.exists, "Status changes require an existing membership.");
      assertInvariant(
        state.status === event.data.from,
        `Membership status mismatch: expected '${state.status}', event from '${event.data.from}'.`
      );
      return {
        ...state,
        status: event.data.to,
      };
  }
};

export const rehydrateMembership = (
  membershipId: IdentityAggregateIdMap["membership"],
  events: readonly IdentityEventForAggregate<"membership">[]
): MembershipState =>
  rehydrateAggregate(
    "membership",
    membershipId,
    events,
    createMembershipState(membershipId),
    applyMembershipEvent
  );

export type RoleState = {
  id: IdentityAggregateIdMap["role"];
  exists: boolean;
  organizationId?: OrganizationId;
  name?: string;
  permissions: readonly string[];
  archived: boolean;
};

export const createRoleState = (id: IdentityAggregateIdMap["role"]): RoleState => ({
  id,
  exists: false,
  permissions: [],
  archived: false,
});

export const applyRoleEvent = (
  state: RoleState,
  event: IdentityEventForAggregate<"role">
): RoleState => {
  switch (event.type) {
    case "identity.role.created.v1":
      assertInvariant(!state.exists, "RoleCreated requires a non-existent role.");
      return {
        ...state,
        exists: true,
        organizationId: event.data.organizationId,
        name: event.data.name,
      };

    case "identity.role.renamed.v1":
      assertInvariant(state.exists, "RoleRenamed requires an existing role.");
      assertInvariant(
        state.name === event.data.fromName,
        `Role name mismatch: expected '${state.name}', event from '${event.data.fromName}'.`
      );
      return {
        ...state,
        name: event.data.toName,
      };

    case "identity.role.permission_granted.v1":
      assertInvariant(state.exists, "PermissionGranted requires an existing role.");
      return {
        ...state,
        permissions: state.permissions.includes(event.data.permission)
          ? state.permissions
          : [...state.permissions, event.data.permission],
      };

    case "identity.role.permission_revoked.v1":
      assertInvariant(state.exists, "PermissionRevoked requires an existing role.");
      return {
        ...state,
        permissions: state.permissions.filter(
          (permission) => permission !== event.data.permission
        ),
      };

    case "identity.role.archived.v1":
      assertInvariant(state.exists, "RoleArchived requires an existing role.");
      return {
        ...state,
        archived: true,
      };

    case "identity.role.restored.v1":
      assertInvariant(state.exists, "RoleRestored requires an existing role.");
      return {
        ...state,
        archived: false,
      };
  }
};

export const rehydrateRole = (
  roleId: IdentityAggregateIdMap["role"],
  events: readonly IdentityEventForAggregate<"role">[]
): RoleState =>
  rehydrateAggregate("role", roleId, events, createRoleState(roleId), applyRoleEvent);

export type InvitationStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "revoked"
  | "expired";

export type InvitationState = {
  id: IdentityAggregateIdMap["invitation"];
  exists: boolean;
  organizationId?: OrganizationId;
  invitedEmail?: string;
  roleId?: IdentityAggregateIdMap["role"];
  expiresAt?: string;
  status?: InvitationStatus;
  acceptedByAccountId?: AccountId;
  membershipId?: IdentityAggregateIdMap["membership"];
  declinedByAccountId?: AccountId;
  revokedReason?: string;
};

const INVITATION_TERMINAL_STATES: readonly InvitationStatus[] = [
  "accepted",
  "declined",
  "revoked",
  "expired",
];

export const createInvitationState = (
  id: IdentityAggregateIdMap["invitation"]
): InvitationState => ({
  id,
  exists: false,
});

export const applyInvitationEvent = (
  state: InvitationState,
  event: IdentityEventForAggregate<"invitation">
): InvitationState => {
  switch (event.type) {
    case "identity.invitation.created.v1":
      assertInvariant(
        !state.exists,
        "InvitationCreated requires a non-existent invitation."
      );
      return {
        ...state,
        exists: true,
        organizationId: event.data.organizationId,
        invitedEmail: event.data.invitedEmail,
        roleId: event.data.roleId,
        expiresAt: event.data.expiresAt,
        status: "pending",
      };

    case "identity.invitation.resent.v1":
      assertInvariant(state.exists, "InvitationResent requires an existing invitation.");
      assertInvariant(
        state.status === "pending",
        "InvitationResent is valid only when invitation status is 'pending'."
      );
      return {
        ...state,
        expiresAt: event.data.expiresAt,
      };

    case "identity.invitation.accepted.v1":
      assertInvariant(state.exists, "InvitationAccepted requires an existing invitation.");
      assertInvariant(
        state.status === "pending",
        "InvitationAccepted is invalid after invitation reached a terminal state."
      );
      return {
        ...state,
        status: "accepted",
        acceptedByAccountId: event.data.acceptedByAccountId,
        membershipId: event.data.membershipId,
      };

    case "identity.invitation.declined.v1":
      assertInvariant(state.exists, "InvitationDeclined requires an existing invitation.");
      assertInvariant(
        state.status === "pending",
        "InvitationDeclined is valid only when invitation status is 'pending'."
      );
      return {
        ...state,
        status: "declined",
        declinedByAccountId: event.data.declinedByAccountId,
      };

    case "identity.invitation.revoked.v1":
      assertInvariant(state.exists, "InvitationRevoked requires an existing invitation.");
      assertInvariant(
        state.status === "pending",
        "InvitationRevoked is valid only when invitation status is 'pending'."
      );
      return {
        ...state,
        status: "revoked",
        revokedReason: event.data.reason,
      };

    case "identity.invitation.expired.v1":
      assertInvariant(state.exists, "InvitationExpired requires an existing invitation.");
      assertInvariant(
        state.status === "pending",
        "InvitationExpired is valid only when invitation status is 'pending'."
      );
      return {
        ...state,
        status: "expired",
      };
  }
};

export const isInvitationTerminal = (
  status: InvitationStatus | undefined
): status is InvitationStatus => Boolean(status && INVITATION_TERMINAL_STATES.includes(status));

export const rehydrateInvitation = (
  invitationId: IdentityAggregateIdMap["invitation"],
  events: readonly IdentityEventForAggregate<"invitation">[]
): InvitationState =>
  rehydrateAggregate(
    "invitation",
    invitationId,
    events,
    createInvitationState(invitationId),
    applyInvitationEvent
  );

export type ConsentStatus = "active" | "withdrawn" | "superseded";

export type ConsentState = {
  id: IdentityAggregateIdMap["consent"];
  exists: boolean;
  subjectType?: "account" | "organization";
  subjectId?: string;
  policyType?: string;
  policyVersion?: string;
  acceptedAt?: string;
  status?: ConsentStatus;
  withdrawnAt?: string;
  withdrawnReason?: string;
  supersededByConsentId?: IdentityAggregateIdMap["consent"];
};

export const createConsentState = (
  id: IdentityAggregateIdMap["consent"]
): ConsentState => ({
  id,
  exists: false,
});

export const applyConsentEvent = (
  state: ConsentState,
  event: IdentityEventForAggregate<"consent">
): ConsentState => {
  switch (event.type) {
    case "identity.consent.recorded.v1":
      assertInvariant(!state.exists, "ConsentRecorded requires a new consent aggregate.");
      return {
        ...state,
        exists: true,
        subjectType: event.data.subjectType,
        subjectId: event.data.subjectId,
        policyType: event.data.policyType,
        policyVersion: event.data.policyVersion,
        acceptedAt: event.data.acceptedAt,
        status: "active",
      };

    case "identity.consent.withdrawn.v1":
      assertInvariant(state.exists, "ConsentWithdrawn requires existing consent.");
      assertInvariant(
        state.status === "active",
        "ConsentWithdrawn is valid only when consent status is 'active'."
      );
      return {
        ...state,
        status: "withdrawn",
        withdrawnAt: event.data.withdrawnAt,
        withdrawnReason: event.data.reason,
      };

    case "identity.consent.superseded.v1":
      assertInvariant(state.exists, "ConsentSuperseded requires existing consent.");
      assertInvariant(
        state.status === "active",
        "ConsentSuperseded is valid only when consent status is 'active'."
      );
      return {
        ...state,
        status: "superseded",
        supersededByConsentId: event.data.supersededByConsentId,
      };
  }
};

export const rehydrateConsent = (
  consentId: IdentityAggregateIdMap["consent"],
  events: readonly IdentityEventForAggregate<"consent">[]
): ConsentState =>
  rehydrateAggregate(
    "consent",
    consentId,
    events,
    createConsentState(consentId),
    applyConsentEvent
  );

export type ContactMethodVerificationStatus =
  | "unverified"
  | "verification_pending"
  | "verified"
  | "verification_failed";

export type ContactMethodState = {
  id: IdentityAggregateIdMap["contact_method"];
  exists: boolean;
  accountId?: AccountId;
  type?: ContactMethodKind;
  normalizedValue?: string;
  isPrimary?: boolean;
  verificationStatus: ContactMethodVerificationStatus;
  verificationId?: IdentityAggregateIdMap["verification"];
  lastVerificationMethod?: string;
  removed: boolean;
};

export const createContactMethodState = (
  id: IdentityAggregateIdMap["contact_method"]
): ContactMethodState => ({
  id,
  exists: false,
  verificationStatus: "unverified",
  removed: false,
});

export const applyContactMethodEvent = (
  state: ContactMethodState,
  event: IdentityEventForAggregate<"contact_method">
): ContactMethodState => {
  switch (event.type) {
    case "identity.contact_method.added.v1":
      assertInvariant(
        !state.exists,
        "ContactMethodAdded requires a non-existent contact method."
      );
      return {
        ...state,
        exists: true,
        accountId: event.data.accountId,
        type: event.data.type,
        normalizedValue: event.data.normalizedValue,
        isPrimary: event.data.isPrimary,
      };

    case "identity.contact_method.primary_set.v1":
      assertInvariant(state.exists, "PrimarySet requires existing contact method.");
      assertInvariant(!state.removed, "PrimarySet is invalid after contact method removal.");
      return {
        ...state,
        isPrimary: true,
      };

    case "identity.contact_method.verification_requested.v1":
      assertInvariant(
        state.exists,
        "VerificationRequested requires existing contact method."
      );
      assertInvariant(
        !state.removed,
        "VerificationRequested is invalid after contact method removal."
      );
      return {
        ...state,
        verificationStatus: "verification_pending",
        verificationId: event.data.verificationId,
      };

    case "identity.contact_method.verified.v1":
      assertInvariant(state.exists, "Verified requires existing contact method.");
      assertInvariant(!state.removed, "Verified is invalid after contact method removal.");
      return {
        ...state,
        verificationStatus: "verified",
        lastVerificationMethod: event.data.method,
      };

    case "identity.contact_method.verification_failed.v1":
      assertInvariant(
        state.exists,
        "VerificationFailed requires existing contact method."
      );
      assertInvariant(
        !state.removed,
        "VerificationFailed is invalid after contact method removal."
      );
      return {
        ...state,
        verificationStatus: "verification_failed",
      };

    case "identity.contact_method.removed.v1":
      assertInvariant(state.exists, "Removed requires existing contact method.");
      return {
        ...state,
        removed: true,
      };
  }
};

export const rehydrateContactMethod = (
  contactMethodId: IdentityAggregateIdMap["contact_method"],
  events: readonly IdentityEventForAggregate<"contact_method">[]
): ContactMethodState =>
  rehydrateAggregate(
    "contact_method",
    contactMethodId,
    events,
    createContactMethodState(contactMethodId),
    applyContactMethodEvent
  );

export type VerificationStatus =
  | "requested"
  | "completed"
  | "failed"
  | "expired"
  | "revoked";

export type VerificationState = {
  id: IdentityAggregateIdMap["verification"];
  exists: boolean;
  subjectType?: VerificationSubjectType;
  subjectId?: string;
  verificationType?: string;
  evidenceRef?: string;
  status?: VerificationStatus;
};

export const createVerificationState = (
  id: IdentityAggregateIdMap["verification"]
): VerificationState => ({
  id,
  exists: false,
});

export const applyVerificationEvent = (
  state: VerificationState,
  event: IdentityEventForAggregate<"verification">
): VerificationState => {
  switch (event.type) {
    case "identity.verification.requested.v1":
      assertInvariant(
        !state.exists,
        "VerificationRequested requires a new verification aggregate."
      );
      return {
        ...state,
        exists: true,
        subjectType: event.data.subjectType,
        subjectId: event.data.subjectId,
        verificationType: event.data.verificationType,
        status: "requested",
      };

    case "identity.verification.evidence_submitted.v1":
      assertInvariant(
        state.exists,
        "EvidenceSubmitted requires existing verification aggregate."
      );
      assertInvariant(
        state.status === "requested",
        "EvidenceSubmitted is valid only when verification status is 'requested'."
      );
      return {
        ...state,
        evidenceRef: event.data.evidenceRef,
      };

    case "identity.verification.completed.v1":
      assertInvariant(state.exists, "Completed requires existing verification aggregate.");
      assertInvariant(
        state.status === "requested",
        "Completed is valid only when verification status is 'requested'."
      );
      return {
        ...state,
        status: "completed",
      };

    case "identity.verification.failed.v1":
      assertInvariant(state.exists, "Failed requires existing verification aggregate.");
      assertInvariant(
        state.status === "requested",
        "Failed is valid only when verification status is 'requested'."
      );
      return {
        ...state,
        status: "failed",
      };

    case "identity.verification.expired.v1":
      assertInvariant(state.exists, "Expired requires existing verification aggregate.");
      assertInvariant(
        state.status === "requested",
        "Expired is valid only when verification status is 'requested'."
      );
      return {
        ...state,
        status: "expired",
      };

    case "identity.verification.revoked.v1":
      assertInvariant(state.exists, "Revoked requires existing verification aggregate.");
      assertInvariant(
        state.status === "requested",
        "Revoked is valid only when verification status is 'requested'."
      );
      return {
        ...state,
        status: "revoked",
      };
  }
};

export const rehydrateVerification = (
  verificationId: IdentityAggregateIdMap["verification"],
  events: readonly IdentityEventForAggregate<"verification">[]
): VerificationState =>
  rehydrateAggregate(
    "verification",
    verificationId,
    events,
    createVerificationState(verificationId),
    applyVerificationEvent
  );

export type CredentialStatus = "active" | "revoked" | "compromised";

export type CredentialState = {
  id: IdentityAggregateIdMap["credential"];
  exists: boolean;
  accountId?: AccountId;
  kind?: CredentialKind;
  authenticationMethodId?: IdentityAggregateIdMap["authentication_method"];
  status?: CredentialStatus;
  replacedCredentialId?: IdentityAggregateIdMap["credential"];
  revokedReason?: string;
  compromiseSource?: string;
};

export const createCredentialState = (
  id: IdentityAggregateIdMap["credential"]
): CredentialState => ({
  id,
  exists: false,
});

export const applyCredentialEvent = (
  state: CredentialState,
  event: IdentityEventForAggregate<"credential">
): CredentialState => {
  switch (event.type) {
    case "identity.credential.created.v1":
      assertInvariant(!state.exists, "CredentialCreated requires a new credential.");
      return {
        ...state,
        exists: true,
        accountId: event.data.accountId,
        kind: event.data.kind,
        authenticationMethodId: event.data.authenticationMethodId,
        status: "active",
      };

    case "identity.credential.rotated.v1":
      assertInvariant(state.exists, "CredentialRotated requires existing credential.");
      assertInvariant(
        state.status === "active",
        "CredentialRotated is valid only when credential status is 'active'."
      );
      return {
        ...state,
        replacedCredentialId: event.data.replacedCredentialId,
      };

    case "identity.credential.revoked.v1":
      assertInvariant(state.exists, "CredentialRevoked requires existing credential.");
      assertInvariant(
        state.status !== "revoked",
        "CredentialRevoked cannot be applied to an already revoked credential."
      );
      return {
        ...state,
        status: "revoked",
        revokedReason: event.data.reason,
      };

    case "identity.credential.compromise_reported.v1":
      assertInvariant(
        state.exists,
        "CredentialCompromiseReported requires existing credential."
      );
      return {
        ...state,
        status: "compromised",
        compromiseSource: event.data.source,
      };
  }
};

export const rehydrateCredential = (
  credentialId: IdentityAggregateIdMap["credential"],
  events: readonly IdentityEventForAggregate<"credential">[]
): CredentialState =>
  rehydrateAggregate(
    "credential",
    credentialId,
    events,
    createCredentialState(credentialId),
    applyCredentialEvent
  );

export type AuthenticationMethodState = {
  id: IdentityAggregateIdMap["authentication_method"];
  exists: boolean;
  accountId?: AccountId;
  method?: AuthenticationMethodKind;
  credentialId?: IdentityAggregateIdMap["credential"];
  enabled: boolean;
  isPrimary: boolean;
  requiresStepUp: boolean;
  disabledReason?: string;
};

export const createAuthenticationMethodState = (
  id: IdentityAggregateIdMap["authentication_method"]
): AuthenticationMethodState => ({
  id,
  exists: false,
  enabled: false,
  isPrimary: false,
  requiresStepUp: false,
});

export const applyAuthenticationMethodEvent = (
  state: AuthenticationMethodState,
  event: IdentityEventForAggregate<"authentication_method">
): AuthenticationMethodState => {
  switch (event.type) {
    case "identity.authentication_method.enabled.v1":
      assertInvariant(
        !state.exists || state.enabled === false,
        "AuthenticationMethodEnabled requires a new or disabled method."
      );
      return {
        ...state,
        exists: true,
        accountId: event.data.accountId,
        method: event.data.method,
        credentialId: event.data.credentialId,
        enabled: true,
        disabledReason: undefined,
      };

    case "identity.authentication_method.disabled.v1":
      assertInvariant(state.exists, "AuthenticationMethodDisabled requires existing method.");
      assertInvariant(
        state.enabled,
        "AuthenticationMethodDisabled requires method to be enabled."
      );
      return {
        ...state,
        enabled: false,
        disabledReason: event.data.reason,
      };

    case "identity.authentication_method.primary_set.v1":
      assertInvariant(
        state.exists,
        "AuthenticationMethodPrimarySet requires existing method."
      );
      assertInvariant(
        state.enabled,
        "AuthenticationMethodPrimarySet requires method to be enabled."
      );
      return {
        ...state,
        isPrimary: true,
      };

    case "identity.authentication_method.challenge_policy_changed.v1":
      assertInvariant(
        state.exists,
        "ChallengePolicyChanged requires existing authentication method."
      );
      return {
        ...state,
        requiresStepUp: event.data.requiresStepUp,
      };
  }
};

export const rehydrateAuthenticationMethod = (
  authenticationMethodId: IdentityAggregateIdMap["authentication_method"],
  events: readonly IdentityEventForAggregate<"authentication_method">[]
): AuthenticationMethodState =>
  rehydrateAggregate(
    "authentication_method",
    authenticationMethodId,
    events,
    createAuthenticationMethodState(authenticationMethodId),
    applyAuthenticationMethodEvent
  );

export type SessionStatus = "active" | "revoked" | "expired";

export type SessionState = {
  id: IdentityAggregateIdMap["session"];
  exists: boolean;
  accountId?: AccountId;
  organizationId?: OrganizationId;
  authenticationMethodId?: IdentityAggregateIdMap["authentication_method"];
  issuedAt?: string;
  expiresAt?: string;
  clientFingerprint?: string;
  status?: SessionStatus;
  revokedReason?: string;
};

export const createSessionState = (
  id: IdentityAggregateIdMap["session"]
): SessionState => ({
  id,
  exists: false,
});

export const applySessionEvent = (
  state: SessionState,
  event: IdentityEventForAggregate<"session">
): SessionState => {
  switch (event.type) {
    case "identity.session.started.v1":
      assertInvariant(!state.exists, "SessionStarted requires a new session.");
      return {
        ...state,
        exists: true,
        accountId: event.data.accountId,
        organizationId: event.data.organizationId,
        authenticationMethodId: event.data.authenticationMethodId,
        issuedAt: event.data.issuedAt,
        expiresAt: event.data.expiresAt,
        clientFingerprint: event.data.clientFingerprint,
        status: "active",
      };

    case "identity.session.refreshed.v1":
      assertInvariant(state.exists, "SessionRefreshed requires existing session.");
      assertInvariant(
        state.status === "active",
        "SessionRefreshed is invalid when session is revoked or expired."
      );
      return {
        ...state,
        expiresAt: event.data.expiresAt,
      };

    case "identity.session.revoked.v1":
      assertInvariant(state.exists, "SessionRevoked requires existing session.");
      assertInvariant(
        state.status === "active",
        "SessionRevoked is valid only when session status is 'active'."
      );
      return {
        ...state,
        status: "revoked",
        revokedReason: event.data.reason,
      };

    case "identity.session.expired.v1":
      assertInvariant(state.exists, "SessionExpired requires existing session.");
      assertInvariant(
        state.status === "active",
        "SessionExpired is valid only when session status is 'active'."
      );
      return {
        ...state,
        status: "expired",
      };
  }
};

export const rehydrateSession = (
  sessionId: IdentityAggregateIdMap["session"],
  events: readonly IdentityEventForAggregate<"session">[]
): SessionState =>
  rehydrateAggregate(
    "session",
    sessionId,
    events,
    createSessionState(sessionId),
    applySessionEvent
  );

export type ApiKeyStatus = "active" | "revoked";

export type ApiKeyState = {
  id: IdentityAggregateIdMap["api_key"];
  exists: boolean;
  accountId?: AccountId;
  label?: string;
  scopes: readonly string[];
  credentialId?: IdentityAggregateIdMap["credential"];
  expiresAt?: string;
  status?: ApiKeyStatus;
  revokedReason?: string;
};

export const createApiKeyState = (
  id: IdentityAggregateIdMap["api_key"]
): ApiKeyState => ({
  id,
  exists: false,
  scopes: [],
});

export const applyApiKeyEvent = (
  state: ApiKeyState,
  event: IdentityEventForAggregate<"api_key">
): ApiKeyState => {
  switch (event.type) {
    case "identity.api_key.created.v1":
      assertInvariant(!state.exists, "ApiKeyCreated requires a new api key.");
      return {
        ...state,
        exists: true,
        accountId: event.data.accountId,
        label: event.data.label,
        scopes: [...event.data.scopes],
        credentialId: event.data.credentialId,
        expiresAt: event.data.expiresAt,
        status: "active",
      };

    case "identity.api_key.scopes_updated.v1":
      assertInvariant(state.exists, "ScopesUpdated requires existing api key.");
      assertInvariant(
        state.status === "active",
        "ScopesUpdated is valid only when api key status is 'active'."
      );
      return {
        ...state,
        scopes: [...event.data.scopes],
      };

    case "identity.api_key.rotated.v1":
      assertInvariant(state.exists, "ApiKeyRotated requires existing api key.");
      assertInvariant(
        state.status === "active",
        "ApiKeyRotated is valid only when api key status is 'active'."
      );
      return {
        ...state,
        credentialId: event.data.credentialId,
      };

    case "identity.api_key.expiration_updated.v1":
      assertInvariant(state.exists, "ExpirationUpdated requires existing api key.");
      assertInvariant(
        state.status === "active",
        "ExpirationUpdated is valid only when api key status is 'active'."
      );
      return {
        ...state,
        expiresAt: event.data.expiresAt,
      };

    case "identity.api_key.revoked.v1":
      assertInvariant(state.exists, "ApiKeyRevoked requires existing api key.");
      assertInvariant(
        state.status === "active",
        "ApiKeyRevoked is valid only when api key status is 'active'."
      );
      return {
        ...state,
        status: "revoked",
        revokedReason: event.data.reason,
      };
  }
};

export const rehydrateApiKey = (
  apiKeyId: IdentityAggregateIdMap["api_key"],
  events: readonly IdentityEventForAggregate<"api_key">[]
): ApiKeyState =>
  rehydrateAggregate(
    "api_key",
    apiKeyId,
    events,
    createApiKeyState(apiKeyId),
    applyApiKeyEvent
  );

export type IdentityAggregateStateMap = {
  account: AccountState;
  organization: OrganizationState;
  membership: MembershipState;
  role: RoleState;
  invitation: InvitationState;
  consent: ConsentState;
  contact_method: ContactMethodState;
  verification: VerificationState;
  credential: CredentialState;
  authentication_method: AuthenticationMethodState;
  session: SessionState;
  api_key: ApiKeyState;
};

export const rehydrateIdentityAggregate = <TAggregate extends IdentityAggregateType>(
  aggregateType: TAggregate,
  aggregateId: IdentityAggregateIdMap[TAggregate],
  events: readonly IdentityEventForAggregate<TAggregate>[]
): IdentityAggregateStateMap[TAggregate] => {
  switch (aggregateType) {
    case "account":
      return rehydrateAccount(
        aggregateId as IdentityAggregateIdMap["account"],
        events as readonly IdentityEventForAggregate<"account">[]
      ) as IdentityAggregateStateMap[TAggregate];

    case "organization":
      return rehydrateOrganization(
        aggregateId as IdentityAggregateIdMap["organization"],
        events as readonly IdentityEventForAggregate<"organization">[]
      ) as IdentityAggregateStateMap[TAggregate];

    case "membership":
      return rehydrateMembership(
        aggregateId as IdentityAggregateIdMap["membership"],
        events as readonly IdentityEventForAggregate<"membership">[]
      ) as IdentityAggregateStateMap[TAggregate];

    case "role":
      return rehydrateRole(
        aggregateId as IdentityAggregateIdMap["role"],
        events as readonly IdentityEventForAggregate<"role">[]
      ) as IdentityAggregateStateMap[TAggregate];

    case "invitation":
      return rehydrateInvitation(
        aggregateId as IdentityAggregateIdMap["invitation"],
        events as readonly IdentityEventForAggregate<"invitation">[]
      ) as IdentityAggregateStateMap[TAggregate];

    case "consent":
      return rehydrateConsent(
        aggregateId as IdentityAggregateIdMap["consent"],
        events as readonly IdentityEventForAggregate<"consent">[]
      ) as IdentityAggregateStateMap[TAggregate];

    case "contact_method":
      return rehydrateContactMethod(
        aggregateId as IdentityAggregateIdMap["contact_method"],
        events as readonly IdentityEventForAggregate<"contact_method">[]
      ) as IdentityAggregateStateMap[TAggregate];

    case "verification":
      return rehydrateVerification(
        aggregateId as IdentityAggregateIdMap["verification"],
        events as readonly IdentityEventForAggregate<"verification">[]
      ) as IdentityAggregateStateMap[TAggregate];

    case "credential":
      return rehydrateCredential(
        aggregateId as IdentityAggregateIdMap["credential"],
        events as readonly IdentityEventForAggregate<"credential">[]
      ) as IdentityAggregateStateMap[TAggregate];

    case "authentication_method":
      return rehydrateAuthenticationMethod(
        aggregateId as IdentityAggregateIdMap["authentication_method"],
        events as readonly IdentityEventForAggregate<"authentication_method">[]
      ) as IdentityAggregateStateMap[TAggregate];

    case "session":
      return rehydrateSession(
        aggregateId as IdentityAggregateIdMap["session"],
        events as readonly IdentityEventForAggregate<"session">[]
      ) as IdentityAggregateStateMap[TAggregate];

    case "api_key":
      return rehydrateApiKey(
        aggregateId as IdentityAggregateIdMap["api_key"],
        events as readonly IdentityEventForAggregate<"api_key">[]
      ) as IdentityAggregateStateMap[TAggregate];
  }
};
