import type { PostagePolicy, ProductPhysicalFlag, ShippingOption } from "@chase-sets/product-measures";
import type { PostagePolicyDetailRow, PostagePolicyRow } from "../read-model/queries";

export type PostagePolicyAdminRecord = PostagePolicyRow &
  Partial<Pick<PostagePolicyDetailRow, "history" | "activeComparison">>;

export type PostagePolicyCloneRequest = Readonly<{
  label: string;
  effectiveFrom: string;
  effectiveUntil?: string | null;
}>;

export type PostagePolicyCommandRequest = Partial<PostagePolicy> & PostagePolicyCloneRequest;

export type PostagePolicyPreviewRequest = Readonly<{
  policy: Partial<PostagePolicy>;
  shippingOption: ShippingOption;
  itemSubtotalAmount: string;
  quantity: number;
  unitLengthInches: number;
  unitWidthInches: number;
  unitHeightInches: number;
  unitWeightOunces: number;
  physicalFlags: readonly ProductPhysicalFlag[];
}>;
