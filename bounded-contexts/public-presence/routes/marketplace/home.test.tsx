import { describe, expect, it } from "vitest";
import {
  checkoutFeeTranslationValues,
  fallbackCheckoutFeePreview,
} from "../../features/waitlist/ui/checkout-fee-preview";
import { landingFaqEntries } from "../../features/waitlist/ui/landing-faq";
import { publicPresenceT as t } from "../../features/waitlist/ui/public-presence-translator";
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
    expect(descriptors).toBeDefined();
    if (descriptors === undefined) {
      throw new Error("Expected home route metadata descriptors");
    }

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

    const ogImage = descriptors.find(
      (descriptor) => "property" in descriptor && descriptor.property === "og:image",
    ) as { content: string };
    expect(ogImage.content).toContain("https://chasesets.com/");
    expect(ogImage.content).toContain("chase-sets-og-default");
  });

  it("publishes the per-game OG card and copy for ?game= campaign variants", () => {
    const descriptors = meta({
      data: { publicOrigin: "https://chasesets.com", selectedGame: "yu-gi-oh" },
      params: {},
      location: { pathname: "/", search: "?game=yu-gi-oh", hash: "", state: null, key: "test" },
      matches: [],
      error: undefined,
    } as never);
    expect(descriptors).toBeDefined();
    if (descriptors === undefined) {
      throw new Error("Expected home route metadata descriptors");
    }

    expect(descriptors).toContainEqual({ title: "Yu-Gi-Oh! Singles | Chase Sets Early Access" });
    expect(descriptors).toContainEqual({ property: "og:url", content: "https://chasesets.com/?game=yu-gi-oh" });
    const ogImage = descriptors.find(
      (descriptor) => "property" in descriptor && descriptor.property === "og:image",
    ) as { content: string };
    expect(ogImage.content).toContain("chase-sets-og-yu-gi-oh");
    const description = descriptors.find((descriptor) => "name" in descriptor && descriptor.name === "description") as {
      content: string;
    };
    expect(description.content).toContain("Yu-Gi-Oh!");
    expect(description.content).not.toContain("{game}");
  });

  it("falls back to the default OG card for an unrecognized ?game= value", () => {
    const descriptors = meta({
      data: { publicOrigin: "https://chasesets.com", selectedGame: "not-a-game" },
      params: {},
      location: { pathname: "/", search: "?game=not-a-game", hash: "", state: null, key: "test" },
      matches: [],
      error: undefined,
    } as never);
    expect(descriptors).toBeDefined();
    if (descriptors === undefined) {
      throw new Error("Expected home route metadata descriptors");
    }

    expect(descriptors).toContainEqual({ title: "Chase Sets Early Access | Trading Card Marketplace" });
    expect(descriptors).toContainEqual({ property: "og:url", content: "https://chasesets.com/" });
    const ogImage = descriptors.find(
      (descriptor) => "property" in descriptor && descriptor.property === "og:image",
    ) as { content: string };
    expect(ogImage.content).toContain("chase-sets-og-default");
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

    // The launch answer carries the undated access order. The FAQPage node
    // is the third graph entry by construction.
    const faqPage = schema["@graph"][2];
    const launchAnswer = faqPage.mainEntity.find((entry) => entry.name === "Is Chase Sets live yet?");
    expect(launchAnswer?.acceptedAnswer.text).toMatch(/waitlist.*numbered beta invite waves.*open signup/i);
    expect(JSON.stringify(schema)).not.toContain("September 1, 2026");
    expect(JSON.stringify(schema)).not.toContain("late July 2026");
    expect(launchAnswer?.acceptedAnswer.text).not.toContain("{");
  });

  it("publishes the FAQPage node byte-identical to the pre-#8503 base from the shared landing FAQ list (AC2)", () => {
    const faqAnswerValues = checkoutFeeTranslationValues(fallbackCheckoutFeePreview);
    // The base node, spelled out: four questions in this exact order with
    // these exact locale keys. The visible landing FAQ now renders from the
    // same `landingFaqEntries`, so this pins both the JSON-LD and the list.
    const baseFaqKeys = [
      ["publicPresence.faq.launch.question", "publicPresence.faq.launch.answer"],
      ["publicPresence.faq.fees.question", "publicPresence.faq.fees.answer"],
      ["publicPresence.faq.shipping.question", "publicPresence.faq.shipping.answer"],
      ["publicPresence.faq.safety.question", "publicPresence.faq.safety.answer"],
    ] as const;
    const baseFaqPage = {
      "@type": "FAQPage",
      "@id": "https://chasesets.com/#landing-faq",
      mainEntity: baseFaqKeys.map(([question, answer]) => ({
        "@type": "Question",
        name: t(question),
        acceptedAnswer: { "@type": "Answer", text: t(answer, faqAnswerValues) },
      })),
    };

    expect(JSON.stringify(buildHomeStructuredData()["@graph"][2])).toBe(JSON.stringify(baseFaqPage));
    expect(landingFaqEntries.map(({ question, answer }) => [question, answer])).toEqual(
      baseFaqKeys.map((pair) => [...pair]),
    );
    expect(baseFaqPage.mainEntity[0]?.name).toBe("Is Chase Sets live yet?");
  });
});
