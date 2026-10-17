import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { sourceFromUrl } from "../../../support/route-support/buy-checkout-readiness/checkout-start-source";
import { CheckoutStartSourceFields, CheckoutStartSourceSummary, CheckoutStartSummary } from "./checkout-start-summary";

function buyNowSource(priceCurrencyCode?: string) {
  const url = new URL("http://localhost/checkout/buy/readiness");
  url.search = new URLSearchParams({
    source: "buy-now",
    listingId: "lst_synthetic_eur",
    fulfillmentMode: "locked-listing",
    lockedListingId: "lst_synthetic_eur",
    catalogItemId: "cat_synthetic",
    productId: "prod_synthetic",
    itemTitle: "Synthetic EUR listing",
    selectedOptions: "[]",
    quantity: "1",
    priceAmount: "20.00",
    ...(priceCurrencyCode ? { priceCurrencyCode } : {}),
  }).toString();

  const source = sourceFromUrl(url);
  expect(source?.type).toBe("buy-now");
  if (!source || source.type !== "buy-now") {
    throw new Error("Synthetic buy-now source was not parsed.");
  }
  return source;
}

function renderedPriceSummaries(source: ReturnType<typeof buyNowSource>) {
  const intent = renderToStaticMarkup(<CheckoutStartSourceSummary source={source} />);
  const breakdown = renderToStaticMarkup(
    <CheckoutStartSummary
      source={source}
      cartCount={1}
      isSignedIn={false}
      isGuestBuyer={false}
      isOfferIntent={false}
      checkoutStatus="Ready"
    />,
  );
  return `${intent}\n${breakdown}`;
}

describe("Checkout buy-now source money", () => {
  it("parses, serializes, and renders a complete EUR Listing price pair without relabeling it as USD", () => {
    const source = buyNowSource("EUR");

    expect(source).toMatchObject({ priceAmount: "20.00", priceCurrencyCode: "EUR" });
    const summaries = renderedPriceSummaries(source);
    expect(summaries).toContain("€20.00");
    expect(summaries).not.toContain("$20.00");

    const fields = renderToStaticMarkup(
      <CheckoutStartSourceFields source={source} entryAttemptKey="chkentry_synthetic" />,
    );
    expect(fields).toContain('name="priceCurrencyCode"');
    expect(fields).toContain('value="EUR"');
  });

  it("renders the existing unavailable copy for an incomplete legacy Listing price pair", () => {
    const summaries = renderedPriceSummaries(buyNowSource());

    expect(summaries.match(/Price confirmed before payment/g)).toHaveLength(2);
    expect(summaries).not.toContain("$20.00");
  });

  it("preserves the current USD buy-now display", () => {
    expect(renderedPriceSummaries(buyNowSource("USD"))).toContain("$20.00");
  });
});
