import type { MutationResult } from "./runtime";
import type { AttemptBinding, MutationAction } from "../domain/contract";
import { actionEventTypes } from "../domain/contract";

// Synthetic route transport fixture. It is not a stored receipt or DB proof.
export function syntheticMutationResult(
  action: MutationAction,
  binding: AttemptBinding,
  options: Readonly<{ target?: string | null; newlyCommitted?: boolean; secret?: string }> = {},
): MutationResult {
  const categories = {
    "update-profile": "account",
    create: "shipping-address-book",
    update: "shipping-address-book",
    default: "shipping-address-book",
    archive: "shipping-address-book",
    withdraw: "consent",
    "update-user": "user",
    "create-api-key": "api-key",
    "rotate-api-key": "api-key",
    "revoke-api-key": "api-key",
    "create-invitation": "invitation",
    "cancel-invitation": "invitation",
    "change-role": "membership",
    revoke: "membership",
    reinstate: "membership",
  } as const;
  const category = categories[action];
  const generated = {
    account: binding.accountId,
    user: binding.userId,
    "shipping-address-book": "adr_synthetic",
    consent: "cns_synthetic",
    "api-key": "key_synthetic",
    invitation: "ivt_synthetic",
    membership: "mbr_synthetic",
  }[category];
  const target =
    options.target === undefined
      ? ["create", "create-api-key", "create-invitation"].includes(action)
        ? null
        : generated
      : options.target;
  const id = target ?? generated;
  const status = category === "invitation" ? "pending" : category === "consent" ? "withdrawn" : "active";
  const events = actionEventTypes[action].map((type, index) => ({
    id: `evt_synthetic${index}`,
    type,
    digest: "a".repeat(64),
  }));
  const version = 6 + events.length;
  return {
    outcome: "committed",
    newlyCommitted: options.newlyCommitted ?? true,
    receipt: {
      schemaVersion: 1,
      binding,
      action,
      target,
      category,
      owner: `identity.${category}-${category === "shipping-address-book" ? binding.accountId : id}`,
      hash: "b".repeat(64),
      priorVersion: 6,
      committedVersion: version,
      events,
      result: { id, version, status, changed: true },
    },
    current: { id, version, status },
    ...(options.secret ? { secret: options.secret } : {}),
  };
}
