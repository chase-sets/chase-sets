export type MarketplaceListingRequestErrorCode =
  | "unknown-field"
  | "price-currency-invalid"
  | "availability-reason-invalid"
  | "away-window-reason-required"
  | "away-window-instant-required"
  | "order-capacity-invalid"
  | "photo-multipart-required"
  | "photo-replacement-required"
  | "id-invalid"
  | "inventory-snapshot-invalid";

export class MarketplaceListingRequestError extends Error {
  public constructor(
    public readonly code: MarketplaceListingRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MarketplaceListingRequestError";
  }
}
