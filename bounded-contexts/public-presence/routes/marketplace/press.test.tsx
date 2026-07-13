import { describe, expect, it } from "vitest";
import { findPublicHelpArticleByPath } from "../../features/help/ui/help-route-data";
import { meta } from "./press";

describe("creator and press fact sheet route", () => {
  it("compiles the fact sheet at /press with live fee tokens and truth-gated claims", () => {
    const article = findPublicHelpArticleByPath("/press");

    expect(article).toBeDefined();
    expect(article!.title).toBe("Creator and press fact sheet");
    // The fee facts are live policy tokens, never hand-copied numbers.
    expect(article!.policyValueKeys).toContain("marketplace-sales-fee.standard.bps");
    expect(article!.policyValueKeys).toContain("marketplace-sales-fee.standard.cap");
    expect(article!.policyValueKeys).toContain("checkout-processing-fee.card.bps");
    // Every published claim family stays inside the promise-gated corpus.
    expect(article!.promiseTable.length).toBeGreaterThan(0);
    // No traction numbers: the sheet must never publish user or sales counts.
    const bodyText = JSON.stringify(article!.blocks);
    expect(bodyText).not.toMatch(/\d+ (?:users|sellers|buyers|orders|sales)\b/i);
  });

  it("publishes social preview metadata for shared /press links", () => {
    const article = findPublicHelpArticleByPath("/press")!;
    const descriptors = meta({
      data: { article, related: [], publicOrigin: "https://chasesets.com" },
      params: {},
      location: { pathname: "/press", search: "", hash: "", state: null, key: "test" },
      matches: [],
      error: undefined,
    } as never);
    expect(descriptors).toBeDefined();
    if (descriptors === undefined) {
      throw new Error("Expected press route metadata descriptors");
    }

    expect(descriptors).toContainEqual({ title: "Creator and press fact sheet | Chase Sets" });
    expect(descriptors).toContainEqual({ property: "og:url", content: "https://chasesets.com/press" });
    expect(descriptors).toContainEqual({ name: "twitter:card", content: "summary_large_image" });
    const ogImage = descriptors.find(
      (descriptor) => "property" in descriptor && descriptor.property === "og:image",
    ) as { content: string };
    expect(ogImage.content).toContain("chase-sets-og-default");
  });
});
