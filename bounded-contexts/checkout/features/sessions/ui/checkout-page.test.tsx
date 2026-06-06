// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CheckoutFulfillmentPreview } from "../../../support/request-support/api-client";
import type { CheckoutSessionRow } from "../../../support/request-support/api-client";
import { CheckoutSessionPage } from "./checkout-page";

const session: CheckoutSessionRow = {
  session_id: "chk_mixed",
  buyer_account_id: "acc_buyer",
  source_type: "cart",
  optimization_goal: "lowest-total",
  fulfillment_preview_revision: "rev_1",
  shipping_option: "standard",
  shipping_address_id: null,
  shipping_address: null,
  lines: [
    {
      listingId: null,
      cartLineId: "cli_opt",
      catalogItemId: "cat_charizard",
      productId: "prod_charizard_nm",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set",
      selectedOptions: [],
      productSummary: "Form: Raw | Condition: Near Mint",
      quantity: 1,
      fulfillmentMode: "optimize",
      lockedListingId: null,
      sellerPreferenceId: null,
      availabilityState: "available",
    },
    {
      listingId: null,
      cartLineId: "cli_locked",
      catalogItemId: "cat_blastoise",
      productId: "prod_blastoise_nm",
      itemTitle: "Blastoise",
      itemSubtitle: "Base Set",
      selectedOptions: [],
      productSummary: "Form: Raw | Condition: Near Mint",
      quantity: 1,
      fulfillmentMode: "locked-listing",
      lockedListingId: "lst_card_vault_blastoise",
      sellerPreferenceId: null,
      availabilityState: "available",
    },
    {
      listingId: null,
      cartLineId: "cli_waiting",
      catalogItemId: "cat_bulbasaur",
      productId: "prod_bulbasaur_raw",
      itemTitle: "Bulbasaur",
      itemSubtitle: "Base Set",
      selectedOptions: [],
      productSummary: "Form: Raw",
      quantity: 1,
      fulfillmentMode: "optimize",
      lockedListingId: null,
      sellerPreferenceId: null,
      availabilityState: "waiting-for-supply",
    },
  ],
  order_ids: [],
  payment_id: null,
  submitted_offer_id: null,
  created_at: "2026-05-06T00:00:00.000Z",
  updated_at: "2026-05-06T00:00:00.000Z",
};

const fulfillmentPreview: CheckoutFulfillmentPreview = {
  revision: "rev_1",
  optimizationGoal: "lowest-total",
  readyLineKeys: ["cli_opt", "cli_locked"],
  unavailableLineKeys: ["cli_waiting"],
  sellerGroups: [
    {
      sellerAccountId: "acc_card_vault",
      sellerDisplayName: "Card Vault",
      itemSubtotalAmount: "489.00",
      shippingChargeAmount: "0.00",
      salesTaxAmount: "0.00",
      totalAmount: "489.00",
      deliveryEstimate: {
        earliestDate: "2026-05-03",
        latestDate: "2026-05-06",
        minimumTransitDays: 5,
        maximumTransitDays: 8,
        handlingDays: 1,
        packageCount: 1,
        shipFromRegion: "Chicago, IL",
        serviceLevel: "standard parcel",
        promiseOwner: "fulfillment",
        promiseSource: "fulfillment-promise-policy",
        promiseConfidence: "estimated",
        cutoffTimeLocal: "16:00",
        packingStartDate: "2026-05-01",
        carrierHandoffDate: "2026-05-02",
        basis: "1 package from Chicago, IL; 1 seller handling day plus 5-8 transit days.",
      },
      lines: [
        {
          lineKey: "cli_opt",
          listingId: "lst_card_vault_charizard",
          catalogItemId: "cat_charizard",
          productId: "prod_charizard_nm",
          itemTitle: "Charizard",
          productSummary: "Form: Raw | Condition: Near Mint",
          quantity: 1,
          estimatedUnitPriceAmount: "389.00",
          estimatedLineTotalAmount: "389.00",
          priceState: "available",
          materialChangeReasons: [],
        },
        {
          lineKey: "cli_locked",
          listingId: "lst_card_vault_blastoise",
          catalogItemId: "cat_blastoise",
          productId: "prod_blastoise_nm",
          itemTitle: "Blastoise",
          productSummary: "Form: Raw | Condition: Near Mint",
          quantity: 1,
          estimatedUnitPriceAmount: "100.00",
          estimatedLineTotalAmount: "100.00",
          priceState: "locked",
          materialChangeReasons: [],
        },
      ],
    },
  ],
  totals: {
    itemSubtotalAmount: "489.00",
    shippingAmount: "0.00",
    salesTaxAmount: "0.00",
    totalAmount: "489.00",
    packageCount: 1,
  },
  unavailableLines: [
    {
      lineKey: "cli_waiting",
      catalogItemId: "cat_bulbasaur",
      productId: "prod_bulbasaur_raw",
      itemTitle: "Bulbasaur",
      productSummary: "Form: Raw",
      quantity: 1,
      reason: "No active supply can fulfill this product.",
    },
  ],
  materialChangeReasons: [],
};

const paymentPreview = {
  currency_code: "usd",
  amount: "489.00",
  marketplace_checkout_fee: {
    marketplace_checkout_fee_amount: "14.67",
    marketplace_checkout_fee_reduction_amount: "0.00",
    total_amount: "503.67",
    processor_amount: "503.67",
    quote_fingerprint: "quote_1",
  },
  payment_method_quotes: [
    {
      payment_method_category: "card" as const,
      marketplace_checkout_fee_amount: "14.67",
      total_amount: "503.67",
    },
  ],
  wallet_credit: {
    requested_amount: "0.00",
    applied_amount: "0.00",
    external_amount: "503.67",
  },
};

const savedAddress = {
  shipping_address_id: "adr_home",
  label: "Home",
  recipient_name: "Jane Smith",
  company: null,
  line1: "100 Market Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postal_code: "60601",
  country: "US",
  phone: null,
  email: null,
  is_default: true,
};

describe("checkout session page", () => {
  it("renders mixed optimized, locked, and unavailable fulfillment without leaking internal ids", () => {
    const markup = renderToString(<CheckoutSessionPage session={session} fulfillmentPreview={fulfillmentPreview} />);

    expect(markup).toContain("Recalculate fulfillment");
    expect(markup).toContain("Card Vault");
    expect(markup).toContain("Optimized seller listing");
    expect(markup).toContain("Selected seller listing");
    expect(markup).toContain("Needs supply");
    expect(markup).toContain("Make offer");
    expect(markup).toContain("Product intent saved for live fulfillment preview");
    expect(markup).toContain("Marketplace checkout fee");
    expect(markup).toContain("Reviewed before payment");
    expect(markup).toContain("Refresh totals");
    expect(markup).toContain("Delivery estimate");
    expect(markup).toContain("Payment review comes next");
    expect(markup).not.toContain("lst_card_vault");
    expect(markup).not.toContain("cat_bulbasaur");
    expect(markup).not.toContain("acc_card_vault");
  });

  it("renders purchase intent checkout without payment controls or purchase-creation copy", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={{
          ...session,
          session_id: "chk_offer_intent",
          source_type: "offer-intent",
          fulfillment_preview_revision: null,
          lines: [
            {
              ...session.lines[0],
              cartLineId: null,
              offerPriceAmount: "350.00",
              availabilityState: "waiting-for-supply",
            },
          ],
        }}
        fulfillmentPreview={null}
      />,
    );

    expect(markup).toContain("Place purchase intent");
    expect(markup).toContain("Ready to place purchase intent");
    expect(markup).toContain("No payment today");
    expect(markup).toContain("Sellers can accept your purchase intent");
    expect(markup).toContain("Destination is required so a seller knows where the purchase intent would ship");
    expect(markup).not.toContain("Secure Payment");
    expect(markup).not.toContain("Payment method");
    expect(markup).not.toContain("Live fulfillment preview");
    expect(markup).not.toContain("Destination is required before purchases are created");
  });

  it("renders saved shipping address selection with explicit address-book actions", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={session}
        fulfillmentPreview={fulfillmentPreview}
        canManageShippingAddresses
        savedShippingAddresses={[savedAddress]}
      />,
    );

    expect(markup).toContain("Saved shipping address");
    expect(markup).toContain("Home (default)");
    expect(markup).toContain("Address book action");
    expect(markup).toContain("Use for this checkout only");
    expect(markup).toContain("Save as new address");
  });

  it("uses the one-page saved-payment CTA only for off-session saved instruments", () => {
    const acceleratedMarkup = renderToString(
      <CheckoutSessionPage
        session={session}
        fulfillmentPreview={fulfillmentPreview}
        paymentPreview={paymentPreview}
        savedShippingAddresses={[savedAddress]}
        savedCheckoutInstruments={[
          {
            instrument_id: "pmi_card",
            payment_method_category: "card",
            provider: "stripe",
            display_label: "Visa ending in 4242",
            confirmation_experience: "off-session-token",
            is_default: true,
            readiness: "ready",
          },
        ]}
      />,
    );
    const providerStepMarkup = renderToString(
      <CheckoutSessionPage
        session={session}
        fulfillmentPreview={fulfillmentPreview}
        paymentPreview={paymentPreview}
        savedShippingAddresses={[savedAddress]}
        savedCheckoutInstruments={[
          {
            instrument_id: "pmi_bank",
            payment_method_category: "bank-account",
            provider: "stripe",
            display_label: "Bank account",
            confirmation_experience: "trusted-payment-step",
            is_default: true,
            readiness: "ready",
          },
        ]}
      />,
    );

    expect(acceleratedMarkup).toContain("Fast checkout ready");
    expect(acceleratedMarkup).toContain("Place order with Visa ending in 4242");
    expect(providerStepMarkup).toContain("Saved payment ready");
    expect(providerStepMarkup).toContain("secure payment step before authorization");
    expect(providerStepMarkup).toContain("Create purchases and continue to secure payment");
    expect(providerStepMarkup).not.toContain("Place order with Bank account");
  });

  it("marks totals stale without submitting when checkout fields change or blur", () => {
    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => undefined);

    render(
      <CheckoutSessionPage session={session} fulfillmentPreview={fulfillmentPreview} paymentPreview={paymentPreview} />,
    );

    fireEvent.change(screen.getByLabelText(/Recipient name/), { target: { value: "Jamie Buyer" } });
    fireEvent.blur(screen.getByLabelText(/Recipient name/));
    fireEvent.change(screen.getByLabelText(/Shipping option/), { target: { value: "expedited" } });

    expect(requestSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Totals need refresh")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Refresh totals" }).length).toBeGreaterThan(0);

    requestSubmit.mockRestore();
  });
});
