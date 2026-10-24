import {
  actionFields,
  actionTargetField,
  routeActions,
  closedObject,
  isInstant,
  parseAttemptKey,
  type MutationAction,
} from "../domain/contract";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";

export type ClientState =
  | "editing"
  | "submitting"
  | "confirming"
  | "succeeded"
  | "failed-safe"
  | "conflict"
  | "ambiguous"
  | "reauth-required"
  | "route-denied";
export type MutationDescriptor = Readonly<{
  version: 1;
  tenantId: string;
  userId: string;
  accountId: string;
  route: string;
  action: MutationAction;
  target: string | null;
  attempt: string;
  hash: string;
  createdAt: string;
  sentAt: string | null;
  observedAt: string;
}>;
export const accountMutationRoutes = [
  "/account",
  "/account/shipping-addresses",
  "/account/consents",
  "/account/security",
  "/account/team",
] as const;

export function validateDescriptor(value: unknown): MutationDescriptor {
  const raw = closedObject(value, [
    "version",
    "tenantId",
    "userId",
    "accountId",
    "route",
    "action",
    "target",
    "attempt",
    "hash",
    "createdAt",
    "sentAt",
    "observedAt",
  ]);
  if (raw.version !== 1 || typeof raw.tenantId !== "string" || !/^tnt_[a-zA-Z0-9_-]{1,80}$/.test(raw.tenantId))
    throw new Error("INDETERMINATE");
  for (const [name, prefix] of [
    ["userId", "usr_"],
    ["accountId", "acc_"],
  ])
    if (typeof raw[name] !== "string" || !String(raw[name]).startsWith(prefix) || String(raw[name]).length > 100)
      throw new Error("INDETERMINATE");
  if (
    !accountMutationRoutes.some((route) => route === raw.route) ||
    typeof raw.action !== "string" ||
    !Object.hasOwn(actionFields, raw.action) ||
    (raw.target !== null && (typeof raw.target !== "string" || raw.target.length > 100)) ||
    typeof raw.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.hash)
  )
    throw new Error("INDETERMINATE");
  if (!(routeActions[raw.route as keyof typeof routeActions] as readonly string[]).includes(raw.action))
    throw new Error("INDETERMINATE");
  const field = actionTargetField[raw.action as MutationAction];
  const prefixes: Readonly<Record<string, string>> = {
    shippingAddressId: "adr_",
    consentId: "cns_",
    apiKeyId: "key_",
    invitationId: "ivt_",
    membershipId: "mbr_",
  };
  const prefix = field
    ? prefixes[field]
    : raw.action === "update-profile"
      ? "acc_"
      : raw.action === "update-user"
        ? "usr_"
        : null;
  if (
    prefix
      ? typeof raw.target !== "string" || !raw.target.startsWith(prefix) || raw.target.length <= prefix.length
      : raw.target !== null
  )
    throw new Error("INDETERMINATE");
  if (prefix) parseTypedId(raw.target as string, prefix.slice(0, -1));
  parseAttemptKey(raw.attempt);
  if (
    !isInstant(raw.createdAt) ||
    !isInstant(raw.observedAt) ||
    (raw.sentAt !== null && !isInstant(raw.sentAt)) ||
    Date.parse(raw.observedAt) < Date.parse(raw.createdAt) ||
    (raw.sentAt !== null && Date.parse(raw.sentAt) < Date.parse(raw.createdAt))
  )
    throw new Error("INDETERMINATE");
  if (raw.sentAt !== null && Date.parse(raw.observedAt) < Date.parse(raw.sentAt)) throw new Error("INDETERMINATE");
  return raw as unknown as MutationDescriptor;
}

export function descriptorDisposition(
  descriptor: MutationDescriptor,
  state: ClientState,
  actor: Readonly<{ tenantId: string; userId: string; accountId: string }> | null,
) {
  return actor &&
    descriptor.tenantId === actor.tenantId &&
    descriptor.userId === actor.userId &&
    descriptor.accountId === actor.accountId &&
    ["ambiguous", "reauth-required"].includes(state)
    ? "retain-inert"
    : "discard";
}

export async function formIntentDigest(form: FormData): Promise<string> {
  const entries = [...form.entries()]
    .map(([name, value]) => {
      if (typeof value !== "string") throw new Error("INDETERMINATE");
      return [name, value] as const;
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(entries)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
