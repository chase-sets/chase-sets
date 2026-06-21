export function omitPrivateOfferResponseFields<T extends object>(offer: T): Omit<T, "shipping_destination_snapshot"> {
  const { shipping_destination_snapshot: _privateDestination, ...publicOffer } = offer as T & {
    shipping_destination_snapshot?: unknown;
  };
  return publicOffer as Omit<T, "shipping_destination_snapshot">;
}

export function publicOfferListResponse<T extends object>(response: { items: readonly T[]; total: number }) {
  return {
    items: response.items.map(omitPrivateOfferResponseFields),
    total: response.total,
  };
}
