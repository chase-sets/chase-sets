import type { SecondaryProduct } from "@chase-sets/tcgplayer-market-observations";

export type ListingsCoverage = SecondaryProduct["listings"]["coverage"];
export type SalesCoverage = SecondaryProduct["sales"]["coverage"];
export type HistoryCoverage = SecondaryProduct["history"]["coverage"];
export type EndpointStatus = SecondaryProduct["sales"]["status"] | "disabled";
export type SafeHttpStatusClass = SecondaryProduct["sales"]["httpStatusClass"];
