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

  it("redirects to the welcome success page carrying the committed signup id on success", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "wls_public", version: 3, status: "joined" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = (await action({
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
    } as never)) as Response;

    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(302);
    const location = new URL(result.headers.get("Location") ?? "", "https://chasesets.test");
    expect(location.pathname).toBe("/welcome");
    expect(location.searchParams.get("signup")).toBe("wls_public");
    expect(location.searchParams.get("fresh")).toBe("1");
    expect(location.searchParams.has("attributed")).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      "https://chasesets.test/api/public-presence/waitlist",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("marks the welcome redirect as attributed when a referral code was submitted", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "wls_public", version: 1, status: "joined" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = (await action({
      request: new Request("https://chasesets.test/?index", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: "referred@example.com",
          role: "sell",
          interests: "low-sales-fees",
          referredBySignupId: "wls_referrer",
          pagePath: "/",
        }),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    const location = new URL(result.headers.get("Location") ?? "", "https://chasesets.test");
    expect(location.searchParams.get("attributed")).toBe("1");
  });

  it("stays on the landing page and returns the error snapshot on failure", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "Enter a valid email address." } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await action({
      request: new Request("https://chasesets.test/?index", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: "not-an-email",
          role: "both",
          interests: "low-sales-fees",
          pagePath: "/",
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({ status: "error", message: "Enter a valid email address." });
  });

  it("carries the ?ref= referral code from the loader into the hidden form source", async () => {
    const data = await loader({
      request: new Request("https://chasesets.test/?ref=wls_abc123"),
      params: {},
      context: undefined,
    } as never);

    expect(data.source.referredBySignupId).toBe("wls_abc123");
  });

  it("returns null when no ?ref= is present", async () => {
    const data = await loader({
      request: new Request("https://chasesets.test/"),
      params: {},
      context: undefined,
    } as never);

    expect(data.source.referredBySignupId).toBeNull();
  });
});
