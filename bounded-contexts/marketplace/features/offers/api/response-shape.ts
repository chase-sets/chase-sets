type PrivateOfferField =
  | "shipping_destination_snapshot"
  | "buyerOfferPolicyId"
  | "buyer_offer_policy_id"
  | "authority"
  | "preview"
  | "adjustmentBps"
  | "maximumUnitItemAmount"
  | "itemCommitmentAllowance"
  | "consumedItemAmount"
  | "remainingItemAllowance";

export function omitPrivateOfferResponseFields<T extends object>(offer: T): Omit<T, PrivateOfferField> {
  const {
    shipping_destination_snapshot: _privateDestination,
    buyerOfferPolicyId: _policyId,
    buyer_offer_policy_id: _projectedPolicyId,
    authority: _authority,
    preview: _preview,
    adjustmentBps: _adjustment,
    maximumUnitItemAmount: _maximum,
    itemCommitmentAllowance: _allowance,
    consumedItemAmount: _consumed,
    remainingItemAllowance: _remaining,
    ...publicOffer
  } = offer as T & Partial<Record<PrivateOfferField, unknown>>;
  return publicOffer as Omit<T, PrivateOfferField>;
}

export function publicOfferListResponse<T extends object>(response: { items: readonly T[]; total: number }) {
  return {
    items: response.items.map(omitPrivateOfferResponseFields),
    total: response.total,
  };
}
