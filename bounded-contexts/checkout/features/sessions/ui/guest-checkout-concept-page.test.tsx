// @vitest-environment jsdom

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GuestCheckoutConceptPage } from "./guest-checkout-concept-page";

describe("guest checkout concept page", () => {
  it("renders the replacement concept with a stepped guest checkout flow", () => {
    const markup = renderToString(<GuestCheckoutConceptPage />);

    expect(markup).toContain("Ready to place order");
    expect(markup).toContain("Guest checkout");
    expect(markup).toContain("Review");
    expect(markup).toContain("Shipping");
    expect(markup).toContain("Payment");
    expect(markup).toContain("Place order");
    expect(markup).toContain("Acerola&#x27;s Mischief");
    expect(markup).toContain("Raw - Damaged");
    expect(markup).toContain("Card Vault");
    expect(markup).toContain("Ships Jun 16-19");
    expect(markup).toContain("Shipping address");
    expect(markup).toContain("Payment method");
    expect(markup).toContain("Order protection");
    expect(markup).toContain("$27.29");
    expect(markup).toContain("Create purchases and continue to secure payment");
    expect(markup).toContain("Back to buy cart");
    expect(markup).toContain("Exit guest checkout");
    expect(markup).toContain("Buy Cart");
  });

  it("keeps payment trust and fulfillment reassurance visible before the primary action", () => {
    const markup = renderToString(<GuestCheckoutConceptPage />);

    expect(markup).toContain("Live price preview");
    expect(markup).toContain("Locked seller");
    expect(markup).toContain("Secure payment");
    expect(markup).toContain("Final totals are shown before payment.");
    expect(markup).toContain("Payment starts only after purchases are created for secure payment.");
  });
});
