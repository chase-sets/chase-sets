import type { SecondaryProduct } from "@chase-sets/tcgplayer-market-observations";

/** Compatibility fixture type; runtime mapper input is the C0 contract. */
type LegacyEndpoint = Readonly<{
  status: string;
  credentialsMode?: "omit" | "include" | null;
  requestedAt: string;
  responseObservedAt: string | null;
  rows: readonly Readonly<Record<string, unknown>>[];
  rejectedRows: number;
  coverage: string;
  pagesFetched?: number;
  returnedCount?: number;
  firstReportedTotal?: number | null;
  lastReportedTotal?: number | null;
  firstResultCount?: number | null;
  lastResultCount?: number | null;
  lastNextPage?: "Yes" | "" | null;
  reportedTotal?: number | null;
  ownSellerExclusionApplied?: boolean;
  resultCount?: number;
  bucketCount?: number;
  httpStatusClass: string;
}>;
export type TcgplayerSecondaryObservation = Readonly<{
  sales: LegacyEndpoint;
  listings: LegacyEndpoint;
  history: LegacyEndpoint;
}>;
export type ListingsCoverage = SecondaryProduct["listings"]["coverage"];
export type SalesCoverage = SecondaryProduct["sales"]["coverage"];
export type HistoryCoverage = SecondaryProduct["history"]["coverage"];
export type EndpointStatus = SecondaryProduct["sales"]["status"] | "disabled";
export type SafeHttpStatusClass = SecondaryProduct["sales"]["httpStatusClass"];
