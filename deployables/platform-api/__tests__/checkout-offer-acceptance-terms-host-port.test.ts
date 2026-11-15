import { describe, expect, it, vi } from "vitest";
import type { CheckoutOfferAcceptanceTermsSource } from "@chase-sets/checkout/server";
import type { MarketplaceServices } from "@chase-sets/marketplace/server";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createMarketplaceOfferAcceptanceTermsSource, createPlatformApiHost } from "../src/app";
import { apiContextRegistry } from "../src/context-registry";

const captured = vi.hoisted(() => ({ ports: undefined as Readonly<Record<string, unknown>> | undefined }));

vi.mock("@chase-sets/platform-runtime/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chase-sets/platform-runtime/api")>();
  return {
    ...actual,
    createApiHost: (...args: Parameters<typeof actual.createApiHost>) => {
      captured.ports = args[2].hostPorts;
      return actual.createApiHost(...args);
    },
  };
});

vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => {
  const { createInMemoryEventStore } = await import("@chase-sets/event-core/test-support");
  return {
    ...(await importOriginal<typeof import("@chase-sets/event-core-postgres")>()),
    createPostgresEventStore: () => createInMemoryEventStore().eventStore,
  };
});

const request = { offerId: "off_managed", sellerAccountId: "acc_seller", listingId: "lst_seller" } as const;
const acceptanceTerms = {
  account_type: "personal",
  basis_amount: "135.00",
  marketplace_sales_fee_unit_amount: "6.75",
  seller_net_unit_amount: "128.25",
  marketplace_sales_fee_percentage_bps: 500,
  marketplace_sales_fee_fixed_amount: "0.00",
  marketplace_sales_fee_cap_amount: null,
  shipping_allowance_percentage_bps: 500,
  schedule_id: "sch_standard",
  agreement_id: null,
  resolved_at: "2026-11-13T00:00:00.000Z",
  fee_quote_fingerprint: "managed acceptance fingerprint",
} as const;

describe("Checkout Offer acceptance terms host port", () => {
  it("reads Marketplace's acceptance terms for the exact Offer, seller and Listing", async () => {
    const previewOfferAcceptanceTerms = vi.fn(async () => acceptanceTerms);
    const source = createMarketplaceOfferAcceptanceTermsSource(
      () => ({ offers: { previewOfferAcceptanceTerms } }) as unknown as MarketplaceServices,
    );

    await expect(source.previewOfferAcceptanceTerms(request)).resolves.toBe(acceptanceTerms);
    expect(previewOfferAcceptanceTerms).toHaveBeenCalledWith(request);
  });

  it("refuses when Marketplace is not composed on the host", async () => {
    const source = createMarketplaceOfferAcceptanceTermsSource(() => undefined);

    await expect(source.previewOfferAcceptanceTerms(request)).rejects.toThrow(
      "Marketplace Offer acceptance terms are unavailable.",
    );
  });

  it("hands Checkout the port backed by the hosted Marketplace Offer service", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query, connect: async () => ({ query, release: () => {} }) };
    const runtime = createPlatformApiHost({
      pools: Object.fromEntries(apiContextRegistry.map((entry) => [entry.contextName, pool])),
      runtimeProfile: "public",
      hostPorts: {
        capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
        processorGateway: createFakePaymentProcessorGateway(),
      },
    });
    const source = captured.ports?.offerAcceptanceTermsSource as CheckoutOfferAcceptanceTermsSource | undefined;
    const marketplace = runtime.services.marketplace as MarketplaceServices;
    const preview = vi.spyOn(marketplace.offers, "previewOfferAcceptanceTerms").mockResolvedValue(acceptanceTerms);

    expect(source).toBeDefined();
    await expect(source!.previewOfferAcceptanceTerms(request)).resolves.toBe(acceptanceTerms);
    expect(preview).toHaveBeenCalledWith(request);
  });
});
