import { afterEach, describe, expect, it, vi } from "vitest";
import { action, loader, meta, publicPresenceHomeJsonLd } from "../routes/marketplace/home";

afterEach(() => {
  vi.unstubAllGlobals();
});

// The loader always reads live policy values through loadLandingFeePresentation
// (the checkout-fee preview). Every test that calls the
// loader must stub `fetch` so that read stays in-process: an unstubbed call
// escapes to a real `chasesets.test` DNS lookup and is a test-hermeticity bug,
// not a passing test (see the public-presence CI flake this guards against).
// Tests that don't care about the resolved fee values use this 503 stub —
// the same "policy read failed" shape the loader's own fallback path already
// exercises deterministically elsewhere in this file.
function stubPolicyReadUnavailable() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("policy source unavailable", { status: 503 })),
  );
}

describe("public presence home route", () => {
  it("positions the homepage metadata around seller beta early access", () => {
    expect(meta({} as never)).toEqual(
      expect.arrayContaining([
        { title: "Chase Sets Early Access | Trading Card Marketplace" },
        {
          name: "description",
          content:
            "Request Chase Sets early access for 0% beta seller fee locks, no separate seller payment-processing fee, a numbered founders badge, and buyer-visible delivered totals.",
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
    stubPolicyReadUnavailable();
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
          landingExperimentVariant: "seller_first_v2",
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
    expect(location.searchParams.get("variant")).toBe("seller_first_v2");
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

  it("builds the checkout-fee preview from the live whitelisted policy read (#3951)", async () => {
    const policyValue = (type: "bps" | "money", value: number | string) => ({
      type,
      value,
      ...(type === "money" ? { currency: "USD" } : {}),
      effectiveFrom: "2026-07-03T00:00:00.000Z",
      upcoming: [],
    });
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            values: {
              "checkout-processing-fee.card.bps": policyValue("bps", 350),
              "checkout-processing-fee.card.fixed": policyValue("money", "0.20"),
              "checkout-processing-fee.bank-account.bps": policyValue("bps", 80),
              "checkout-processing-fee.bank-account.fixed": policyValue("money", "0.00"),
            },
            resolvedAt: "2026-07-12T00:00:00.000Z",
            propagationSeconds: 360,
            changeCalloutDays: 30,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    const data = await loader({
      request: new Request("https://chasesets.test/"),
      params: {},
      context: undefined,
    } as never);

    expect(fetch).toHaveBeenCalledWith("https://chasesets.test/api/public-presence/policy-values", expect.anything());
    // A revised live policy drives the presentation; the compiled launch
    // terms are only the unavailable-read fallback.
    expect(data.checkoutFeePreview.cardRate).toBe("3.5%");
    expect(data.checkoutFeePreview.cardFixed).toBe("$0.20");
    expect(data.checkoutFeePreview.bankRate).toBe("0.8%");
    expect(data.checkoutFeePreview.balanceTotalAmount).toBe("$83.88");
  });

  it("falls back to the compiled launch terms when the policy read is unavailable", async () => {
    const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const data = await loader({
        request: new Request("https://chasesets.test/"),
        params: {},
        context: undefined,
      } as never);

      expect(data.checkoutFeePreview).toMatchObject({
        cardRate: "2.9%",
        cardFixed: "$0.30",
        bankRate: "0.5%",
        cardFeeAmount: "$2.82",
        cardTotalAmount: "$86.70",
        balanceTotalAmount: "$83.88",
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("checkout processing terms"));
    } finally {
      warn.mockRestore();
    }
  });

  it("carries the ?ref= referral code from the loader into the hidden form source", async () => {
    stubPolicyReadUnavailable();
    const data = await loader({
      request: new Request("https://chasesets.test/?ref=wls_abc123"),
      params: {},
      context: undefined,
    } as never);

    expect(data.source.referredBySignupId).toBe("wls_abc123");
  });

  it("returns null when no ?ref= is present", async () => {
    stubPolicyReadUnavailable();
    const data = await loader({
      request: new Request("https://chasesets.test/"),
      params: {},
      context: undefined,
    } as never);

    expect(data.source.referredBySignupId).toBeNull();
  });

  it("warns loudly outside production when the Discord invite URL is unconfigured", async () => {
    stubPolicyReadUnavailable();
    const originalDiscordUrl = process.env.CHASE_SETS_DISCORD_INVITE_URL;
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.CHASE_SETS_DISCORD_INVITE_URL;
    process.env.NODE_ENV = "development";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const data = await loader({
        request: new Request("https://chasesets.test/"),
        params: {},
        context: undefined,
      } as never);

      expect(data.discordInviteUrl).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("CHASE_SETS_DISCORD_INVITE_URL"));
    } finally {
      warn.mockRestore();
      if (originalDiscordUrl === undefined) {
        delete process.env.CHASE_SETS_DISCORD_INVITE_URL;
      } else {
        process.env.CHASE_SETS_DISCORD_INVITE_URL = originalDiscordUrl;
      }
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("stays quiet when the Discord invite URL is unconfigured in production", async () => {
    stubPolicyReadUnavailable();
    const originalDiscordUrl = process.env.CHASE_SETS_DISCORD_INVITE_URL;
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.CHASE_SETS_DISCORD_INVITE_URL;
    process.env.NODE_ENV = "production";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await loader({
        request: new Request("https://chasesets.test/"),
        params: {},
        context: undefined,
      } as never);

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      if (originalDiscordUrl === undefined) {
        delete process.env.CHASE_SETS_DISCORD_INVITE_URL;
      } else {
        process.env.CHASE_SETS_DISCORD_INVITE_URL = originalDiscordUrl;
      }
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("publishes no fee schedule: the landing calculator moved to the compare pages (#8503)", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            values: {
              "marketplace-sales-fee.standard.bps": {
                type: "bps",
                value: 500,
                effectiveFrom: "2026-07-03T00:00:00.000Z",
                upcoming: [],
              },
              "marketplace-sales-fee.standard.fixed": {
                type: "money",
                value: "0.00",
                effectiveFrom: null,
                upcoming: [],
              },
              "marketplace-sales-fee.standard.cap": {
                type: "money",
                value: "25.00",
                effectiveFrom: null,
                upcoming: [],
              },
            },
            resolvedAt: "2026-07-12T00:00:00.000Z",
            propagationSeconds: 360,
            changeCalloutDays: 30,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    const data = await loader({
      request: new Request("https://chasesets.test/"),
      params: {},
      context: undefined,
    } as never);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/public-presence/policy-values"),
      expect.anything(),
    );
    expect(Object.keys(data).sort()).toEqual(
      ["checkoutFeePreview", "discordInviteUrl", "publicOrigin", "selectedGame", "source"].sort(),
    );
  });

  // #8503 AC6: links the landing calculator generated before it moved carry
  // `price` plus this exact UTM triple; they redirect to the TCGplayer compare
  // page with the query untouched and the calculator anchor. The loader throws
  // the redirect Response (React Router prior art), so a test catches it.
  const legacyShareQuery = "?price=12.00&cards=2&utm_source=fee-calculator&utm_medium=share&utm_campaign=what-you-keep";

  async function loaderOutcome(
    path: string,
  ): Promise<{ response: Response } | { data: Awaited<ReturnType<typeof loader>> }> {
    try {
      return {
        data: await loader({
          request: new Request(`https://chasesets.test${path}`),
          params: {},
          context: undefined,
        } as never),
      };
    } catch (thrown) {
      if (thrown instanceof Response) return { response: thrown };
      throw thrown;
    }
  }

  it("redirects a legacy fee-calculator share link on / to /compare/tcgplayer with the unchanged query (AC6)", async () => {
    const fetch = vi.fn(async () => new Response("policy source unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);

    const outcome = await loaderOutcome(`/${legacyShareQuery}`);

    if (!("response" in outcome)) throw new Error("Expected the loader to redirect a legacy share link.");
    expect(outcome.response.status).toBe(302);
    expect(outcome.response.headers.get("Location")).toBe(`/compare/tcgplayer${legacyShareQuery}#fee-calculator`);
    // The redirect is decided before any policy read.
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["price without the share UTM triple", "/?price=12.00&cards=2"],
    ["the share UTM triple without a price", "/?utm_source=fee-calculator&utm_medium=share&utm_campaign=what-you-keep"],
    ["a different utm_campaign", "/?price=12.00&utm_source=fee-calculator&utm_medium=share&utm_campaign=other"],
    ["a different utm_source", "/?price=12.00&utm_source=newsletter&utm_medium=share&utm_campaign=what-you-keep"],
    ["an ordinary campaign visit", "/?utm_source=deck&game=pokemon"],
    ["the bare landing page", "/"],
  ])("does not redirect %s (AC6 nonmatching)", async (_label, path) => {
    stubPolicyReadUnavailable();

    const outcome = await loaderOutcome(path);

    if (!("data" in outcome)) throw new Error(`Expected the loader to render ${path}, not redirect.`);
    expect(outcome.data.source.pagePath).toBe(path);
  });

  it("leaves the signup action untouched by the legacy share-link query (AC6)", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "wls_share_test", version: 1, status: "joined" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await action({
      request: new Request(`https://chasesets.test/${legacyShareQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: "seller@example.com",
          role: "sell",
          interests: "low-sales-fees",
          pagePath: `/${legacyShareQuery}`,
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toMatch(/^\/welcome\?signup=wls_share_test&/);
  });
});
