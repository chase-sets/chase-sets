import { describe, expect, it } from "vitest";
import { loader, meta, publicPresenceHomeJsonLd } from "../routes/marketplace/home";

describe("public presence home route", () => {
  it("positions the homepage metadata around seller beta early access", () => {
    expect(meta({} as never)).toEqual(
      expect.arrayContaining([
        { title: "Chase Sets Seller Beta Early Access | Trading Card Marketplace" },
        {
          name: "description",
          content:
            "Request Chase Sets early access for the seller beta: 0% seller fee locks, no separate seller payment-processing fee, Founding Account badge eligibility, and buyer-visible delivered totals.",
        },
        { property: "og:url", content: "https://chasesets.com/" },
      ]),
    );
    expect(meta({} as never)).not.toContainEqual(
      expect.objectContaining({
        rel: "canonical",
      }),
    );
  });

  it("exposes structured data for the public waitlist action", () => {
    expect(publicPresenceHomeJsonLd()).toMatchObject({
      "@context": "https://schema.org",
      "@graph": expect.arrayContaining([
        expect.objectContaining({
          "@type": "Organization",
          name: "Chase Sets",
          contactPoint: expect.objectContaining({
            "@type": "ContactPoint",
            email: "support@chasesets.com",
          }),
        }),
        expect.objectContaining({
          "@type": "WebSite",
          name: "Chase Sets",
          url: "https://chasesets.com/",
          potentialAction: {
            "@type": "RegisterAction",
            name: "Request early access",
            target: "https://chasesets.com/#waitlist-form",
          },
        }),
        expect.objectContaining({
          "@type": "FAQPage",
          mainEntity: expect.arrayContaining([
            expect.objectContaining({
              "@type": "Question",
              name: "Is Chase Sets live yet?",
            }),
          ]),
        }),
      ]),
    });
  });

  it("uses the loader origin for social metadata and JSON-LD", async () => {
    const data = await loader({
      request: new Request("https://preview.chasesets.test/?utm_source=deck"),
      params: {},
      context: undefined,
    } as never);

    expect(
      meta({
        data,
        params: {},
        location: { pathname: "/", search: "", hash: "", state: null, key: "test" },
        matches: [],
        error: undefined,
      } as never),
    ).toContainEqual({
      property: "og:url",
      content: "https://preview.chasesets.test/",
    });
    expect(publicPresenceHomeJsonLd(data.publicOrigin)).toMatchObject({
      "@graph": expect.arrayContaining([
        expect.objectContaining({
          "@type": "WebSite",
          url: "https://preview.chasesets.test/",
        }),
      ]),
    });
  });
});
