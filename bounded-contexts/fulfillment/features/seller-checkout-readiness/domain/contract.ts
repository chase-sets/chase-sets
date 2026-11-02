import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

/**
 * Who a seller checkout belongs to before it is confirmed: a signed-in Account,
 * or the anonymous Sell List named by Checkout's trusted server-side
 * `x-checkout-anonymous-sell-list-id` boundary. An anonymous Sell List id is
 * never an AccountId; a guest-to-account merge re-keys or invalidates the
 * anonymous owner's facts instead of carrying them to the Account.
 */
export type SellerCheckoutReadinessOwner =
  | Readonly<{ kind: "account"; accountId: AccountId }>
  | Readonly<{ kind: "anonymous"; anonymousSellListId: `anon_${string}` }>;

/** The label preferences seller checkout already offers. */
export const sellerCheckoutLabelPreferences = ["prepaid-label", "seller-label-later"] as const;

export type SellerCheckoutLabelPreference = (typeof sellerCheckoutLabelPreferences)[number];

export type SellerCheckoutReadinessKey = Readonly<{
  owner: SellerCheckoutReadinessOwner;
  shipFromLocationId: string;
  labelPreference: SellerCheckoutLabelPreference;
}>;

/** Why no usable owner fact backs a dimension; every one of them blocks. */
export type SellerCheckoutBlockingFact = "missing" | "stale" | "conflicting" | "unavailable";

export type SellerCheckoutDimensionReadiness<BlockedReason extends string> =
  | Readonly<{ status: "ready"; reason: "ready" }>
  | Readonly<{ status: "blocked"; reason: BlockedReason; fact: SellerCheckoutBlockingFact }>;

/**
 * Fulfillment's answer for one key. `sourceRevision` and `sourceTimestamp` name
 * the owner facts it was read from and are null when no usable facts exist, so
 * a consumer can reject a revision that moved between two reads.
 */
export type SellerCheckoutReadinessResult = Readonly<{
  schemaVersion: "fulfillment.seller-checkout-readiness.v1";
  label: SellerCheckoutDimensionReadiness<"label-not-ready">;
  provider: SellerCheckoutDimensionReadiness<"provider-not-ready">;
  sourceRevision: number | null;
  sourceTimestamp: IsoUtcTimestamp | null;
}>;

/** The read Checkout's adapter calls at readiness and again immediately before confirm, with the same key. */
export type SellerCheckoutReadinessReader = (key: SellerCheckoutReadinessKey) => Promise<SellerCheckoutReadinessResult>;
