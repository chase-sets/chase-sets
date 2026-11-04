import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

export const sellerCheckoutRiskPolicyRevision = "seller-checkout-risk-v1" as const;

export type SellerCheckoutRiskOwner =
  | Readonly<{ kind: "account"; accountId: AccountId }>
  | Readonly<{ kind: "anonymous"; anonymousSellListId: `anon_${string}` }>;

export type SellerCheckoutRiskResult = Readonly<{
  schemaVersion: "settlement.seller-checkout-risk.v1";
  status: "clear" | "not-clear";
  reasonCode: null | "risk-not-clear";
  policyRevision: typeof sellerCheckoutRiskPolicyRevision;
  sourceRevision: number;
  sourceTimestamp: IsoUtcTimestamp | null;
  rowState: "present" | "absent" | "unavailable";
}>;

export type SellerCheckoutRiskReader = (owner: SellerCheckoutRiskOwner) => Promise<SellerCheckoutRiskResult>;
