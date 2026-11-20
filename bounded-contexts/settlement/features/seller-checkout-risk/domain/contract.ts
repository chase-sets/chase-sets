import { parseIsoUtcTimestamp, type IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

export const sellerCheckoutRiskPolicyRevision = "seller-checkout-risk-v1" as const;

export type SellerCheckoutRiskOwner =
  | Readonly<{ kind: "account"; accountId: AccountId }>
  | Readonly<{ kind: "anonymous"; anonymousSellListId: `anon_${string}` }>;

type ResultBase = Readonly<{
  schemaVersion: "settlement.seller-checkout-risk.v1";
  policyRevision: typeof sellerCheckoutRiskPolicyRevision;
}>;

export type SellerCheckoutRiskResult = ResultBase &
  (
    | (Readonly<{
        rowState: "present";
        sourceRevision: number;
        sourceTimestamp: IsoUtcTimestamp;
      }> &
        (
          | Readonly<{ status: "clear"; reasonCode: null }>
          | Readonly<{ status: "hold"; reasonCode: "risk-hold" }>
          | Readonly<{ status: "block"; reasonCode: "risk-block" }>
        ))
    | Readonly<{
        rowState: "absent";
        status: "clear";
        reasonCode: null;
        sourceRevision: 0;
        sourceTimestamp: null;
      }>
    | Readonly<{
        rowState: "unavailable";
        status: "not-clear";
        reasonCode: "risk-not-clear";
        sourceRevision: null;
        sourceTimestamp: null;
      }>
  );

export function parseSellerCheckoutRiskResult(value: unknown): SellerCheckoutRiskResult | null {
  if (!value || typeof value !== "object") return null;
  const keys = [
    "policyRevision",
    "reasonCode",
    "rowState",
    "schemaVersion",
    "sourceRevision",
    "sourceTimestamp",
    "status",
  ];
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) return null;
  const result = value as Record<string, unknown>;
  if (
    result.schemaVersion !== "settlement.seller-checkout-risk.v1" ||
    result.policyRevision !== sellerCheckoutRiskPolicyRevision
  )
    return null;
  if (result.rowState === "unavailable") {
    return result.status === "not-clear" &&
      result.reasonCode === "risk-not-clear" &&
      result.sourceRevision === null &&
      result.sourceTimestamp === null
      ? (result as SellerCheckoutRiskResult)
      : null;
  }
  if (result.rowState === "absent") {
    return result.status === "clear" &&
      result.reasonCode === null &&
      result.sourceRevision === 0 &&
      result.sourceTimestamp === null
      ? (result as SellerCheckoutRiskResult)
      : null;
  }
  if (
    result.rowState !== "present" ||
    typeof result.sourceRevision !== "number" ||
    !Number.isSafeInteger(result.sourceRevision) ||
    result.sourceRevision < 0 ||
    typeof result.sourceTimestamp !== "string"
  )
    return null;
  try {
    parseIsoUtcTimestamp(result.sourceTimestamp);
  } catch {
    return null;
  }
  const paired =
    (result.status === "clear" && result.reasonCode === null) ||
    (result.status === "hold" && result.reasonCode === "risk-hold") ||
    (result.status === "block" && result.reasonCode === "risk-block");
  return paired ? (result as SellerCheckoutRiskResult) : null;
}

export type SellerCheckoutRiskReader = (owner: SellerCheckoutRiskOwner) => Promise<SellerCheckoutRiskResult>;
