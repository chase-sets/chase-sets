import { normalizeAddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { sellerCheckoutLabelPreferences, type SellerCheckoutLabelPreference, type SellerCheckoutReadinessOwner } from "./contract";

export type SellerShippingOrigin = Readonly<{
  name: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}>;

export type SellerShippingSetupInput = Readonly<{
  origin: SellerShippingOrigin;
  labelPreference: SellerCheckoutLabelPreference;
}>;

export const sellerShippingLaunchPolicyId = "fulfillment.seller-shipping-support.launch.v1";
export type SellerShippingSupport = Readonly<{
  launchPolicyId: typeof sellerShippingLaunchPolicyId;
  "prepaid-label": "enabled" | "revoked";
  "seller-label-later": "enabled" | "revoked";
}>;

export type SellerShippingState = Readonly<{
  owner: SellerCheckoutReadinessOwner;
  revision: number;
  setup: (SellerShippingSetupInput & Readonly<{ shipFromLocationId: string }>) | null;
  support: SellerShippingSupport | null;
  mergedIntoAccountId: AccountId | null;
}>;

export class SellerShippingError extends Error {
  constructor(public readonly code: "invalid-input" | "forbidden" | "authority-unavailable" | "conflicting-operation" | "invalidated" | "support-not-initialized" | "source-unavailable") {
    super(code);
  }
}

export function closedObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new SellerShippingError("invalid-input");
  }
  return value as Record<string, unknown>;
}

export function shippingId(value: unknown, prefix: string): string {
  if (typeof value !== "string" || value.length > 160 || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(value) || value === "acc_anonymous_sell_list") {
    throw new SellerShippingError("invalid-input");
  }
  return value;
}

export function parseShippingOwner(value: unknown): SellerCheckoutReadinessOwner {
  const fields = closedObject(value, ["kind", "accountId", "anonymousSellListId"]);
  if (fields.kind === "account" && Object.keys(fields).length === 2 && !("anonymousSellListId" in fields)) {
    return { kind: "account", accountId: shippingId(fields.accountId, "acc") as AccountId };
  }
  if (fields.kind === "anonymous" && Object.keys(fields).length === 2 && !("accountId" in fields)) {
    return { kind: "anonymous", anonymousSellListId: shippingId(fields.anonymousSellListId, "anon") as `anon_${string}` };
  }
  throw new SellerShippingError("invalid-input");
}

export function shippingOwnerKey(owner: SellerCheckoutReadinessOwner): string {
  const valid = parseShippingOwner(owner);
  return valid.kind === "account" ? `account:${valid.accountId}` : `anonymous:${valid.anonymousSellListId}`;
}

export function parseLabelPreference(value: unknown): SellerCheckoutLabelPreference {
  if (!sellerCheckoutLabelPreferences.some((preference) => preference === value)) throw new SellerShippingError("invalid-input");
  return value as SellerCheckoutLabelPreference;
}

export function parseShippingOrigin(value: unknown): SellerShippingOrigin {
  const fields = closedObject(value, ["name", "line1", "line2", "city", "state", "postalCode", "country"]);
  for (const field of ["name", "line1", "city", "state", "postalCode", "country"]) {
    if (typeof fields[field] !== "string" || !(fields[field] as string).trim() || (fields[field] as string).length > 200) throw new SellerShippingError("invalid-input");
  }
  if (fields.line2 !== undefined && fields.line2 !== null && (typeof fields.line2 !== "string" || fields.line2.length > 200)) throw new SellerShippingError("invalid-input");
  const address = normalizeAddressSnapshot({
    name: fields.name as string, line1: fields.line1 as string, line2: fields.line2 as string | null,
    city: fields.city as string, state: fields.state as string, postalCode: fields.postalCode as string, country: fields.country as string,
  });
  return { name: address.name, line1: address.line1, line2: address.line2 ?? null, city: address.city, state: address.state, postalCode: address.postalCode, country: address.country };
}

export function parseShippingSetup(value: unknown): SellerShippingSetupInput {
  const fields = closedObject(value, ["origin", "labelPreference"]);
  return { origin: parseShippingOrigin(fields.origin), labelPreference: parseLabelPreference(fields.labelPreference) };
}

export function parseShippingSupport(value: unknown): SellerShippingSupport {
  const fields = closedObject(value, ["launchPolicyId", ...sellerCheckoutLabelPreferences]);
  if (fields.launchPolicyId !== sellerShippingLaunchPolicyId || sellerCheckoutLabelPreferences.some((preference) => fields[preference] !== "enabled" && fields[preference] !== "revoked")) throw new SellerShippingError("invalid-input");
  return { launchPolicyId: sellerShippingLaunchPolicyId, "prepaid-label": fields["prepaid-label"] as "enabled" | "revoked", "seller-label-later": fields["seller-label-later"] as "enabled" | "revoked" };
}

export function parseShippingState(value: unknown): SellerShippingState {
  const fields = closedObject(value, ["owner", "revision", "setup", "support", "mergedIntoAccountId"]);
  const owner = parseShippingOwner(fields.owner);
  if (!Number.isSafeInteger(fields.revision) || (fields.revision as number) < 1) throw new SellerShippingError("invalid-input");
  let setup: SellerShippingState["setup"] = null;
  if (fields.setup !== null) {
    const input = closedObject(fields.setup, ["origin", "labelPreference", "shipFromLocationId"]);
    setup = { ...parseShippingSetup({ origin: input.origin, labelPreference: input.labelPreference }), shipFromLocationId: shippingId(input.shipFromLocationId, "sfl") };
  }
  const mergedIntoAccountId = fields.mergedIntoAccountId === null ? null : shippingId(fields.mergedIntoAccountId, "acc") as AccountId;
  if (owner.kind === "account" && mergedIntoAccountId !== null) throw new SellerShippingError("invalid-input");
  return { owner, revision: fields.revision as number, setup, support: fields.support === null ? null : parseShippingSupport(fields.support), mergedIntoAccountId };
}

export function sameShippingOrigin(left: SellerShippingOrigin, right: SellerShippingOrigin): boolean {
  return JSON.stringify(parseShippingOrigin(left)) === JSON.stringify(parseShippingOrigin(right));
}
