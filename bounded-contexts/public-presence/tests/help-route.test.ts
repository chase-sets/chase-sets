import { describe, expect, it } from "vitest";
import { loader as articleLoader } from "../routes/marketplace/help-article";
import { loader as categoryLoader } from "../routes/marketplace/help-category";
import { loader as faqRedirectLoader } from "../routes/marketplace/faq";
import { loader as protectionRedirectLoader } from "../routes/marketplace/order-protection";
import { loader as refundsRedirectLoader } from "../routes/marketplace/refunds-and-returns";

const request = new Request("https://chasesets.com/help");

describe("public help routes", () => {
  it("loads known categories and articles", () => {
    expect(categoryLoader({ request, params: { category: "buying" }, context: {} } as never)).toMatchObject({
      category: "buying",
    });
    expect(
      articleLoader({ request, params: { category: "buying", slug: "order-protection" }, context: {} } as never),
    ).toMatchObject({ article: { title: "Order protection" } });
  });

  it("returns 404 responses for unknown categories and articles", () => {
    expect(() => categoryLoader({ request, params: { category: "missing" }, context: {} } as never)).toThrowError(
      Response,
    );
    expect(() =>
      articleLoader({ request, params: { category: "buying", slug: "missing" }, context: {} } as never),
    ).toThrowError(Response);
  });

  it.each([
    [faqRedirectLoader, "/help/getting-started/frequently-asked-questions"],
    [protectionRedirectLoader, "/help/buying/order-protection"],
    [refundsRedirectLoader, "/help/buying/refunds-and-returns"],
  ])("permanently redirects a migrated public route", (loader, location) => {
    const response = loader();
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(location);
  });
});
