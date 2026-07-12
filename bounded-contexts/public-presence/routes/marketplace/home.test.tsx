import { describe, expect, it } from "vitest";
import { buildHomeStructuredData, meta } from "./home";

describe("public presence home route SEO", () => {
  it("publishes complete social metadata without owning canonical tags", () => {
    const descriptors = meta({
      data: undefined,
      params: {},
      location: { pathname: "/", search: "", hash: "", state: null, key: "test" },
      matches: [],
      error: undefined,
    } as never);

    expect(descriptors).toContainEqual({ title: "Chase Sets Early Access | Trading Card Marketplace" });
    expect(descriptors).toContainEqual({
      name: "description",
      content:
        "Request Chase Sets early access for 0% beta seller fee locks, no separate seller payment-processing fee, a numbered founders badge, and buyer-visible delivered totals.",
    });
    expect(descriptors).not.toContainEqual(expect.objectContaining({ rel: "canonical" }));
    expect(descriptors).toContainEqual({ property: "og:url", content: "https://chasesets.com/" });
    expect(descriptors).toContainEqual({ name: "twitter:card", content: "summary_large_image" });
    expect(descriptors).toContainEqual({
      name: "twitter:title",
      content: "Chase Sets Early Access | Trading Card Marketplace",
    });
  });

  it("exposes organization, website, and visible FAQ structured data", () => {
    const schema = buildHomeStructuredData("https://preview.chasesets.test");

    expect(schema["@context"]).toBe("https://schema.org");
    expect(schema["@graph"]).toContainEqual(
      expect.objectContaining({
        "@type": "Organization",
        name: "Chase Sets",
        url: "https://preview.chasesets.test/",
      }),
    );
    expect(schema["@graph"]).toContainEqual(
      expect.objectContaining({
        "@type": "WebSite",
        name: "Chase Sets",
        url: "https://preview.chasesets.test/",
      }),
    );
    expect(schema["@graph"]).toContainEqual(
      expect.objectContaining({
        "@type": "FAQPage",
        mainEntity: expect.arrayContaining([
          expect.objectContaining({
            "@type": "Question",
            name: "Is Chase Sets live yet?",
          }),
        ]),
      }),
    );
  });
});
