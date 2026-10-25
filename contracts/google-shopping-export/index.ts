export type GoogleShoppingPayloadInput = Readonly<{
  offerId: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  priceAmount: string;
  currencyCode: string;
  availability: "in stock" | "out of stock";
  condition: string;
  externalSellerId: string;
  targetCountry: string;
  contentLanguage: string;
  feedLabel: string;
  brand?: string;
  gtin?: string;
  mpn?: string;
  identifierExists?: boolean;
  productType?: string;
  googleProductCategory?: string;
  productDetails?: readonly GoogleShoppingProductDetail[];
  shipping?: GoogleShoppingShippingPolicyPayload;
  returnPolicyLabel?: string;
}>;

export type GoogleShoppingProductDetail = Readonly<{
  sectionName: string;
  attributeName: string;
  attributeValue: string;
}>;

export type GoogleShoppingShippingPolicyPayload = Readonly<{
  country: string;
  service?: string;
  price?: Readonly<{
    amount: string;
    currencyCode: string;
  }>;
}>;

export type GoogleShoppingSyncProviderOperation =
  | "insert-product-input"
  | "patch-product-input"
  | "delete-product-input"
  | "get-processed-product";

export type GoogleShoppingProductIssue = Readonly<{
  code: string | null;
  severity: string | null;
  resolution: string | null;
  attribute: string | null;
  reportingContext: string | null;
  description: string | null;
  detail: string | null;
  documentation: string | null;
  applicableCountries: readonly string[];
}>;

export type GoogleShoppingProductDiagnostics = Readonly<{
  productName: string;
  destinationStatuses: readonly unknown[];
  issues: readonly GoogleShoppingProductIssue[];
}>;

export type GoogleShoppingSyncProviderResult =
  | Readonly<{
      status: "success" | "dry-run";
      operation: GoogleShoppingSyncProviderOperation;
      attempts: number;
      request?: unknown;
      productInputName?: string | null;
      productName?: string | null;
      diagnostics?: GoogleShoppingProductDiagnostics;
    }>
  | Readonly<{
      status: "permanent-failure" | "transient-failure";
      operation: GoogleShoppingSyncProviderOperation;
      attempts: number;
      request?: unknown;
      error: Readonly<{
        code: string;
        message: string;
        httpStatus: number | null;
        retryable: boolean;
        providerRequestId: string | null;
        details?: unknown;
      }>;
    }>;

export type GoogleShoppingSyncMerchantClient = Readonly<{
  insertOrUpdateProductInput: (
    payload: GoogleShoppingPayloadInput,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<GoogleShoppingSyncProviderResult>;
  patchPriceAndAvailability?: (
    offerId: string,
    input: Readonly<{
      priceAmount: string;
      currencyCode: string;
      availability: GoogleShoppingPayloadInput["availability"];
    }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<GoogleShoppingSyncProviderResult>;
  deleteProductInput: (
    offerId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<GoogleShoppingSyncProviderResult>;
  getProcessedProductStatus?: (
    offerId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<GoogleShoppingSyncProviderResult>;
}>;
