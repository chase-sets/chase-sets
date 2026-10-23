export type EndpointStatus = "observed" | "unavailable" | "disabled" | "not-requested";
export type SalesCoverage = "complete" | "request-cap-truncated" | "page-budget-truncated" | "inconsistent" | "unknown";
export type ListingsCoverage = "complete" | "ceiling-truncated" | "page-budget-truncated" | "inconsistent" | "unknown";
export type HistoryCoverage = "observed" | "inconsistent" | "unknown";
export type SafeHttpStatusClass = "none" | "4xx" | "5xx" | "other";

export type DecodedSale = Readonly<{
  condition: string;
  variant: string;
  language: string;
  quantity: number;
  listingType: string;
  customListingId: string;
  purchasePrice: number;
  shippingPrice: number;
  orderDate: string;
}>;

export type DecodedListing = Readonly<{
  condition: string;
  printing: string;
  language: string;
  verifiedSeller: boolean;
  sellerKey: string;
  sellerId: string;
  sellerName: string;
  listingId: number;
  price: number;
  sellerShippingPrice: number;
}>;

export type DecodedHistoryResult = Readonly<{
  skuId: number;
  variant: string;
  language: string;
  condition: string;
  buckets: readonly Readonly<{
    marketPrice: string | null;
    quantitySold: number;
    lowSalePrice: string | null;
    lowSalePriceWithShipping: string | null;
    highSalePrice: string | null;
    highSalePriceWithShipping: string | null;
    transactionCount: number;
    bucketStartDate: string;
  }>[];
}>;

export type SalesObservation = Readonly<{
  status: EndpointStatus;
  requestedAt: string;
  responseObservedAt: string | null;
  rows: readonly DecodedSale[];
  rejectedRows: number;
  coverage: SalesCoverage;
  pagesFetched: number;
  returnedCount: number;
  firstReportedTotal: number | null;
  lastReportedTotal: number | null;
  firstResultCount: number | null;
  lastResultCount: number | null;
  lastNextPage: "Yes" | "" | null;
  httpStatusClass: SafeHttpStatusClass;
}>;

export type ListingsObservation = Readonly<{
  status: EndpointStatus;
  requestedAt: string;
  responseObservedAt: string | null;
  rows: readonly DecodedListing[];
  rejectedRows: number;
  coverage: ListingsCoverage;
  pagesFetched: number;
  returnedCount: number;
  reportedTotal: number | null;
  ownSellerExclusionApplied: boolean;
  httpStatusClass: SafeHttpStatusClass;
}>;

export type HistoryObservation = Readonly<{
  status: EndpointStatus;
  requestedAt: string;
  responseObservedAt: string | null;
  rows: readonly DecodedHistoryResult[];
  rejectedRows: number;
  coverage: HistoryCoverage;
  resultCount: number;
  bucketCount: number;
  httpStatusClass: SafeHttpStatusClass;
}>;

export type TcgplayerSecondaryObservation = Readonly<{
  sales: SalesObservation;
  listings: ListingsObservation;
  history: HistoryObservation;
}>;
