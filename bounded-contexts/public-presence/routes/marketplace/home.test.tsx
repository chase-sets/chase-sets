import { describe, expect, it } from "vitest";
import { buildHomeStructuredData, meta } from "./home";

describe("public presence home route SEO", () => {
  it("publishes complete social and canonical metadata", () => {
    const descriptors = meta({ data: undefined, params: {}, location: { pathname: "/", search: "", hash: "", state: null, key: "test" }, matches: [], error: undefined } as never);

    expect(descriptors).toContainEqual({ title: "Chase Sets | Trading Card Marketplace Beta" });
    expect(descriptors).toContainEqual({
      name: "description",
      content: "Join the Chase Sets beta waitlist for 0% beta seller fees, bulk card listing workflows, and buyer-visible totals for trading card orders.",
    });
    expect(descriptors).toContainEqual({ tagName: "link", rel: "canonical", href: "https://chasesets.com/" });
    expect(descriptors).toContainEqual({ property: "og:url", content: "https://chasesets.com/" });
    expect(descriptors).toContainEqual({ name: "twitter:card", content: "summary_large_image" });
    expect(descriptors).toContainEqual({
      name: "twitter:title",
      content: "Chase Sets | Trading Card Marketplace Beta",
    });
  });

  it("exposes organization and website structured data", () => {
    const schema = buildHomeStructuredData();

    expect(schema["@context"]).toBe("https://schema.org");
    expect(schema["@graph"]).toContainEqual(expect.objectContaining({
      "@type": "Organization",
      name: "Chase Sets",
      url: "https://chasesets.com/",
    }));
    expect(schema["@graph"]).toContainEqual(expect.objectContaining({
      "@type": "WebSite",
      name: "Chase Sets",
      url: "https://chasesets.com/",
    }));
  });
});
