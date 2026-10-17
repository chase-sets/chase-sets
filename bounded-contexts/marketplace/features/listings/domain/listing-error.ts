export type MarketplaceListingDomainErrorCode = "listing-not-found" | "inventory-item-not-found" | "command-rejected";

export class MarketplaceListingDomainError extends Error {
  public constructor(
    public readonly code: MarketplaceListingDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MarketplaceListingDomainError";
  }
}
