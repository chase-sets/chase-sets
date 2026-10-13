export const actionFields = {
  "update-profile": ["name", "displayName"],
  create: [
    "label",
    "name",
    "company",
    "line1",
    "line2",
    "city",
    "state",
    "postalCode",
    "country",
    "phone",
    "email",
    "makeDefault",
    "addressVerificationDecision",
  ],
  update: [
    "label",
    "name",
    "company",
    "line1",
    "line2",
    "city",
    "state",
    "postalCode",
    "country",
    "phone",
    "email",
    "makeDefault",
    "addressVerificationDecision",
  ],
  default: [],
  archive: [],
  withdraw: [],
  "update-user": ["displayName", "givenName", "familyName"],
  "create-api-key": ["userId", "name"],
  "rotate-api-key": [],
  "revoke-api-key": [],
  "create-invitation": ["accountId", "email", "roleKey", "invitationId", "expiresAt"],
  "cancel-invitation": [],
  "change-role": ["roleKey"],
  revoke: [],
  reinstate: [],
} as const;

export type MutationAction = keyof typeof actionFields;
export type AttemptBinding = Readonly<{ tenantId: string; userId: string; accountId: string }>;

export const actionEventTypes: Record<MutationAction, readonly string[]> = {
  "update-profile": ["identity.account.profile-updated"],
  create: ["identity.shipping-address.added"],
  update: ["identity.shipping-address.updated"],
  default: ["identity.shipping-address.default-set"],
  archive: ["identity.shipping-address.archived"],
  withdraw: ["identity.consent.withdrawn"],
  "update-user": ["identity.user.profile-updated"],
  "create-api-key": ["identity.api-key.created", "identity.api-key.verifier-recorded"],
  "rotate-api-key": ["identity.api-key.rotated", "identity.api-key.verifier-recorded"],
  "revoke-api-key": ["identity.api-key.revoked"],
  "create-invitation": ["identity.invitation.created"],
  "cancel-invitation": ["identity.invitation.cancelled"],
  "change-role": ["identity.membership.role-changed"],
  revoke: ["identity.membership.revoked"],
  reinstate: ["identity.membership.reinstated"],
};

export function validateEventProofs(
  action: MutationAction,
  value: unknown,
): readonly Readonly<{ id: string; type: string; digest: string }>[] {
  if (!Array.isArray(value) || value.length > 2) throw new Error("INDETERMINATE");
  const expected = actionEventTypes[action];
  const mustChange = ["create", "create-api-key", "rotate-api-key", "create-invitation"].includes(action);
  if ((mustChange || value.length > 0) && value.length !== expected.length) throw new Error("INDETERMINATE");
  const ids = new Set<string>();
  for (const [index, proof] of value.entries()) {
    const event = closedObject(proof, ["id", "type", "digest"]);
    if (
      typeof event.id !== "string" ||
      !/^evt_[a-zA-Z0-9_-]{1,90}$/.test(event.id) ||
      ids.has(event.id) ||
      event.type !== expected[index] ||
      typeof event.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(event.digest)
    )
      throw new Error("INDETERMINATE");
    ids.add(event.id);
  }
  return value;
}

export const routeActions = {
  "/account": ["update-profile"],
  "/account/shipping-addresses": ["create", "update", "default", "archive"],
  "/account/consents": ["withdraw"],
  "/account/security": ["update-user", "create-api-key", "rotate-api-key", "revoke-api-key"],
  "/account/team": ["create-invitation", "cancel-invitation", "change-role", "revoke", "reinstate"],
} as const;

export const actionTargetField: Partial<Record<MutationAction, string>> = {
  update: "shippingAddressId",
  default: "shippingAddressId",
  archive: "shippingAddressId",
  withdraw: "consentId",
  "rotate-api-key": "apiKeyId",
  "revoke-api-key": "apiKeyId",
  "cancel-invitation": "invitationId",
  "change-role": "membershipId",
  revoke: "membershipId",
  reinstate: "membershipId",
};

export function closedObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error("INDETERMINATE");
  }
  return value as Record<string, unknown>;
}

export function parseAttemptKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error("interruption-safe-client-required");
  }
  return value.toLowerCase();
}

export function isInstant(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59)
    return false;
  const date = value.slice(0, 10);
  return new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}
