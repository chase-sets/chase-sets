import { afterEach, describe, expect, it, vi } from "vitest";
import { action, loader, meta, publicPresenceHomeJsonLd } from "../routes/marketplace/home";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public presence home route", () => {
  it("positions the homepage metadata around seller beta early access", () => {
    expect(meta({} as never)).toEqual(
      expect.arrayContaining([
        { title: "Chase Sets Early Access | Trading Card Marketplace" },
        {
          name: "description",
          content:
            "Request Chase Sets early access for 0% beta seller fee locks, no separate seller payment-processing fee, Founding Account consideration, and buyer-visible delivered totals.",
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

  it("returns the waitlist command receipt as the same-page success snapshot", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "wls_public", version: 3, status: "joined" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await action({
      request: new Request("https://chasesets.test/?index", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: "collector@example.com",
          role: "both",
          interests: "low-sales-fees",
          marketingConsent: "yes",
          pagePath: "/",
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({ status: "joined", id: "wls_public", version: 3 });
    expect(fetch).toHaveBeenCalledWith(
      "https://chasesets.test/api/public-presence/waitlist",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
