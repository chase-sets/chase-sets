import { describe, expect, it, vi } from "vitest";
import { createGoogleMerchantApiClient } from "../src/google-merchant-client";
import type { PlatformWorkerGoogleMerchantConfig } from "../src/config";

type TestFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>;

const enabledConfig: PlatformWorkerGoogleMerchantConfig = {
  syncEnabled: true,
  dryRun: false,
  merchantAccountId: "123456",
  apiDataSourceId: "7890",
  targetCountry: "US",
  contentLanguage: "en",
  feedLabel: "US",
  credentialSecretName: "google-merchant-service-account",
  productionSyncApprovalReference: "GOOGLE-SHOPPING-SYNC-APPROVAL-2026-06-04",
};

const payload = {
  offerId: "cs-listing-lst_123",
  title: "Charizard 4/102",
  description: "Base Set unlimited raw card.",
  link: "https://www.chasesets.com/listings/charizard-lst-123",
  imageLink: "https://assets.chasesets.com/cards/charizard.jpg",
  priceAmount: "42.50",
  currencyCode: "USD",
  availability: "in stock",
  condition: "used",
  externalSellerId: "cs-account-acc_123",
  targetCountry: "US",
  contentLanguage: "en",
  feedLabel: "US",
  brand: "Pokemon",
  gtin: "00012345678905",
  productType: "Trading Cards > Pokemon",
  productDetails: [{ sectionName: "Product options", attributeName: "Set", attributeValue: "Base Set" }],
  shipping: { country: "US", service: "Standard", price: { amount: "4.99", currencyCode: "USD" } },
  returnPolicyLabel: "chase-sets-standard-returns",
} as const;

describe("google merchant api client", () => {
  it("inserts product inputs and returns a provider-neutral success", async () => {
    const fetchMock = vi.fn<TestFetch>(async () =>
      jsonResponse(200, {
        name: "accounts/123456/productInputs/ZW5-VVMtY3MtbGlzdGluZy1sc3RfMTIz",
        product: "accounts/123456/products/ZW5-VVMtY3MtbGlzdGluZy1sc3RfMTIz",
      }),
    );
    const tokenProvider = vi.fn(async () => "ya29.test-token");
    const logger = { info: vi.fn() };
    const client = createGoogleMerchantApiClient({
      config: enabledConfig,
      accessTokenProvider: tokenProvider,
      fetch: fetchMock,
      logger,
    });

    const result = await client.insertOrUpdateProductInput(payload);

    expect(result).toMatchObject({
      status: "success",
      operation: "insert-product-input",
      attempts: 1,
      productInputName: "accounts/[account]/productInputs/ZW5-VVMtY3MtbGlzdGluZy1sc3RfMTIz",
      productName: "accounts/[account]/products/ZW5-VVMtY3MtbGlzdGluZy1sc3RfMTIz",
    });
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/products/v1/accounts/123456/productInputs:insert");
    expect(String(url)).toContain("dataSource=accounts%2F123456%2FdataSources%2F7890");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: "Bearer ya29.test-token" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      offerId: payload.offerId,
      productAttributes: {
        price: { amountMicros: "42500000", currencyCode: "USD" },
        availability: "IN_STOCK",
        condition: "USED",
        externalSellerId: "cs-account-acc_123",
      },
    });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("ya29.test-token");
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("google-merchant-service-account");
    expect(result.request.url).not.toContain("accounts/123456");
    expect(result.request.url).not.toContain("dataSources/7890");
  });

  it("retries transient failures with backoff before succeeding", async () => {
    const fetchMock = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(jsonResponse(503, { error: { status: "UNAVAILABLE", message: "try again" } }))
      .mockResolvedValueOnce(jsonResponse(200, { name: "accounts/123456/productInputs/input" }));
    const sleep = vi.fn(async () => undefined);
    const client = createGoogleMerchantApiClient({
      config: enabledConfig,
      accessTokenProvider: async () => "token",
      fetch: fetchMock,
      retryBaseDelayMs: 10,
      sleep,
    });

    const result = await client.insertOrUpdateProductInput(payload);

    expect(result).toMatchObject({ status: "success", attempts: 2 });
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("returns transient failure after exhausting retryable responses", async () => {
    const fetchMock = vi.fn<TestFetch>(async () =>
      jsonResponse(503, { error: { status: "UNAVAILABLE", message: "try again later" } }),
    );
    const sleep = vi.fn(async () => undefined);
    const client = createGoogleMerchantApiClient({
      config: enabledConfig,
      accessTokenProvider: async () => "token",
      fetch: fetchMock,
      maxAttempts: 3,
      retryBaseDelayMs: 10,
      sleep,
    });

    const result = await client.insertOrUpdateProductInput(payload);

    expect(result).toMatchObject({
      status: "transient-failure",
      operation: "insert-product-input",
      attempts: 3,
      error: {
        code: "unavailable",
        httpStatus: 503,
        retryable: true,
        providerRequestId: "req_123",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it("surfaces permanent validation failures without leaking configured account data", async () => {
    const logger = { warn: vi.fn() };
    const client = createGoogleMerchantApiClient({
      config: enabledConfig,
      accessTokenProvider: async () => "token",
      fetch: async () =>
        jsonResponse(400, {
          error: {
            status: "INVALID_ARGUMENT",
            message: "accounts/123456 dataSources/7890 rejected google-merchant-service-account",
            details: [{ reason: "bad account 123456" }],
          },
        }),
      logger,
    });

    const result = await client.insertOrUpdateProductInput(payload);

    expect(result).toMatchObject({
      status: "permanent-failure",
      attempts: 1,
      error: {
        code: "invalid_argument",
        httpStatus: 400,
        retryable: false,
        message: "accounts/[account] dataSources/[data-source] rejected [credential-secret]",
      },
    });
    expect(JSON.stringify(result)).not.toContain("accounts/123456");
    expect(JSON.stringify(result)).not.toContain("dataSources/7890");
    expect(JSON.stringify(result)).not.toContain("google-merchant-service-account");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("accounts/123456");
  });

  it("deletes product inputs through the configured API data source", async () => {
    const fetchMock = vi.fn<TestFetch>(async () => jsonResponse(200, {}));
    const client = createGoogleMerchantApiClient({
      config: enabledConfig,
      accessTokenProvider: async () => "token",
      fetch: fetchMock,
    });

    const result = await client.deleteProductInput("cs-listing-lst_123");

    expect(result).toMatchObject({ status: "success", operation: "delete-product-input" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/products/v1/accounts/123456/productInputs/");
    expect(String(url)).toContain("dataSource=accounts%2F123456%2FdataSources%2F7890");
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
  });

  it("serializes dry-run requests without requesting credentials or calling Google", async () => {
    const fetchMock = vi.fn<TestFetch>();
    const tokenProvider = vi.fn(async () => "token");
    const client = createGoogleMerchantApiClient({
      config: { ...enabledConfig, dryRun: true },
      accessTokenProvider: tokenProvider,
      fetch: fetchMock,
    });

    const result = await client.insertOrUpdateProductInput(payload);

    expect(result).toMatchObject({
      status: "dry-run",
      attempts: 0,
      request: {
        method: "POST",
        operation: "insert-product-input",
        body: {
          offerId: payload.offerId,
          productAttributes: { price: { amountMicros: "42500000", currencyCode: "USD" } },
        },
      },
    });
    expect(result.request.url).toContain("accounts/[account]");
    expect(result.request.url).toContain("dataSources%2F%5Bdata-source%5D");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  it("serializes dry-run deletes without requesting credentials or calling Google", async () => {
    const fetchMock = vi.fn<TestFetch>();
    const tokenProvider = vi.fn(async () => "token");
    const client = createGoogleMerchantApiClient({
      config: { ...enabledConfig, dryRun: true },
      accessTokenProvider: tokenProvider,
      fetch: fetchMock,
    });

    const result = await client.deleteProductInput("cs-listing-lst_123");

    expect(result).toMatchObject({
      status: "dry-run",
      operation: "delete-product-input",
      attempts: 0,
      request: {
        method: "DELETE",
        operation: "delete-product-input",
      },
    });
    expect(result.request.url).toContain("accounts/[account]/productInputs/");
    expect(result.request.url).toContain("dataSources%2F%5Bdata-source%5D");
    expect("body" in result.request).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  it("returns a provider-neutral failure when sync is disabled", async () => {
    const fetchMock = vi.fn<TestFetch>();
    const tokenProvider = vi.fn(async () => "token");
    const client = createGoogleMerchantApiClient({
      config: { syncEnabled: false, dryRun: true },
      accessTokenProvider: tokenProvider,
      fetch: fetchMock,
    });

    const result = await client.patchPriceAndAvailability("cs-listing-lst_123", {
      priceAmount: "40.00",
      currencyCode: "USD",
      availability: "in stock",
    });

    expect(result).toMatchObject({
      status: "permanent-failure",
      operation: "patch-product-input",
      attempts: 0,
      request: { method: "PATCH", url: "google-merchant-sync-disabled" },
      error: { code: "google_merchant_sync_disabled", retryable: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  it("patches only frequent price and availability attributes", async () => {
    const fetchMock = vi.fn<TestFetch>(async () => jsonResponse(200, { name: "accounts/123456/productInputs/input" }));
    const client = createGoogleMerchantApiClient({
      config: enabledConfig,
      accessTokenProvider: async () => "token",
      fetch: fetchMock,
    });

    const result = await client.patchPriceAndAvailability("cs-listing-lst_123", {
      priceAmount: "40.00",
      currencyCode: "USD",
      availability: "out of stock",
    });

    expect(result).toMatchObject({ status: "success", operation: "patch-product-input" });
    expect(result.request.updateMask).toEqual(["productAttributes.price", "productAttributes.availability"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("updateMask=productAttributes.price%2CproductAttributes.availability");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      offerId: "cs-listing-lst_123",
      contentLanguage: "en",
      feedLabel: "US",
      productAttributes: {
        price: { amountMicros: "40000000", currencyCode: "USD" },
        availability: "OUT_OF_STOCK",
      },
    });
  });

  it("reads processed product diagnostics and maps item issues", async () => {
    const client = createGoogleMerchantApiClient({
      config: enabledConfig,
      accessTokenProvider: async () => "token",
      fetch: async () =>
        jsonResponse(200, {
          name: "accounts/123456/products/product",
          productStatus: {
            destinationStatuses: [{ reportingContext: "FREE_LISTINGS", approvedCountries: ["US"] }],
            itemLevelIssues: [
              {
                code: "invalid_gtin",
                severity: "DISAPPROVED",
                resolution: "merchant_action",
                attribute: "gtins",
                reportingContext: "FREE_LISTINGS",
                description: "Invalid GTIN",
                detail: "The value provided for the gtin attribute is not a valid GTIN.",
                documentation: "https://support.google.com/merchants/answer/6324461",
                applicableCountries: ["US"],
              },
            ],
          },
        }),
    });

    const result = await client.getProcessedProductStatus("cs-listing-lst_123");

    expect(result).toMatchObject({
      status: "success",
      operation: "get-processed-product",
      diagnostics: {
        productName: "accounts/[account]/products/product",
        issues: [{ code: "invalid_gtin", severity: "DISAPPROVED", applicableCountries: ["US"] }],
      },
    });
  });

  it("serializes dry-run processed-product diagnostics without requesting credentials", async () => {
    const fetchMock = vi.fn<TestFetch>();
    const tokenProvider = vi.fn(async () => "token");
    const client = createGoogleMerchantApiClient({
      config: { ...enabledConfig, dryRun: true },
      accessTokenProvider: tokenProvider,
      fetch: fetchMock,
    });

    const result = await client.getProcessedProductStatus("cs-listing-lst_123");

    expect(result).toMatchObject({
      status: "dry-run",
      operation: "get-processed-product",
      attempts: 0,
      request: {
        method: "GET",
        operation: "get-processed-product",
      },
    });
    expect(result.request.url).toContain("accounts/[account]/products/");
    expect("body" in result.request).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokenProvider).not.toHaveBeenCalled();
  });
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status >= 400 ? "Provider error" : "OK",
    headers: { "content-type": "application/json", "x-request-id": "req_123" },
  });
}
