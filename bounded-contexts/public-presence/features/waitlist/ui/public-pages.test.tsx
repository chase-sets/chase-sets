import { cleanup, fireEvent, render as renderWithoutRouter, type RenderOptions } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicPresenceHomePage } from "./public-pages";
import { publicPresenceT as t } from "./public-presence-translator";

// PublicPresencePageShell registers the DS RouterLinkAdapter, so rendering it
// requires router context — exactly as it has in the production app tree.
function render(ui: ReactNode, options?: RenderOptions) {
  return renderWithoutRouter(ui, { wrapper: MemoryRouter, ...options });
}

const source = {
  pagePath: "/?utm_source=smoke",
  referrer: "https://example.test/cards",
  utmSource: "smoke",
  utmMedium: "automation",
  utmCampaign: "form-migration",
  utmContent: "hero",
  utmTerm: "pokemon",
  referredBySignupId: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("public waitlist form migration smoke", () => {
  it("keeps the hero form to email + intent, with no required consent control", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={source} />);

    const panel = document.getElementById("waitlist-form");
    const form = panel?.querySelector("form");
    if (!form) {
      throw new Error("Expected hero waitlist panel to render a form.");
    }

    expect(form.querySelector('input[name="marketingConsent"]')).toBeNull();
    expect(form.querySelector('input[type="checkbox"]')).toBeNull();

    fireEvent.change(form.querySelector('input[name="email"]')!, { target: { value: "seller@example.com" } });

    const formData = new FormData(form);
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe("?index");
    expect(formData.get("email")).toBe("seller@example.com");
    expect(formData.get("role")).toBe("both");
    expect(formData.get("interests")).toBe("low-sales-fees");
    expect(formData.get("marketingConsent")).toBeNull();
    expect(formData.get("website")).toBe("");
    expect(formData.get("pagePath")).toBe("/?utm_source=smoke");
    expect(formData.get("referrer")).toBe("https://example.test/cards");
    expect(formData.get("utmSource")).toBe("smoke");
    expect(formData.get("utmMedium")).toBe("automation");
    expect(formData.get("utmCampaign")).toBe("form-migration");
    expect(formData.get("utmContent")).toBe("hero");
    expect(formData.get("utmTerm")).toBe("pokemon");
  });

  it("keeps the final-CTA form's marketing consent checkbox optional", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={source} />);

    const panel = document.getElementById("waitlist-form-final");
    const form = panel?.querySelector("form");
    if (!form) {
      throw new Error("Expected final-CTA waitlist panel to render a form.");
    }

    const consentCheckbox = form.querySelector<HTMLInputElement>('input[name="marketingConsent"]');
    if (!consentCheckbox) {
      throw new Error("Expected the final-CTA panel to render an optional marketing-consent checkbox.");
    }
    expect(consentCheckbox.required).toBe(false);

    fireEvent.change(form.querySelector('input[name="email"]')!, { target: { value: "buyer@example.com" } });

    const formDataBeforeConsent = new FormData(form);
    expect(formDataBeforeConsent.get("marketingConsent")).toBeNull();

    fireEvent.click(consentCheckbox);

    const formDataAfterConsent = new FormData(form);
    expect(formDataAfterConsent.get("marketingConsent")).toBe("yes");
  });

  it("carries a referral code from the loader source into a hidden form field", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={{ ...source, referredBySignupId: "wls_referrer" }} />);

    const panel = document.getElementById("waitlist-form");
    const form = panel?.querySelector("form");
    if (!form) {
      throw new Error("Expected hero waitlist panel to render a form.");
    }

    const formData = new FormData(form);
    expect(formData.get("referredBySignupId")).toBe("wls_referrer");
  });

  it("shows the waitlist counter near the hero form once it clears the display threshold", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/waitlist/count")) {
          return new Response(JSON.stringify({ displayCount: 125 }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } });
      }),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={source} />);

    const panel = document.getElementById("waitlist-form");
    const counterText = await vi.waitFor(() => {
      const match = panel?.textContent?.includes("125+");
      if (!match) {
        throw new Error("Counter not rendered yet.");
      }
      return match;
    });

    expect(counterText).toBe(true);
  });

  it("keeps the waitlist counter hidden below the display threshold", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ displayCount: null }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={source} />);

    await vi.waitFor(() => {
      expect(document.getElementById("waitlist-form")?.textContent).not.toContain("+");
    });
  });

  it("renders an unconditional founder-story Discord CTA ahead of the final section, and hides it when unconfigured", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container, rerender } = render(
      <PublicPresenceHomePage actionData={null} discordInviteUrl="https://discord.gg/chase-sets" source={source} />,
    );

    const discordLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('a[href="https://discord.gg/chase-sets"]'),
    );
    expect(discordLinks.length).toBeGreaterThanOrEqual(2);

    const founderSection = container.querySelector('[data-public-presence-section="founder_story"]');
    const finalCtaSection = container.querySelector('[data-public-presence-section="final_cta"]');
    expect(founderSection?.querySelector('a[href="https://discord.gg/chase-sets"]')).not.toBeNull();
    expect(finalCtaSection?.querySelector('a[href="https://discord.gg/chase-sets"]')).not.toBeNull();

    rerender(<PublicPresenceHomePage actionData={null} discordInviteUrl={null} source={source} />);
    expect(container.querySelectorAll('a[href="https://discord.gg/chase-sets"]').length).toBe(0);
  });

  it("renders the open-offers section ahead of founding seller economics, with a sample offer mock and a reserved demo slot", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);

    const offersSection = container.querySelector('[data-public-presence-section="open_offers"]');
    const sellerEconomicsSection = container.querySelector('[data-public-presence-section="seller_economics"]');
    if (!offersSection || !sellerEconomicsSection) {
      throw new Error("Expected both the open-offers and seller-economics sections to render.");
    }

    // DOCUMENT_POSITION_FOLLOWING (4) on sellerEconomicsSection means offersSection comes first.
    expect(offersSection.compareDocumentPosition(sellerEconomicsSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(offersSection.textContent).toContain(t("publicPresence.home.openOffers.after.offerCard.title"));
    expect(offersSection.textContent).toContain(t("publicPresence.home.openOffers.demo.title"));
  });

  it("leads the buy-path audience card with the open-offers bullet", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);

    const audienceSection = container.querySelector('[data-public-presence-section="audience_paths"]');
    if (!audienceSection) {
      throw new Error("Expected the audience-path section to render.");
    }

    // The sell card renders first in the audience-path grid, so the buy
    // card's bullet list is the second <ul> in document order.
    const lists = audienceSection.querySelectorAll("ul");
    const buyList = lists[1];
    if (!buyList) {
      throw new Error("Expected the buy-path card to render its bullet list.");
    }

    expect(buyList.querySelector("li:first-child")?.textContent).toBe(t("publicPresence.home.paths.buy.point.offers"));
  });

  it("shows the fee primitive, founder economics, balance flywheel, and buyer-side checkout economics", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);

    const sellerEconomicsSection = container.querySelector('[data-public-presence-section="seller_economics"]');
    const balanceFlywheel = container.querySelector('[data-public-presence-section="balance_flywheel"]');
    const previewSection = container.querySelector('[data-public-presence-section="product_preview"]');
    if (!sellerEconomicsSection || !balanceFlywheel || !previewSection) {
      throw new Error("Expected seller-economics, balance-flywheel, and product-preview sections to render.");
    }

    expect(sellerEconomicsSection.textContent).toContain("Every listing locks its fee the moment you create it.");
    expect(sellerEconomicsSection.textContent).toContain("Founders: lock 0%");
    expect(sellerEconomicsSection.textContent).toContain("Sell. Get balance. Buy.");
    expect(sellerEconomicsSection.textContent).toContain("$100.00");
    expect(balanceFlywheel.textContent).toContain("Buy with balance");
    expect(balanceFlywheel.textContent).toContain("skip card processing entirely");
    expect(previewSection.textContent).toContain("Shipping");
    // #3951: the card processing line states the real passthrough terms and
    // the sample order resolves to a concrete total -- no fee on this surface
    // is described only as "quoted before payment".
    expect(previewSection.textContent).toContain("Card processing (2.9% + $0.30)");
    expect(previewSection.textContent).toContain("$2.82");
    expect(previewSection.textContent).toContain("$86.70");
    expect(previewSection.textContent).not.toMatch(/quoted before payment/i);
    expect(previewSection.textContent).not.toContain("At checkout");
    expect(previewSection.textContent).toContain("$0 with Chase Sets balance");
    expect(previewSection.textContent).toContain("Every order includes Order Protection.");
    expect(previewSection.querySelector('a[href="/order-protection"]')).not.toBeNull();
    expect(previewSection.textContent).not.toContain("Order protectionIncluded");
  });

  it("concretizes the founders offer with cap, numbered badge, and 60-day window, linked ahead of the audience paths and from the footer", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);

    const feeComparisonSection = container.querySelector('[data-public-presence-section="fee_comparison"]');
    const foundersSection = container.querySelector('[data-public-presence-section="founders_offer"]');
    const audienceSection = container.querySelector('[data-public-presence-section="audience_paths"]');
    if (!feeComparisonSection || !foundersSection || !audienceSection) {
      throw new Error("Expected fee-comparison, founders-offer, and audience-path sections to render.");
    }

    // DOCUMENT_POSITION_FOLLOWING (4) means the founders section renders
    // after fee comparison and ahead of the audience paths, per the
    // "immediately after the fees section" placement in #4081.
    expect(feeComparisonSection.compareDocumentPosition(foundersSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(foundersSection.compareDocumentPosition(audienceSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    expect(foundersSection.textContent).toContain("500");
    expect(foundersSection.textContent).toContain(t("publicPresence.home.foundersOffer.point.badge"));
    expect(foundersSection.textContent).toContain(t("publicPresence.home.foundersOffer.point.window"));
    expect(foundersSection.textContent).toContain(t("publicPresence.home.foundersOffer.point.expiry"));
    expect(foundersSection.querySelector('a[href="/founders"]')).not.toBeNull();

    expect(container.querySelector('footer a[href="/founders"]')?.textContent).toBe(
      t("publicPresence.nav.foundersTerms"),
    );
  });

  it("answers 'when can I use this?' with the launch timeline: September 1 date, beta-wave window, no per-wave dates (#3952)", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);

    const foundersSection = container.querySelector('[data-public-presence-section="founders_offer"]');
    const timelineSection = container.querySelector('[data-public-presence-section="launch_timeline"]');
    const audienceSection = container.querySelector('[data-public-presence-section="audience_paths"]');
    const faqSection = container.querySelector('[data-public-presence-section="faq"]');
    if (!foundersSection || !timelineSection || !audienceSection || !faqSection) {
      throw new Error("Expected founders-offer, launch-timeline, audience-path, and FAQ sections to render.");
    }

    // The timeline reads as the founders offer's "when": founders_offer →
    // launch_timeline → audience_paths.
    expect(foundersSection.compareDocumentPosition(timelineSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(timelineSection.compareDocumentPosition(audienceSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    // The one hard public date and the season-level beta window, interpolated
    // from launch-config (no leaked tokens).
    expect(timelineSection.textContent).toContain("September 1, 2026");
    expect(timelineSection.textContent).toContain("late July 2026");
    expect(timelineSection.textContent).not.toContain("{publicLaunchDate}");
    expect(timelineSection.textContent).not.toContain("{betaWavesWindow}");
    // Truth gate (#3955): wave-to-wave progression is ops-metric conditioned,
    // so no per-wave calendar dates may appear.
    expect(timelineSection.textContent).not.toMatch(/July 31|August \d/i);
    expect(timelineSection.querySelector('a[href="/#waitlist-form"]')).not.toBeNull();

    // The FAQ preview answers the same question with the same dates.
    expect(faqSection.textContent).toContain(t("publicPresence.faq.launch.question"));
    expect(faqSection.textContent).toContain("September 1, 2026");
    expect(faqSection.textContent).not.toContain("{publicLaunchDate}");
  });

  it("shows seller cohort-quality fields on the final-CTA form by default (role defaults to both)", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={source} />);

    const panel = document.getElementById("waitlist-form-final");
    const form = panel?.querySelector("form");
    if (!form) {
      throw new Error("Expected final-CTA waitlist panel to render a form.");
    }

    expect(form.querySelectorAll('input[name="games"]').length).toBe(5);
    expect(form.querySelector('select[name="inventorySize"]')).not.toBeNull();
    expect(form.querySelector('input[name="hasStoreLink"]')).not.toBeNull();
    // storeUrl only renders once hasStoreLink is checked.
    expect(form.querySelector('input[name="storeUrl"]')).toBeNull();
  });

  it("hides seller cohort-quality fields on the final-CTA form once role is switched to buy", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={source} />);

    const panel = document.getElementById("waitlist-form-final");
    const form = panel?.querySelector("form");
    if (!form) {
      throw new Error("Expected final-CTA waitlist panel to render a form.");
    }

    fireEvent.change(form.querySelector('select[name="role"]')!, { target: { value: "buy" } });

    expect(form.querySelectorAll('input[name="games"]').length).toBe(0);
    expect(form.querySelector('input[name="hasStoreLink"]')).toBeNull();
  });

  it("renders the game roster strip under the hero with five campaign-linkable per-game tiles", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);

    const rosterSection = container.querySelector('[data-public-presence-section="game_roster"]');
    if (!rosterSection) {
      throw new Error("Expected the game roster section to render.");
    }

    // The roster sits under the hero and ahead of the open-offers row.
    const offersSection = container.querySelector('[data-public-presence-section="open_offers"]');
    expect(rosterSection.compareDocumentPosition(offersSection!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    // Exactly the five supported games, each linking to its per-game entry
    // point while preserving the visitor's UTM query string.
    const tiles = Array.from(rosterSection.querySelectorAll<HTMLAnchorElement>("a"));
    expect(tiles.length).toBe(5);
    const hrefs = tiles.map((tile) => tile.getAttribute("href"));
    for (const slug of ["pokemon", "magic-the-gathering", "yu-gi-oh", "one-piece-card-game", "disney-lorcana"]) {
      const href = hrefs.find((candidate) => candidate?.includes(`game=${slug}`));
      expect(href).toBeTruthy();
      expect(href).toContain("utm_source=smoke");
      expect(href).toContain("#waitlist-form");
    }
    expect(rosterSection.textContent).toContain(t("publicPresence.home.gameRoster.game.pokemon"));
    expect(rosterSection.textContent).toContain(t("publicPresence.home.gameRoster.description"));
  });

  it("prefills the hero form's hidden games field from a ?game= tile visit while keeping the hero minimal", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={source} selectedGame="magic-the-gathering" />);

    const panel = document.getElementById("waitlist-form");
    const form = panel?.querySelector("form");
    if (!form) {
      throw new Error("Expected hero waitlist panel to render a form.");
    }

    const formData = new FormData(form);
    expect(formData.getAll("games")).toEqual(["magic-the-gathering"]);
    // The hero stays email + intent only: the game travels as a hidden value,
    // never as a visible control.
    expect(form.querySelector('input[type="checkbox"]')).toBeNull();
    expect(form.querySelector('select[name="inventorySize"]')).toBeNull();
    // The panel confirms the per-game landing with the game's name.
    expect(panel?.textContent).toContain(t("publicPresence.waitlist.game.magicTheGathering"));
  });

  it("pre-checks the selected game on the final-CTA games checkboxes", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={source} selectedGame="disney-lorcana" />);

    const panel = document.getElementById("waitlist-form-final");
    const form = panel?.querySelector("form");
    if (!form) {
      throw new Error("Expected final-CTA waitlist panel to render a form.");
    }

    const formData = new FormData(form);
    expect(formData.getAll("games")).toEqual(["disney-lorcana"]);
  });

  it("ignores an unrecognized ?game= slug instead of forwarding it to the form", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={source} selectedGame="not-a-real-game" />);

    const panel = document.getElementById("waitlist-form");
    const form = panel?.querySelector("form");
    if (!form) {
      throw new Error("Expected hero waitlist panel to render a form.");
    }

    expect(new FormData(form).getAll("games")).toEqual([]);
  });

  it("reveals the store URL field only after the store-link checkbox is checked, and submits selected games", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={source} />);

    const panel = document.getElementById("waitlist-form-final");
    const form = panel?.querySelector("form");
    if (!form) {
      throw new Error("Expected final-CTA waitlist panel to render a form.");
    }

    const pokemonCheckbox = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="games"]')).find(
      (input) => input.value === "pokemon",
    );
    if (!pokemonCheckbox) {
      throw new Error("Expected a Pokemon games checkbox.");
    }
    fireEvent.click(pokemonCheckbox);

    const storeLinkCheckbox = form.querySelector<HTMLInputElement>('input[name="hasStoreLink"]');
    if (!storeLinkCheckbox) {
      throw new Error("Expected a store-link checkbox.");
    }
    expect(form.querySelector('input[name="storeUrl"]')).toBeNull();
    fireEvent.click(storeLinkCheckbox);
    expect(form.querySelector('input[name="storeUrl"]')).not.toBeNull();

    const formData = new FormData(form);
    expect(formData.getAll("games")).toEqual(["pokemon"]);
    expect(formData.get("hasStoreLink")).toBe("yes");
  });
});
