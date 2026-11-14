import type {
  SellerCheckoutReadinessOwner,
  SellerCheckoutReadinessResult,
  SellerCheckoutRiskResult,
  SellerShippingOrigin,
  SellerShippingOriginResolution,
} from "../../../api";

export type SellerCheckoutChoices = Readonly<{
  shipFrom?: Readonly<{ addressId: string }> | SellerShippingOrigin;
  label?: Readonly<{ preference: "prepaid-label" | "seller-label-later" }>;
}>;

export type SellerCheckoutOwnerReadCapture = Readonly<{
  moment: "readiness" | "pre-confirm";
  confirmationId: string | null;
  owner: SellerCheckoutReadinessOwner | null;
  risk: SellerCheckoutRiskResult | null;
  origin: SellerShippingOriginResolution | null;
  fulfillment: SellerCheckoutReadinessResult | null;
  estimate: Readonly<{ status: "complete" | "unavailable"; amount: string | null; currencyCode: string | null }>;
  lineRevision: string;
  lineTimestamps: readonly string[];
}>;
