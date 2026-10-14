import { closedObject, isInstant } from "./contract";
import { ROLE_KEYS } from "../../../support/runtime-support/common";
import type { ShippingAddressSnapshot } from "../../shipping-addresses/domain/domain";

type Validator = (value: unknown) => boolean;
const text: Validator = (value) => typeof value === "string" && value.length <= 2000;
const nullableText: Validator = (value) => value === null || text(value);
const boolean: Validator = (value) => typeof value === "boolean";
const instant: Validator = isInstant;
const enumeration =
  (...values: readonly unknown[]): Validator =>
  (value) =>
    values.includes(value);
const optional =
  (validate: Validator): Validator =>
  (value) =>
    value === undefined || validate(value);
const nullable =
  (validate: Validator): Validator =>
  (value) =>
    value === null || validate(value);
const object =
  (shape: Readonly<Record<string, Validator>>): Validator =>
  (value) => {
    const fields = closedObject(value, Object.keys(shape));
    return Object.entries(shape).every(([key, validate]) => validate(fields[key]));
  };
const messages: Validator = (value) => Array.isArray(value) && value.length <= 100 && value.every(text);
const addressFields = {
  name: text,
  company: optional(nullableText),
  line1: text,
  line2: optional(nullableText),
  city: text,
  state: text,
  postalCode: text,
  country: text,
  phone: optional(nullableText),
  email: optional(nullableText),
};
const verification = object({
  status: enumeration("verified", "corrected", "unverified", "undeliverable"),
  source: text,
  checkedAt: instant,
  buyerDecision: optional(enumeration(null, "accepted-suggested", "kept-original", "provider-unavailable")),
  suggestedAddress: optional(nullable(object(addressFields))),
  messages: optional(messages),
});
const address = object({ ...addressFields, verification: optional(nullable(verification)) });
const role = enumeration(...ROLE_KEYS);
const contact = object({
  contactMethodId: text,
  type: enumeration("email", "phone"),
  value: text,
  verifiedAt: optional(nullable(instant)),
});
const consentFields = {
  consentId: text,
  subjectType: enumeration("user", "account"),
  userId: nullableText,
  accountId: nullableText,
  policyKey: text,
  policyVersion: text,
};
const enforcement = object({
  version: enumeration(1),
  enforcementActionId: text,
  reason: text,
  reference: nullable(object({ kind: enumeration("support-request"), supportRequestId: text })),
});
const enforcementEvent: Validator = (value) =>
  Object.keys(closedObject(value, ["enforcement"])).length === 0 || object({ enforcement })(value);

const schemas: Readonly<Record<string, Validator>> = {
  "identity.account.created": object({
    accountId: text,
    name: text,
    accountType: enumeration("personal", "business", "enterprise"),
    displayName: text,
  }),
  "identity.account.profile-updated": object({ name: text, displayName: text }),
  "identity.account.suspended": enforcementEvent,
  "identity.account.reactivated": enforcementEvent,
  "identity.account.closed": enforcementEvent,
  "identity.account.badge-assigned": object({
    badgeKey: text,
    founderNumber: optional((value) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 500),
  }),
  "identity.account.badge-removed": object({ badgeKey: text }),
  "identity.account.founders-window-opened": object({
    betaAccessStartedAt: instant,
    foundersWindowEndsAt: instant,
    recipientEmail: optional(text),
  }),
  "identity.membership.granted": object({ membershipId: text, userId: text, accountId: text, roleKey: role }),
  "identity.membership.role-changed": object({ roleKey: role }),
  "identity.membership.revoked": object({}),
  "identity.membership.reinstated": object({}),
  "identity.consent.recorded": object({ ...consentFields, recordedAt: instant }),
  "identity.consent.withdrawn": object({ ...consentFields, withdrawnAt: instant }),
  "identity.api-key.created": object({ apiKeyId: text, userId: text, name: text, keyPrefix: text }),
  "identity.api-key.rotated": object({ keyPrefix: text }),
  "identity.api-key.revoked": object({}),
  "identity.api-key.used": object({ usedAt: instant }),
  "identity.api-key.verifier-recorded": object({
    keyPrefix: text,
    secretHash: (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
  }),
  "identity.invitation.created": object({
    invitationId: text,
    accountId: text,
    email: text,
    roleKey: role,
    expiresAt: instant,
  }),
  "identity.invitation.resent": object({ expiresAt: instant }),
  "identity.invitation.acceptance-token-issued": object({ tokenHash: text, expiresAt: instant }),
  "identity.invitation.accepted": object({ userId: text, acceptedAt: instant }),
  "identity.invitation.cancelled": object({}),
  "identity.invitation.declined": object({}),
  "identity.invitation.expired": object({}),
  "identity.user.created": object({
    userId: text,
    displayName: text,
    givenName: text,
    familyName: text,
    primaryEmail: nullableText,
    primaryContactMethod: optional(contact),
  }),
  "identity.user.profile-updated": object({ displayName: text, givenName: text, familyName: text }),
  "identity.user.contact-method-added": object({
    contactMethodId: text,
    contactMethodType: enumeration("email", "phone"),
    value: text,
  }),
  "identity.user.contact-method-verified": object({ contactMethodId: text, verifiedAt: instant }),
  "identity.user.auth-method-enabled": object({ authMethod: text }),
  "identity.user.auth-method-disabled": object({ authMethod: text }),
  "identity.user.password-credential-attached": object({ credentialId: text }),
  "identity.user.passkey-registered": object({ credentialId: text }),
  "identity.user.social-login-linked": object({
    providerName: text,
    providerSubject: text,
    email: text,
    linkedAt: instant,
  }),
  "identity.user.suspended": object({}),
  "identity.user.reactivated": object({}),
  "identity.shipping-address.added": object({
    accountId: text,
    shippingAddressId: text,
    label: text,
    address,
    isDefault: boolean,
    addedAt: instant,
  }),
  "identity.shipping-address.updated": object({
    accountId: text,
    shippingAddressId: text,
    label: text,
    address,
    isDefault: boolean,
    updatedAt: instant,
  }),
  "identity.shipping-address.default-set": object({ accountId: text, shippingAddressId: text, setAt: instant }),
  "identity.shipping-address.archived": object({
    accountId: text,
    shippingAddressId: text,
    promotedDefaultShippingAddressId: nullableText,
    archivedAt: instant,
  }),
};

export function validateOwnerEvent(type: string, payload: unknown): void {
  if (!Object.hasOwn(schemas, type) || !schemas[type](payload)) throw new Error("INDETERMINATE");
}

export function validateShippingAddressSnapshot(value: unknown): ShippingAddressSnapshot {
  if (!address(value)) throw new Error("INDETERMINATE");
  return value as ShippingAddressSnapshot;
}
