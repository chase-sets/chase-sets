// @vitest-environment jsdom

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GuestCheckoutConceptPage } from "./guest-checkout-concept-page";

describe("guest checkout concept page", () => {
  it("renders the replacement concept with a Shopify-simple checkout hierarchy", () => {
    const markup = renderToString(<GuestCheckoutConceptPage />);

    expect(markup).toContain("Fresh-state checkout concept");
    expect(markup).toContain("Order summary");
    expect(markup).toContain("Express checkout");
    expect(markup).toContain("Contact");
    expect(markup).toContain("Delivery");
    expect(markup).toContain("Shipping method");
    expect(markup).toContain("Payment");
    expect(markup).toContain("Youth LS Tee - Embroidered Front + Printed Back");
    expect(markup).toContain("Play Mat");
    expect(markup).toContain("Bubble-free stickers");
    expect(markup).toContain("Adult Tee - Embroidered Front");
    expect(markup).toContain("$60.60");
    expect(markup).toContain("Pay now");
    expect(markup).toContain("Back to buy cart");
    expect(markup).toContain("Exit guest checkout");
    expect(markup).toContain("Buy Cart");
  });

  it("keeps readiness, recovery, and post-confirmation states out of dense checkout panels", () => {
    const markup = renderToString(<GuestCheckoutConceptPage />);

    expect(markup).toContain("Fulfillment assigned before checkout");
    expect(markup).toContain("Save $4.20 by changing fulfillment");
    expect(markup).toContain("Optional savings are offered before checkout.");
    expect(markup).toContain("Address needs attention");
    expect(markup).toContain("Totals changed");
    expect(markup).toContain("Checkout is on risk hold");
    expect(markup).toContain("Reconciliation pending");
    expect(markup).toContain("Session expired");
    expect(markup).toContain("Signed-in saved details");
    expect(markup).toContain("Order received");
    expect(markup).toContain("Final totals are shown before payment.");
    expect(markup).not.toContain("Seller allocation");
    expect(markup).not.toContain("marketplace-engine");
    expect(markup).not.toContain("Recalculate fulfillment");
  });
});
