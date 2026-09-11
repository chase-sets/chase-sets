import {
  authenticationMethodLabel,
  formatMachineValue,
  safeMachineToken,
  t,
  type Translate,
} from "@chase-sets/localization";
import type {
  AccountStatus,
  AccountType,
  ApiKeyStatus,
  AuthMethodKey,
  ContactMethodType,
  InvitationStatus,
  MembershipStatus,
  RoleKey,
  UserStatus,
} from "../runtime-support/common";
import type { IdentityConsentPolicyKey } from "../../features/consents/domain/terms-of-service-policy";
import type { Consent } from "../../features/consents/ui/contracts";

const accountTypeTranslationKeys = {
  personal: "identity.values.accountType.personal",
  business: "identity.values.accountType.business",
  enterprise: "identity.values.accountType.enterprise",
} as const satisfies Record<AccountType, string>;

const accountStatusTranslationKeys = {
  active: "identity.features.accounts.ui.accountListPage.status.filter.active",
  suspended: "identity.features.accounts.ui.accountListPage.status.filter.suspended",
  closed: "identity.features.accounts.ui.accountListPage.status.filter.closed",
} as const satisfies Record<AccountStatus, string>;

const userStatusTranslationKeys = {
  active: "identity.features.users.ui.userListPage.status.filter.active",
  suspended: "identity.features.users.ui.userListPage.status.filter.suspended",
} as const satisfies Record<UserStatus, string>;

const membershipRoleTranslationKeys = {
  "platform-admin": "identity.values.role.platformAdmin",
  owner: "identity.features.memberships.ui.role.owner",
  manager: "identity.features.memberships.ui.role.manager",
  fulfillment: "identity.features.memberships.ui.role.fulfillment",
  viewer: "identity.features.memberships.ui.role.viewer",
} as const satisfies Record<RoleKey, string>;

const membershipStatusTranslationKeys = {
  active: "identity.features.memberships.ui.membershipListPage.status.filter.active",
  revoked: "identity.features.memberships.ui.membershipListPage.status.filter.revoked",
} as const satisfies Record<MembershipStatus, string>;

const invitationStatusTranslationKeys = {
  pending: "identity.features.invitations.ui.invitationListPage.status.filter.pending",
  accepted: "identity.features.invitations.ui.invitationListPage.status.filter.accepted",
  declined: "identity.features.invitations.ui.invitationListPage.status.filter.declined",
  cancelled: "identity.features.invitations.ui.invitationListPage.status.filter.cancelled",
  expired: "identity.features.invitations.ui.invitationListPage.status.filter.expired",
} as const satisfies Record<InvitationStatus, string>;

const apiKeyStatusTranslationKeys = {
  active: "identity.features.apiKeys.ui.apiKeyListPage.status.filter.active",
  revoked: "identity.features.apiKeys.ui.apiKeyListPage.status.filter.revoked",
} as const satisfies Record<ApiKeyStatus, string>;

const consentPolicyTranslationKeys = {
  "terms-of-service": "identity.values.consentPolicy.termsOfService",
  "privacy-policy": "identity.values.consentPolicy.privacyPolicy",
  "seller-agreement": "identity.values.consentPolicy.sellerAgreement",
  "payments-terms": "identity.values.consentPolicy.paymentsTerms",
} as const satisfies Record<IdentityConsentPolicyKey, string>;

const consentStatusTranslationKeys = {
  recorded: "identity.features.consents.ui.consentHistoryPage.recorded",
  withdrawn: "identity.features.consents.ui.consentHistoryPage.withdrawn",
} as const satisfies Record<Consent["status"], string>;

const contactMethodTypeTranslationKeys = {
  email: "identity.features.users.ui.userDetailPage.email",
  phone: "identity.features.users.ui.userDetailPage.phone",
} as const satisfies Record<ContactMethodType, string>;

const identityAuthenticationMethodSelectValues = [
  "password",
  "magic-link",
  "passkey",
  "sms-code",
  "social-login",
] as const satisfies readonly AuthMethodKey[];

function identityValueLabel(
  value: string,
  knownValueTranslationKeys: Readonly<Record<string, string>>,
  familyTranslationKey: string,
  translate: Translate,
) {
  return formatMachineValue(value, {
    knownValueTranslationKeys,
    family: translate(familyTranslationKey),
    translate,
    unrecognizedTranslationKey: "identity.values.unrecognized",
    unrecognizedWithValueTranslationKey: "identity.values.unrecognized.withValue",
  });
}

export function accountTypeLabel(value: string, translate: Translate = t) {
  return identityValueLabel(value, accountTypeTranslationKeys, "identity.values.family.accountType", translate);
}

export function accountStatusLabel(value: string, translate: Translate = t) {
  return identityValueLabel(value, accountStatusTranslationKeys, "identity.values.family.accountStatus", translate);
}

export function userStatusLabel(value: string, translate: Translate = t) {
  return identityValueLabel(value, userStatusTranslationKeys, "identity.values.family.userStatus", translate);
}

export function membershipRoleLabel(value: string, translate: Translate = t) {
  return identityValueLabel(value, membershipRoleTranslationKeys, "identity.values.family.membershipRole", translate);
}

export function membershipStatusLabel(value: string, translate: Translate = t) {
  return identityValueLabel(
    value,
    membershipStatusTranslationKeys,
    "identity.values.family.membershipStatus",
    translate,
  );
}

export function invitationStatusLabel(value: string, translate: Translate = t) {
  return identityValueLabel(
    value,
    invitationStatusTranslationKeys,
    "identity.values.family.invitationStatus",
    translate,
  );
}

export function apiKeyStatusLabel(value: string, translate: Translate = t) {
  return identityValueLabel(value, apiKeyStatusTranslationKeys, "identity.values.family.apiKeyStatus", translate);
}

export function consentPolicyLabel(value: string, translate: Translate = t) {
  return identityValueLabel(value, consentPolicyTranslationKeys, "identity.values.family.consentPolicy", translate);
}

export function consentStatusLabel(value: string, translate: Translate = t) {
  return identityValueLabel(value, consentStatusTranslationKeys, "identity.values.family.consentStatus", translate);
}

export function contactMethodTypeLabel(value: string, translate: Translate = t) {
  return identityValueLabel(
    value,
    contactMethodTypeTranslationKeys,
    "identity.values.family.contactMethodType",
    translate,
  );
}

export function consentVersionLabel(value: string, translate: Translate = t) {
  const safeVersion = safeMachineToken(value);
  return safeVersion
    ? translate("identity.values.version", { version: safeVersion })
    : translate("identity.values.version.unavailable");
}

export function identityDateUnavailable(translate: Translate = t) {
  return translate("identity.values.date.unavailable");
}

export function identityAuthenticationMethodLabel(value: string, translate: Translate = t) {
  return authenticationMethodLabel(value, translate);
}

export const identityAuthenticationMethodSelectItems = Object.freeze(
  identityAuthenticationMethodSelectValues.map((value) =>
    Object.freeze({ value, label: identityAuthenticationMethodLabel(value) }),
  ),
);

export const contactMethodTypeSelectItems = Object.freeze(
  (Object.keys(contactMethodTypeTranslationKeys) as ContactMethodType[]).map((value) =>
    Object.freeze({ value, label: contactMethodTypeLabel(value) }),
  ),
);
