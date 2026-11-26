export type MarketplaceListingDomainErrorCode =
  | "listing-not-found"
  | "inventory-item-not-found"
  | "shipping-measure-missing"
  | "certification-number-required"
  | "certification-number-invalid"
  | "command-rejected";

export class MarketplaceListingDomainError extends Error {
  public constructor(
    public readonly code: MarketplaceListingDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MarketplaceListingDomainError";
  }
}
