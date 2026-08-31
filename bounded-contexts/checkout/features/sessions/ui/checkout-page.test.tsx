// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckoutFulfillmentPreview } from "../../../support/request-support/api-client";
import type { CheckoutSessionRow } from "../../../support/request-support/api-client";

import { CheckoutSessionPage } from "./checkout-page";

afterEach(() => {
  cleanup();
});

const session: CheckoutSessionRow = {
  session_id: "chk_mixed",
  buyer_account_id: "acc_buyer",
  source_type: "cart",
  optimization_goal: "lowest-total",
  fulfillment_preview_revision: "rev_1",
  fulfillment_preview_snapshot: null,
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
  order_write_commit_positions: [],
  checkout_reservations: [],
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
      postageRequirements: {
        policyVersion: "operator-postage-v1",
        parcelRequired: true,
        parcelReasons: ["declared-value-requires-parcel"],
        signatureRequired: true,
        signatureReasons: ["declared-value-requires-signature"],
        insuranceRequired: false,
        insuranceReasons: [],
        insuredValueAmount: null,
        shippingEvidenceTier: "signature-confirmed",
      },
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
          sellerAccountId: "acc_card_vault",
          inventoryItemId: "inv_charizard",
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
          sellerAccountId: "acc_card_vault",
          inventoryItemId: "inv_blastoise",
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

const readySession: CheckoutSessionRow = {
  ...session,
  lines: session.lines.slice(0, 2),
};

const readyFulfillmentPreview: CheckoutFulfillmentPreview = {
  ...fulfillmentPreview,
  unavailableLineKeys: [],
  unavailableLines: [],
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

const paymentPreviewWithBank = {
  ...paymentPreview,
  payment_method_quotes: [
    ...paymentPreview.payment_method_quotes,
    {
      payment_method_category: "bank-account" as const,
      marketplace_checkout_fee_amount: "2.45",
      total_amount: "491.45",
    },
  ],
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

const signedInSavedAddress = {
  ...savedAddress,
  recipient_name: "Jane Smith",
  phone: "312-555-0199",
  email: "jane@example.com",
};

const savedCard = {
  instrument_id: "pmi_card",
  payment_method_category: "card" as const,
  provider: "stripe",
  display_label: "Visa ending in 4242",
  confirmation_experience: "off-session-token" as const,
  is_default: true,
  readiness: "ready" as const,
};

function countText(markup: string, text: string) {
  return markup.split(text).length - 1;
}

function expectTintedSurface(root: Element | null, label: string) {
  expect(root, `${label} root`).not.toBeNull();
  const tokens = new Set((root as HTMLElement).className.split(/\s+/));
  expect(tokens.has("bg-surface-2"), `${label} includes bg-surface-2`).toBe(true);
  for (const excluded of ["surface-border", "ds-glass", "border", "shadow-tokenSm", "shadow-tokenLg", "ds-glow"])
    expect(tokens.has(excluded), `${label} excludes ${excluded}`).toBe(false);
}

describe("checkout session page", () => {
  it("renders all four checkout form sections as tinted furniture", () => {
    const { container } = render(<CheckoutSessionPage session={session} fulfillmentPreview={fulfillmentPreview} />);

    const rootForField = (name: string) =>
      container.querySelector(`[name="${name}"]`)?.closest(".rounded-tokenLg") ?? null;
    expectTintedSurface(rootForField("shippingEmail"), "contact form section");
    expectTintedSurface(rootForField("shippingName"), "delivery form section");
    expectTintedSurface(rootForField("shippingOption"), "shipping form section");
    expectTintedSurface(rootForField("previewPaymentMethodCategory"), "payment form section");
  });

  it("renders simple checkout and keeps unavailable fulfillment in cart review", () => {
    const markup = renderToString(<CheckoutSessionPage session={session} fulfillmentPreview={fulfillmentPreview} />);

    expect(markup).toContain("Contact");
    expect(markup).toContain("Delivery");
    expect(markup).toContain("Shipping method");
    expect(markup).toContain("Payment");
    expect(markup).toContain("Order summary");
    expect(markup).toContain('href="/help/buying/order-protection"');
    expect(markup).toContain("Read Order Protection terms");
    expect(markup).toContain("Review your buy cart first");
    expect(markup).toContain("Review buy cart");
    expect(markup).toContain("Checkout service fee");
    expect(markup).toContain("Delivery estimate");
    expect(markup).toContain("Payment review comes next");
    expect(markup).toContain("Terms of service");
    expect(markup).toContain('href="/terms"');
    expect(markup).toContain("Privacy policy");
    expect(markup).toContain('href="/privacy"');
    expect(markup).toContain("Refunds and returns");
    expect(markup).toContain('href="/refunds-and-returns"');
    expect(markup).toContain("Guest checkout contact and shipping details are used");
    expect(markup).toContain("Card and wallet details stay in the secure payment step.");
    expect(markup).not.toContain("Recalculate fulfillment");
    expect(markup).not.toContain("Card Vault");
    expect(markup).not.toContain("Optimized seller listing");
    expect(markup).not.toContain("Selected seller listing");
    expect(markup).not.toContain("Make offer");
    expect(markup).not.toContain("Product intent saved for live fulfillment preview");
    expect(markup).not.toContain("Parcel postage");
    expect(markup).not.toContain("Signature confirmation");
    expect(markup).not.toContain("lst_card_vault");
    expect(markup).not.toContain("cat_bulbasaur");
    expect(markup).not.toContain("acc_card_vault");
  });

  it("surfaces checkout reservation failures as line-level cart review", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
        reservationUnavailableLines={[
          {
            lineKey: "cli_locked",
            sellerAccountId: "acc_card_vault",
            inventoryItemId: "inv_blastoise",
            itemTitle: "Blastoise",
            productSummary: "Form: Raw | Condition: Near Mint",
            quantity: 1,
          },
        ]}
      />,
    );

    expect(markup).toContain("Some items are already reserved");
    expect(markup).toContain("Blastoise was just reserved by another buyer.");
    expect(markup).toContain("Review buy cart");
    expect(markup).not.toContain("Pay now");
  });

  it("blocks elapsed checkout reservations with a reserve-again affordance", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={{
          ...readySession,
          checkout_reservations: [
            {
              holdId: "hld_elapsed",
              lineKey: "cli_opt",
              sellerAccountId: "acc_card_vault",
              inventoryItemId: "inv_charizard",
              quantity: 1,
              expiresAt: "2000-01-01T00:00:00.000Z",
              extensionCount: 0,
              status: "active",
            },
          ],
        }}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
      />,
    );

    expect(markup).toContain("Reservation expired");
    expect(markup).toContain("Reserve again");
    expect(markup).toContain('value="confirm-checkout"');
    expect(markup).not.toContain("Pay now");
  });

  it("keeps saved payment affordances signed-in only even when instruments are supplied", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
        savedCheckoutInstruments={[savedCard]}
      />,
    );

    expect(markup).toContain("Payment");
    expect(markup).toContain("Card");
    expect(markup).toContain("Final totals are shown before payment.");
    expect(markup).not.toContain("Visa ending in 4242");
    expect(markup).not.toContain("Saved payment");
    expect(markup).not.toContain('name="savedCheckoutInstrumentId"');
    expect(markup).not.toContain('name="savePaymentMethodForFuture"');
    expect(markup).not.toContain("Pay now with Visa ending in 4242");
  });

  it("keeps saved address affordances signed-in only even when addresses are supplied", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
        canManageShippingAddresses
        savedShippingAddresses={[savedAddress]}
      />,
    );

    expect(markup).toContain("Delivery");
    expect(markup).toContain("Recipient name");
    expect(markup).toContain("Address line 1");
    expect(markup).toContain("Guest checkout contact and shipping details are used");
    expect(markup).not.toContain("Saved shipping address");
    expect(markup).not.toContain("Home (default)");
    expect(markup).not.toContain("Address preferences");
    expect(markup).not.toContain('name="shippingAddressId" value="adr_home"');
    expect(markup).not.toContain('name="addressBookAction"');
  });

  it("uses guest checkout contact without asking for email again", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
        guestCheckoutContact={{
          contactName: "Jane Smith",
          contactEmail: "jane@example.com",
        }}
      />,
    );

    expect(markup).toContain("Checkout details");
    expect(markup).toContain("jane@example.com");
    expect(markup).toContain('name="shippingEmail"');
    expect(markup).toContain('value="jane@example.com"');
    expect(markup).toContain('name="shippingName"');
    expect(markup).toContain('value="Jane Smith"');
    expect(markup).not.toContain('type="email"');
    expect(markup).not.toContain("Email me with news");
    expect(markup).not.toContain("Edit contact");
  });

  it("shows only payment methods supported by the current quote", () => {
    const cardOnlyMarkup = renderToString(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
        selectedPaymentMethodCategory="bank-account"
      />,
    );
    const bankSupportedMarkup = renderToString(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreviewWithBank}
        selectedPaymentMethodCategory="bank-account"
      />,
    );

    expect(cardOnlyMarkup).toContain("Payment method");
    expect(cardOnlyMarkup).toContain("Card or wallet");
    expect(cardOnlyMarkup).toContain('name="paymentMethodCategory" value="card"');
    expect(cardOnlyMarkup).not.toContain("Bank account");
    expect(cardOnlyMarkup).not.toContain('value="bank-account"');
    expect(bankSupportedMarkup).toContain("Bank account");
    expect(bankSupportedMarkup).toContain('name="paymentMethodCategory" value="bank-account"');
  });

  it("keeps signed-in checkout policy links without guest data copy", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
        savedShippingAddresses={[signedInSavedAddress]}
        savedCheckoutInstruments={[savedCard]}
        isSignedInBuyer
      />,
    );

    expect(markup).toContain("Checkout policies");
    expect(markup).toContain("Terms of service");
    expect(markup).toContain("Privacy policy");
    expect(markup).toContain("Refunds and returns");
    expect(markup).not.toContain("Guest checkout contact and shipping details are used");
  });

  it("keeps reviewed address signatures fee-relevant while preserving selected address identity", () => {
    const { container } = render(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
        canManageShippingAddresses
        isSignedInBuyer
        savedShippingAddresses={[signedInSavedAddress]}
      />,
    );

    const reviewedSignature = container.querySelector<HTMLInputElement>(
      'input[name="reviewedShippingAddressSignature"]',
    );
    const selectedAddressId = container.querySelector<HTMLInputElement>('input[name="shippingAddressId"]');

    expect(reviewedSignature).not.toBeNull();
    expect(JSON.parse(reviewedSignature?.value ?? "{}")).toEqual({
      name: "Jane Smith",
      company: "",
      line1: "100 Market Street",
      line2: "",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: "312-555-0199",
      email: "jane@example.com",
    });
    expect(selectedAddressId?.value).toBe("adr_home");
  });

  it("renders buy confirmation references without implying downstream completion", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={{
          ...readySession,
          order_ids: ["ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9"],
          payment_id: "pay_1",
          split_group_handoff: {
            status: "ready",
            supportReference: "CS-CR_READY",
            groups: [
              {
                groupId: "csg_card_vault",
                lineIds: ["cli_opt", "cli_locked"],
                listingIds: ["lst_card_vault_charizard", "lst_card_vault_blastoise"],
                sellerAccountId: "acc_card_vault",
                sellerDisplayName: "Card Vault",
                itemCount: 2,
                packageCount: 1,
                deliveryPromise: "Estimated delivery 5-8 days after purchase",
                shippingAmount: null,
                supportReference: "CSG-CARDVAULT",
                downstreamReferenceStatus: "not-started",
              },
            ],
          },
        }}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
      />,
    );

    expect(markup).toContain("Payment ready");
    expect(markup).toContain("Order reference");
    expect(markup).toContain("ORD-E6K7M8N9");
    expect(markup).toContain("Support reference");
    expect(markup).toContain("CS-CR_READY");
    expect(markup).toContain("Payable total");
    expect(markup).toContain("$503.67");
    expect(markup).toContain("Next steps pending");
    expect(markup).toContain("Continue to secure payment without resubmitting checkout.");
    expect(markup).toContain("Delivery and receipt updates appear after payment is complete.");
    expect(markup).not.toContain("Downstream details pending");
    expect(markup).not.toContain("owning workflows");
    expect(markup).not.toContain("Sale complete");
    expect(markup).not.toContain("Label ready");
    expect(markup).not.toContain("Payout ready");
    expect(markup).not.toContain("provider payload");
    expect(markup).not.toContain("execution receipt");
  });

  it("renders multi-seller buy confirmation as one customer surface with support-safe references", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={{
          ...readySession,
          order_ids: ["ord_01ARZ3NDEKTSV4RRFFQ69G5FAV", "ord_01ARZ3NDEKTSV4RRFFQ69G5FBW"],
          payment_id: "pay_multi_seller",
          split_group_handoff: {
            status: "ready",
            supportReference: "CS-CR_MULTI",
            groups: [
              {
                groupId: "cfg_card_vault",
                lineIds: ["cli_opt"],
                listingIds: ["lst_card_vault_charizard"],
                sellerAccountId: "acc_card_vault",
                sellerDisplayName: "Card Vault",
                itemCount: 1,
                packageCount: 1,
                deliveryPromise: "Estimated delivery 5-8 days after purchase",
                shippingAmount: null,
                supportReference: "CSG-CARDVAULT",
                downstreamReferenceStatus: "not-started",
              },
              {
                groupId: "cfg_second_seller",
                lineIds: ["cli_locked"],
                listingIds: ["lst_second_seller_blastoise"],
                sellerAccountId: "acc_second_seller",
                sellerDisplayName: "Second Seller",
                itemCount: 1,
                packageCount: 1,
                deliveryPromise: "Estimated delivery 4-7 days after purchase",
                shippingAmount: null,
                supportReference: "CSG-SECONDSELLER",
                downstreamReferenceStatus: "not-started",
              },
            ],
          },
        }}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
      />,
    );

    expect(countText(markup, "Order reference")).toBe(1);
    expect(markup).toContain("Support reference");
    expect(markup).toContain("ORD-Q69G5FAV, ORD-Q69G5FBW");
    expect(markup).toContain("CS-CR_MULTI");
    expect(markup).toContain("Next steps pending");
    expect(markup).toContain("Continue to secure payment without resubmitting checkout.");
    expect(markup).not.toContain("Downstream details pending");
    expect(markup).not.toContain("Pay Card Vault");
    expect(markup).not.toContain("Pay Second Seller");
    expect(markup).not.toContain("allocation");
    expect(markup).not.toContain("regroup");
    expect(markup).not.toContain("provider payload");
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

    expect(markup).toContain("Submit offer");
    expect(markup).toContain("No payment today");
    expect(markup).toContain("Sellers can accept your offer");
    expect(markup).toContain("Delivery address is required so sellers know where the offer would ship");
    expect(markup).not.toContain("Secure Payment");
    expect(markup).not.toContain("Payment method");
    expect(markup).not.toContain("Live fulfillment preview");
    expect(markup).not.toContain("Destination is required before purchases are created");
    // #1933: the summary total reads "No payment today"; the caption beneath it
    // must carry the distinct reassurance, never repeat the total verbatim. The
    // caption paragraph uses the `text-tertiary` recipe, so a tertiary caption
    // echoing the total value would be the regressed duplicate.
    expect(markup).not.toContain('text-tertiary">No payment today');
    expect(markup).toContain("Sellers can accept your offer before an order and payment are created.");
  });

  it("keeps purchase intent submission on confirm checkout after destination edits", () => {
    render(
      <CheckoutSessionPage
        session={{
          ...session,
          session_id: "chk_offer_intent_refresh_guard",
          source_type: "offer-intent",
          fulfillment_preview_revision: null,
          lines: [{ ...session.lines[0], cartLineId: null, offerPriceAmount: "350.00" }],
        }}
        fulfillmentPreview={null}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Recipient name/), { target: { value: "Jamie Buyer" } });

    const primaryActions = screen.getAllByRole("button", { name: "Submit offer" });
    expect(primaryActions.length).toBeGreaterThan(0);
    expect(primaryActions.every((button) => (button as HTMLButtonElement).value === "confirm-checkout")).toBe(true);
    expect(primaryActions.some((button) => (button as HTMLButtonElement).value === "refresh-checkout-preview")).toBe(
      false,
    );
  });

  it("renders saved shipping address selection with explicit address preferences", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={session}
        fulfillmentPreview={fulfillmentPreview}
        isSignedInBuyer
        canManageShippingAddresses
        savedShippingAddresses={[savedAddress]}
        initialEditSection="delivery"
      />,
    );

    expect(markup).toContain("Saved shipping address");
    expect(markup).toContain("Home (default)");
    expect(markup).toContain("Address preferences");
    expect(markup).toContain("Use once for this checkout");
    expect(markup).toContain("Save as new address");
  });

  it("uses the one-page saved-payment CTA only for off-session saved instruments", () => {
    const acceleratedMarkup = renderToString(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
        isSignedInBuyer
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
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreviewWithBank}
        isSignedInBuyer
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

    expect(acceleratedMarkup).toContain("Checkout details");
    expect(acceleratedMarkup).toContain("Visa ending in 4242");
    expect(acceleratedMarkup).toContain("Ready for secure one-step payment.");
    expect(acceleratedMarkup).toContain("Pay now with Visa ending in 4242");
    expect(acceleratedMarkup).not.toContain("Fast checkout ready");
    expect(providerStepMarkup).toContain("Checkout details");
    expect(providerStepMarkup).toContain("Bank account");
    expect(providerStepMarkup).toContain("secure payment step before authorization");
    expect(providerStepMarkup).toContain("Pay now");
    expect(providerStepMarkup).not.toContain("Saved payment ready");
    expect(providerStepMarkup).not.toContain("Pay now with Bank account");
  });

  it("renders signed-in saved checkout rows and preserves collapsed checkout fields", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
        isSignedInBuyer
        canManageShippingAddresses
        canSavePaymentMethods
        savedShippingAddresses={[signedInSavedAddress]}
        savedCheckoutInstruments={[savedCard]}
      />,
    );

    expect(markup).toContain("Checkout details");
    expect(markup).toContain("jane@example.com");
    expect(markup).toContain("Receipt and delivery updates / 312-555-0199");
    expect(markup).toContain("Ship to");
    expect(markup).toContain("100 Market Street, Chicago, IL 60601, US");
    expect(markup).toContain("Standard insured");
    expect(markup).toContain("Visa ending in 4242");
    expect(markup).toContain("Ready for secure one-step payment.");
    expect(markup).toContain("Pay now with Visa ending in 4242");
    expect(markup).toContain('name="shippingEmail"');
    expect(markup).toContain('value="jane@example.com"');
    expect(markup).toContain('name="savedCheckoutInstrumentId"');
    expect(markup).not.toContain("Fast checkout ready");
    expect(markup).not.toContain("Saved shipping address");
    expect(markup).not.toContain("Recipient name");
    expect(markup).not.toContain("Payment method");
    expect(markup).not.toContain("Recalculate fulfillment");
    expect(markup).not.toContain("Optimized seller listing");
  });

  it("renders focused signed-in edit sections from saved checkout rows", () => {
    const { unmount } = render(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
        isSignedInBuyer
        canManageShippingAddresses
        canSavePaymentMethods
        savedShippingAddresses={[signedInSavedAddress]}
        savedCheckoutInstruments={[savedCard]}
        initialEditSection="contact"
      />,
    );

    expect(screen.getByText("Email")).toBeTruthy();
    expect(screen.queryByText("Recipient name")).toBeNull();

    unmount();

    const secondRender = render(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
        isSignedInBuyer
        canManageShippingAddresses
        canSavePaymentMethods
        savedShippingAddresses={[signedInSavedAddress]}
        savedCheckoutInstruments={[savedCard]}
        initialEditSection="delivery"
      />,
    );

    expect(screen.getByText("Recipient name")).toBeTruthy();
    expect(screen.queryByText("Email")).toBeNull();

    secondRender.unmount();
  });

  it("falls back to the delivery form when the saved shipping address is incomplete", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
        isSignedInBuyer
        savedShippingAddresses={[
          {
            ...signedInSavedAddress,
            line1: "",
          },
        ]}
        savedCheckoutInstruments={[savedCard]}
      />,
    );

    expect(markup).toContain("Checkout details");
    expect(markup).toContain("Recipient name");
    expect(markup).toContain("Address line 1");
    expect(markup).not.toContain("100 Market Street, Chicago, IL 60601, US");
  });

  it("renders autofill metadata for every editable shipping field", () => {
    render(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
        isSignedInBuyer
        initialEditSection="delivery"
      />,
    );

    const expectAttribute = (role: "textbox" | "combobox", name: string, attribute: string, value: string) => {
      expect(screen.getByRole(role, { name }).getAttribute(attribute)).toBe(value);
    };

    expectAttribute("textbox", "Recipient name", "autocomplete", "shipping name");
    expectAttribute("textbox", "Company", "autocomplete", "shipping organization");
    expectAttribute("combobox", "Country", "autocomplete", "shipping country");
    expect((screen.getByRole("combobox", { name: "Country" }) as HTMLSelectElement).value).toBe("US");
    expectAttribute("textbox", "Address line 1", "autocomplete", "shipping address-line1");
    expectAttribute("textbox", "Address line 2", "autocomplete", "shipping address-line2");
    expectAttribute("textbox", "City", "autocomplete", "shipping address-level2");
    expectAttribute("textbox", "State", "autocomplete", "shipping address-level1");
    expectAttribute("textbox", "Postal code", "autocomplete", "shipping postal-code");
    expectAttribute("textbox", "Postal code", "inputmode", "numeric");
    expectAttribute("textbox", "Phone", "autocomplete", "shipping tel");
    expectAttribute("textbox", "Phone", "inputmode", "tel");
    expectAttribute("textbox", "Phone", "type", "tel");
  });

  it("keeps signed-in saved payment customer-safe when payment totals must be refreshed", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={null}
        isSignedInBuyer
        savedShippingAddresses={[signedInSavedAddress]}
        savedCheckoutInstruments={[savedCard]}
      />,
    );

    expect(markup).toContain("Visa ending in 4242");
    expect(markup).toContain("Review required");
    expect(markup).toContain("Update totals");
    expect(markup).not.toContain("provider payload");
    expect(markup).not.toContain("allocation");
  });

  it("renders customer-safe provider or risk holds without leaking internal checkout terms", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
        errorMessage="Payment review is paused until account review clears."
        isSignedInBuyer
        savedShippingAddresses={[signedInSavedAddress]}
        savedCheckoutInstruments={[savedCard]}
      />,
    );

    expect(markup).toContain("Checkout issue");
    expect(markup).toContain("Payment review is paused until account review clears.");
    expect(markup).not.toContain("provider payload");
    expect(markup).not.toContain("read model");
    expect(markup).not.toContain("allocation");
  });

  it("surfaces changed economics as review refresh without internal allocation copy", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={{
          ...readyFulfillmentPreview,
          materialChangeReasons: ["Fees changed. Review latest total."],
        }}
        paymentPreview={paymentPreview}
        isSignedInBuyer
        savedShippingAddresses={[signedInSavedAddress]}
        savedCheckoutInstruments={[savedCard]}
      />,
    );

    expect(markup).toContain("Fulfillment changed since your last preview");
    expect(markup).toContain("Fees changed. Review latest total.");
    expect(markup).not.toContain("Selected seller listing");
    expect(markup).not.toContain("provider payload");
  });

  it("acknowledges a visibly refreshed fulfillment preview even when no line reason is present", () => {
    const { container } = render(
      <CheckoutSessionPage
        session={{
          ...readySession,
          fulfillment_preview_revision: "fulfillment_rev_stored",
        }}
        fulfillmentPreview={{
          ...readyFulfillmentPreview,
          revision: "fulfillment_rev_visible",
          materialChangeReasons: [],
        }}
        paymentPreview={paymentPreview}
        isSignedInBuyer
        savedShippingAddresses={[signedInSavedAddress]}
        savedCheckoutInstruments={[savedCard]}
      />,
    );

    expect(screen.getByText("Fulfillment changed since your last preview")).toBeTruthy();
    expect(screen.getByText("Review the latest checkout preview before continuing.")).toBeTruthy();
    expect(container.querySelector<HTMLInputElement>("input[name='acknowledgedMaterialChanges']")?.value).toBe("true");
  });

  it("does not acknowledge fulfillment changes when the visible preview still matches the recorded review", () => {
    const { container } = render(
      <CheckoutSessionPage
        session={{
          ...readySession,
          fulfillment_preview_revision: "fulfillment_rev_current",
        }}
        fulfillmentPreview={{
          ...readyFulfillmentPreview,
          revision: "fulfillment_rev_current",
          materialChangeReasons: [],
        }}
        paymentPreview={paymentPreview}
        isSignedInBuyer
        savedShippingAddresses={[signedInSavedAddress]}
        savedCheckoutInstruments={[savedCard]}
      />,
    );

    expect(screen.queryByText("Fulfillment changed since your last preview")).toBeNull();
    expect(container.querySelector<HTMLInputElement>("input[name='acknowledgedMaterialChanges']")?.value).toBe("");
  });

  it("marks totals stale without submitting when checkout fields change or blur", () => {
    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => undefined);

    render(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Recipient name/), { target: { value: "Jamie Buyer" } });
    fireEvent.blur(screen.getByLabelText(/Recipient name/));
    fireEvent.change(screen.getByLabelText(/Shipping option/), { target: { value: "expedited" } });

    expect(requestSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Totals need refresh")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Update totals" }).length).toBeGreaterThan(0);

    requestSubmit.mockRestore();
  });

  it("renders the checkout step spine with per-step status", () => {
    const { container } = render(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
        isSignedInBuyer
        savedShippingAddresses={[signedInSavedAddress]}
        savedCheckoutInstruments={[savedCard]}
      />,
    );

    const stepper = container.querySelector("ol");
    expect(stepper).toBeTruthy();
    const steps = Array.from(stepper?.querySelectorAll("li") ?? []).map((step) => step.textContent ?? "");
    expect(steps.some((step) => step.includes("Contact"))).toBe(true);
    expect(steps.some((step) => step.includes("Delivery"))).toBe(true);
    expect(steps.some((step) => step.includes("Shipping"))).toBe(true);
    expect(steps.some((step) => step.includes("Payment"))).toBe(true);
    expect(steps.some((step) => step.includes("Review"))).toBe(true);
    // The fully-collected returning buyer lands on Review as the current step.
    expect(stepper?.querySelector('li[aria-current="step"]')?.textContent).toContain("Review");
  });

  it("drops the payment step from the spine for purchase intent", () => {
    const { container } = render(
      <CheckoutSessionPage
        session={{
          ...session,
          session_id: "chk_offer_intent_steps",
          source_type: "offer-intent",
          fulfillment_preview_revision: null,
          lines: [{ ...session.lines[0], cartLineId: null, offerPriceAmount: "350.00" }],
        }}
        fulfillmentPreview={null}
      />,
    );

    const steps = Array.from(container.querySelectorAll("ol li")).map((step) => step.textContent ?? "");
    expect(steps.some((step) => step.includes("Contact"))).toBe(true);
    expect(steps.some((step) => step.includes("Review"))).toBe(true);
    expect(steps.some((step) => step.includes("How you pay"))).toBe(false);
  });

  it("collapses overlapping checkout states to a single notice", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={session}
        fulfillmentPreview={{
          ...fulfillmentPreview,
          materialChangeReasons: ["Fees changed. Review latest total."],
        }}
        reviewRefreshed
      />,
    );

    // Cart-review (needs-review) outranks the review-updated success notice and
    // the fulfillment-changed notice, so exactly one notice surfaces.
    expect(markup).toContain("Review your buy cart first");
    expect(markup).not.toContain("Review updated");
  });

  it("keeps a single primary action across the in-form and sticky commit", () => {
    const { container } = render(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
      />,
    );

    const primarySlots = Array.from(container.querySelectorAll("[data-primary-action-count]"));
    expect(primarySlots.length).toBeGreaterThan(0);
    for (const slot of primarySlots) {
      expect(slot.getAttribute("data-primary-action-count")).toBe("1");
    }

    // #1934: exactly one primary per viewport. The sticky bar primary targets
    // the form via `form="checkout-confirmation-form"` and lives in a md:hidden
    // (mobile-only) container; the in-form primary submits its enclosing form
    // (no `form` attribute) and must be wrapped to show at md+ only. The two
    // therefore never stack on the same viewport.
    const stickyPrimary = container.querySelector(
      "button[type='submit'][value='confirm-checkout'][form='checkout-confirmation-form']",
    );
    expect(stickyPrimary).not.toBeNull();
    expect(stickyPrimary?.closest(".md\\:hidden")).not.toBeNull();

    const inFormPrimary = container.querySelector("button[type='submit'][value='confirm-checkout']:not([form])");
    expect(inFormPrimary).not.toBeNull();
    expect(inFormPrimary?.closest(".hidden.md\\:block")).not.toBeNull();
  });

  it("prepares payment automatically once checkout reaches a complete quoted payment step", async () => {
    const submitListener = vi.fn((event: SubmitEvent) => event.preventDefault());
    document.addEventListener("submit", submitListener);

    try {
      render(
        <CheckoutSessionPage
          session={{
            ...readySession,
            order_ids: [],
            shipping_address_id: "adr_manual",
            shipping_address: {
              shippingAddressId: "adr_manual",
              name: "Jane Smith",
              company: "",
              line1: "100 Market Street",
              line2: "",
              city: "Chicago",
              state: "IL",
              postalCode: "60601",
              country: "US",
              phone: "312-555-0199",
              email: "jane@example.com",
            },
          }}
          fulfillmentPreview={readyFulfillmentPreview}
          paymentPreview={paymentPreview}
          autoResumePaymentStart
        />,
      );

      await waitFor(() => expect(submitListener).toHaveBeenCalledTimes(1));
      const submitEvent = submitListener.mock.calls[0]?.[0];
      expect((submitEvent?.submitter as HTMLButtonElement | null)?.value).toBe("confirm-checkout");
      const form = document.getElementById("checkout-confirmation-form") as HTMLFormElement | null;
      expect(form).not.toBeNull();
      const formData = new FormData(form!);
      expect(formData.get("marketplaceCheckoutFeeQuoteFingerprint")).toBe("quote_1");
      expect(formData.get("paymentMethodCategory")).toBe("card");
    } finally {
      document.removeEventListener("submit", submitListener);
    }
  });

  it("renders the prepared Payment Element inline instead of a payment-page hop", () => {
    render(
      <CheckoutSessionPage
        session={{ ...readySession, payment_id: "pay_inline_1", order_ids: ["ord_1"] }}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
        preparedPaymentEntry={<div data-testid="inline-payment-element">pay_inline_1</div>}
      />,
    );

    expect(screen.getByTestId("inline-payment-element").textContent).toBe("pay_inline_1");
    expect(screen.queryByRole("link", { name: /continue to payment/i })).toBeNull();
  });

  it("states the deferral once as the summary total caption", () => {
    const markup = renderToString(
      <CheckoutSessionPage
        session={readySession}
        fulfillmentPreview={readyFulfillmentPreview}
        paymentPreview={paymentPreview}
      />,
    );

    // The deferral statement lives only as the total caption — once per
    // responsive summary copy (desktop aside + mobile disclosure), never in a
    // line slot, a subtotal row, and a footer.
    expect(countText(markup, "Final total confirmed before secure payment.")).toBe(2);
    expect(markup).not.toContain("Price at checkout");
  });
});
