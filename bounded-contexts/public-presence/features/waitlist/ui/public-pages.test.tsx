import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { act, cleanup, fireEvent, render as renderWithoutRouter, type RenderOptions } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";
import { PublicPresenceHomePage } from "./public-pages";
import { publicPresenceT as t } from "./public-presence-translator";

// PublicPresencePageShell registers the DS RouterLinkAdapter, so rendering it
// requires router context — exactly as it has in the production app tree.
function render(ui: ReactNode, options?: RenderOptions) {
  return renderWithoutRouter(ui, { wrapper: MemoryRouter, ...options });
}

// Captures every `chase-sets:waitlist-analytics` window CustomEvent detail in
// dispatch order, for tests asserting the event itself (AC7) rather than the
// `window.dataLayer` mirror the other cases already cover.
function captureAnalyticsEvents() {
  const events: Record<string, unknown>[] = [];
  const handler = (event: Event) => {
    events.push((event as CustomEvent<Record<string, unknown>>).detail);
  };
  window.addEventListener("chase-sets:waitlist-analytics", handler);
  return { events, stop: () => window.removeEventListener("chase-sets:waitlist-analytics", handler) };
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
  it("renders the buyer hero and records seller_first_v2 for an explicit buyer intent", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(
      <PublicPresenceHomePage
        actionData={null}
        source={{ ...source, pagePath: "/?intent=buy", utmSource: null, utmCampaign: null }}
      />,
    );

    expect(container.textContent).toContain("The cards you need, with the full picture before you pay.");
    expect(container.textContent).toContain("Collector Shipping Credit");
    expect(container.textContent).toContain("Set completion");

    const form = document.getElementById("waitlist-form")?.querySelector("form");
    expect(new FormData(form!).get("role")).toBe("buy");
    expect(new FormData(form!).get("landingExperimentVariant")).toBe("seller_first_v2");
    expect(window.dataLayer).toContainEqual(
      expect.objectContaining({ event: "landing_page_view", variant: "seller_first_v2" }),
    );
  });

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
    expect(formData.get("landingExperimentVariant")).toBe("seller_first_v1");
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

  it("renders the open-offers section ahead of seller tools, with a sample offer mock and no unrecorded demo placeholder", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);

    const offersSection = container.querySelector('[data-public-presence-section="open_offers"]');
    const sellerToolsSection = container.querySelector('[data-public-presence-section="seller_tools"]');
    if (!offersSection || !sellerToolsSection) {
      throw new Error("Expected both the open-offers and seller-tools sections to render.");
    }

    // DOCUMENT_POSITION_FOLLOWING (4) on sellerToolsSection means offersSection comes first.
    expect(offersSection.compareDocumentPosition(sellerToolsSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(offersSection.textContent).toContain(t("publicPresence.home.openOffers.after.offerCard.title"));
    // #5617: the demo/video placeholder is hidden until a recording ships.
    expect(offersSection.textContent).not.toContain("Watch a 30-second offer get posted and accepted");
  });

  it("shows the founder-math examples inside the fee-comparison section, with the comparison table as centerpiece, and buyer-side checkout economics", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);

    const feeComparisonSection = container.querySelector('[data-public-presence-section="fee_comparison"]');
    const previewSection = container.querySelector('[data-public-presence-section="product_preview"]');
    if (!feeComparisonSection || !previewSection) {
      throw new Error("Expected fee-comparison and product-preview sections to render.");
    }

    // #5617: SellerEconomicsSection was removed; its founder-math cards now
    // render inside FeeComparisonSection alongside the comparison table.
    expect(feeComparisonSection.textContent).toContain(t("publicPresence.home.sellerEconomics.comparison.title"));
    expect(feeComparisonSection.textContent).toContain("$10 card beta seller math");
    expect(feeComparisonSection.textContent).toContain("$100 graded-card founder math");
    expect(feeComparisonSection.textContent).toContain("$100.00");
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
    expect(previewSection.textContent).toContain("Order Protection comes with every order.");
    expect(previewSection.querySelector('a[href="/order-protection"]')).not.toBeNull();
    expect(previewSection.textContent).not.toContain("Order protectionIncluded");
  });

  it("places the truth-gated seller-tools differentiator between open offers and the fee comparison", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);

    const offersSection = container.querySelector('[data-public-presence-section="open_offers"]');
    const sellerToolsSection = container.querySelector('[data-public-presence-section="seller_tools"]');
    const feeComparisonSection = container.querySelector('[data-public-presence-section="fee_comparison"]');
    if (!offersSection || !sellerToolsSection || !feeComparisonSection) {
      throw new Error("Expected open offers, seller tools, and fee comparison sections to render.");
    }

    expect(offersSection.compareDocumentPosition(sellerToolsSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(sellerToolsSection.compareDocumentPosition(feeComparisonSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(sellerToolsSection.textContent).toContain(t("publicPresence.home.sellerTools.comingToBeta"));
    expect(sellerToolsSection.textContent).not.toContain("Included at launch");
    expect(sellerToolsSection.textContent).toContain(t("publicPresence.home.sellerTools.repricing.title"));
    expect(sellerToolsSection.textContent).toContain(t("publicPresence.home.sellerTools.market.title"));
    expect(sellerToolsSection.textContent).toContain(t("publicPresence.home.sellerTools.scale.title"));
    expect(sellerToolsSection.querySelector('a[href="/#waitlist-form-final"]')).not.toBeNull();
  });

  it("tracks the seller-tools early-access CTA through the existing funnel event", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);
    const sellerToolsSection = container.querySelector('[data-public-presence-section="seller_tools"]');
    const cta = sellerToolsSection?.querySelector('a[href="/#waitlist-form-final"]');
    if (!cta) {
      throw new Error("Expected seller-tools early-access CTA to render.");
    }

    fireEvent.click(cta);

    expect(window.dataLayer).toContainEqual(
      expect.objectContaining({
        event: "cta_clicked",
        section: "seller_tools",
        target: "waitlist_form_final",
        variant: "seller_first_v1",
      }),
    );
  });

  it("concretizes the founders offer with cap, numbered badge, and 60-day window, linked ahead of the launch timeline and from the footer", () => {
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
    const timelineSection = container.querySelector('[data-public-presence-section="launch_timeline"]');
    if (!feeComparisonSection || !foundersSection || !timelineSection) {
      throw new Error("Expected fee-comparison, founders-offer, and launch-timeline sections to render.");
    }

    // DOCUMENT_POSITION_FOLLOWING (4) means the founders section renders
    // after fee comparison and ahead of the launch timeline, per the
    // "immediately after the fees section" placement in #4081.
    expect(feeComparisonSection.compareDocumentPosition(foundersSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(foundersSection.compareDocumentPosition(timelineSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    expect(foundersSection.textContent).toContain("500");
    expect(foundersSection.textContent).toContain(t("publicPresence.home.foundersOffer.point.badge"));
    expect(foundersSection.textContent).toContain(t("publicPresence.home.foundersOffer.point.window"));
    expect(foundersSection.textContent).toContain(t("publicPresence.home.foundersOffer.point.expiry"));
    expect(foundersSection.textContent).toContain(t("publicPresence.home.foundersOffer.point.community"));
    expect(foundersSection.textContent).toContain(t("publicPresence.home.foundersOffer.point.input"));
    expect(foundersSection.querySelector('a[href="/founders"]')).not.toBeNull();

    expect(container.querySelector('footer a[href="/founders"]')?.textContent).toBe(
      t("publicPresence.nav.foundersTerms"),
    );
  });

  it("answers when access opens with numbered invite capacities, qualification, and the public launch date", () => {
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
    const faqSection = container.querySelector('[data-public-presence-section="faq"]');
    if (!foundersSection || !timelineSection || !faqSection) {
      throw new Error("Expected founders-offer, launch-timeline, and FAQ sections to render.");
    }

    // The timeline reads as the founders offer's "when": founders_offer →
    // launch_timeline → ... → faq.
    expect(foundersSection.compareDocumentPosition(timelineSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(timelineSection.compareDocumentPosition(faqSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    // The one hard public date and the season-level beta window, interpolated
    // from launch-config (no leaked tokens).
    expect(timelineSection.textContent).toContain("September 1, 2026");
    expect(timelineSection.textContent).toContain("late July 2026");
    expect(timelineSection.textContent).toContain("Wave 1: 100 invites");
    expect(timelineSection.textContent).toContain("Wave 2: 250 invites");
    expect(timelineSection.textContent).toContain("Wave 3: 500 invites");
    expect(timelineSection.textContent).toContain(t("publicPresence.home.launchTimeline.step.waves.qualification"));
    expect(timelineSection.textContent).toContain(t("publicPresence.home.launchTimeline.step.waves.gates"));
    expect(timelineSection.textContent).not.toContain("{publicLaunchDate}");
    expect(timelineSection.textContent).not.toContain("{betaWavesWindow}");
    // Wave-to-wave progression is operations-gated, so target dates are not promises.
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

  it("#5617: cuts the removed sections and renders exactly the approved surviving section order", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);

    // The five approved cuts: SignupExpectationSection, MarketplaceModelSection,
    // AudiencePathSection, and the standalone SellerEconomicsSection are gone.
    expect(container.querySelector('[data-public-presence-section="signup_expectations"]')).toBeNull();
    expect(container.querySelector('[data-public-presence-section="marketplace_model"]')).toBeNull();
    expect(container.querySelector('[data-public-presence-section="audience_paths"]')).toBeNull();
    expect(container.querySelector('[data-public-presence-section="seller_economics"]')).toBeNull();
    expect(container.querySelector('[data-public-presence-section="balance_flywheel"]')).toBeNull();

    const sections = Array.from(container.querySelectorAll<HTMLElement>("[data-public-presence-section]")).map(
      (section) => section.getAttribute("data-public-presence-section"),
    );

    // feeSchedule defaults to null in this render, which hides
    // FeeCalculatorSection entirely (it is truth-gated on a live schedule).
    expect(sections).toEqual([
      "hero",
      "game_roster",
      "open_offers",
      "seller_tools",
      "fee_comparison",
      "founders_offer",
      "launch_timeline",
      "product_preview",
      "founder_story",
      "final_cta",
      "faq",
    ]);
  });

  it("#5617: preserves the hero and final-CTA form anchors and the game-prefill link mechanism", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} selectedGame="pokemon" />);

    expect(document.getElementById("waitlist-form")).not.toBeNull();
    expect(document.getElementById("waitlist-form-final")).not.toBeNull();
    expect(container.querySelector('a[href="/#waitlist-form-final"]')).not.toBeNull();

    const rosterSection = container.querySelector('[data-public-presence-section="game_roster"]');
    const pokemonTile = rosterSection?.querySelector<HTMLAnchorElement>('a[href*="game=pokemon"]');
    if (!pokemonTile) {
      throw new Error("Expected a Pokemon game-roster tile linking to the prefilled waitlist form.");
    }
    expect(pokemonTile.getAttribute("href")).toContain("#waitlist-form");
    expect(pokemonTile.getAttribute("href")).toMatch(/^\/\?/);

    const heroForm = document.getElementById("waitlist-form")?.querySelector("form");
    expect(new FormData(heroForm!).getAll("games")).toEqual(["pokemon"]);
  });

  it("#5619: renders every landing text input and select at the text-base 16px control-size contract, leaving checkbox/segmented controls untouched", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={source} />);

    const heroForm = document.getElementById("waitlist-form")?.querySelector("form");
    const finalForm = document.getElementById("waitlist-form-final")?.querySelector("form");
    if (!heroForm || !finalForm) {
      throw new Error("Expected both waitlist panels to render a form.");
    }

    // storeUrl only renders once a seller role is selected and hasStoreLink is checked.
    fireEvent.change(finalForm.querySelector('select[name="role"]')!, { target: { value: "sell" } });
    fireEvent.click(finalForm.querySelector('input[name="hasStoreLink"]')!);

    const heroEmail = heroForm.querySelector<HTMLInputElement>('input[name="email"]');
    const roleSelect = finalForm.querySelector<HTMLSelectElement>('select[name="role"]');
    const interestsSelect = finalForm.querySelector<HTMLSelectElement>('select[name="interests"]');
    const inventorySizeSelect = finalForm.querySelector<HTMLSelectElement>('select[name="inventorySize"]');
    const storeUrlInput = finalForm.querySelector<HTMLInputElement>('input[name="storeUrl"]');

    const landingTextControls = [heroEmail, roleSelect, interestsSelect, inventorySizeSelect, storeUrlInput];
    for (const control of landingTextControls) {
      if (!control) {
        throw new Error("Expected every landing text input and select to render.");
      }
      expect(control.className).toContain("text-base");
      expect(control.className).toContain("min-h-[var(--control-lg-height)]");
      expect(control.className).not.toContain("text-sm");
    }

    // Checkbox and segmented controls are out of scope and must stay at their existing sizing.
    const marketingConsentCheckbox = finalForm.querySelector('input[name="marketingConsent"]');
    const hasStoreLinkCheckbox = finalForm.querySelector('input[name="hasStoreLink"]');
    const heroSegmentedControl = heroForm.querySelector('[role="radiogroup"]');
    expect(marketingConsentCheckbox?.closest("label")?.className).not.toContain("text-base");
    expect(hasStoreLinkCheckbox?.closest("label")?.className).not.toContain("text-base");
    expect(heroSegmentedControl).not.toBeNull();
    expect(heroSegmentedControl?.className).not.toContain("text-base");
  });

  it("#5620: sizes footer/inline links for coarse-pointer touch targets and fits the fee table at 375w", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);

    // Footer and inline landing links opt into the DS LinkText `touchTarget`
    // prop, which grows the hit area to >=44px on coarse pointers (touchscreens)
    // via the `pointer-coarse` CSS media variant — no JS matchMedia check, so
    // mouse/trackpad presentation is untouched at every pointer type.
    const footerLinks = Array.from(container.querySelectorAll("footer a"));
    expect(footerLinks.length).toBeGreaterThan(0);
    for (const link of footerLinks) {
      expect(link.className).toContain("pointer-coarse:min-h-11");
      expect(link.className).toContain("pointer-coarse:min-w-11");
    }

    const previewSection = container.querySelector('[data-public-presence-section="product_preview"]');
    const protectionLinks = Array.from(previewSection?.querySelectorAll('a[href="/order-protection"]') ?? []);
    const inlineProtectionLink = protectionLinks.find(
      (link) => link.textContent === t("publicPresence.preview.total.protectionLink"),
    );
    if (!inlineProtectionLink) {
      throw new Error("Expected the inline LinkText order-protection link to render in the product preview section.");
    }
    expect(inlineProtectionLink.className).toContain("pointer-coarse:min-h-11");
    expect(inlineProtectionLink.className).toContain("pointer-coarse:min-w-11");

    // The fee-comparison Table renders at compact density with `wrapFirstColumn`,
    // which constrains the metric-label column to a narrow max-width and allows
    // mid-word breaks so the table fits a 375px viewport without the compact
    // density change alone (~8px/column savings) closing the ~30px overflow.
    const feeComparisonSection = container.querySelector('[data-public-presence-section="fee_comparison"]');
    const headCell = feeComparisonSection?.querySelector("th");
    const bodyCell = feeComparisonSection?.querySelector("td");
    expect(headCell?.className).toContain("px-3 py-2");
    expect(bodyCell?.className).toContain("px-3 py-2");

    expect(headCell?.className).toContain("max-w-11");
    expect(headCell?.className).toContain("hyphens-auto");
    expect(headCell?.getAttribute("lang")).toBe("en");
    expect(headCell?.textContent).toBe(t("publicPresence.home.sellerEconomics.comparison.column.metric"));

    // Only the first (label) column wraps — the value columns keep their
    // default cell treatment.
    const bodyCells = Array.from(feeComparisonSection?.querySelectorAll("tbody tr:first-child td") ?? []);
    expect(bodyCells[0]?.className).toContain("max-w-11");
    expect(bodyCells[1]?.className).not.toContain("max-w-11");
  });

  it("carries exactly one gold-foil word in the hero, byte-equal to the shipped locale title, per variant", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container: v1 } = render(<PublicPresenceHomePage actionData={null} source={source} />);
    expect(v1.querySelectorAll(".ds-brand-foil-text")).toHaveLength(1);
    const v1Heading = v1.querySelector("h1");
    expect(v1Heading?.textContent).toBe(t("publicPresence.home.title"));
    expect(v1Heading?.className).toContain("font-display");
    expect(v1Heading?.querySelector(".ds-brand-foil-text")?.textContent).toBe("marketplace");

    const { container: v2 } = render(
      <PublicPresenceHomePage actionData={null} source={{ ...source, pagePath: "/?intent=buy" }} />,
    );
    expect(v2.querySelectorAll(".ds-brand-foil-text")).toHaveLength(1);
    const v2Heading = v2.querySelector("h1");
    expect(v2Heading?.textContent).toBe(t("publicPresence.home.buyerHero.title"));
    expect(v2Heading?.className).toContain("font-display");
    expect(v2Heading?.querySelector(".ds-brand-foil-text")?.textContent).toBe("cards");
  });

  it("renders the mobile sticky waitlist bar only once the hero form leaves view", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    // The page also mounts a section-view-tracking observer, so instances are
    // keyed by their actually-observed target rather than call order.
    const instances: { callback: IntersectionObserverCallback; observed: Element[] }[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserverStub(callback: IntersectionObserverCallback) {
        const observed: Element[] = [];
        instances.push({ callback, observed });
        return {
          observe: (element: Element) => observed.push(element),
          disconnect: vi.fn(),
          unobserve: vi.fn(),
        };
      }),
    );

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);

    const heroForm = document.getElementById("waitlist-form")!;
    const stickyBarInstance = instances.find((instance) => instance.observed.includes(heroForm));
    if (!stickyBarInstance) {
      throw new Error("Expected an IntersectionObserver instance observing the hero form.");
    }

    expect(container.textContent).not.toContain(t("publicPresence.home.stickyCta.label"));

    act(() => {
      stickyBarInstance.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(container.textContent).not.toContain(t("publicPresence.home.stickyCta.label"));

    act(() => {
      stickyBarInstance.callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(document.body.textContent).toContain(t("publicPresence.home.stickyCta.label"));

    const stickyCta = document.body.querySelector<HTMLAnchorElement>('.fixed a[href="/#waitlist-form-final"]');
    if (!stickyCta) {
      throw new Error("Expected the sticky bar's CTA to render once visible.");
    }
    fireEvent.click(stickyCta);
    expect(window.dataLayer).toContainEqual(
      expect.objectContaining({ event: "cta_clicked", section: "mobile_sticky", target: "waitlist_form_final" }),
    );
  });

  it("renders every hero copy key, call-time CTA/link label, and game-roster label byte-exact per variant (AC6)", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const gameRosterLabels: readonly (readonly [string, string])[] = [
      ["pokemon", t("publicPresence.home.gameRoster.game.pokemon")],
      ["magic-the-gathering", t("publicPresence.home.gameRoster.game.magicTheGathering")],
      ["yu-gi-oh", t("publicPresence.home.gameRoster.game.yuGiOh")],
      ["one-piece-card-game", t("publicPresence.home.gameRoster.game.onePieceCardGame")],
      ["disney-lorcana", t("publicPresence.home.gameRoster.game.disneyLorcana")],
    ];

    const variants = [
      {
        pageSource: source,
        heroEyebrow: t("publicPresence.home.eyebrow"),
        heroTitle: t("publicPresence.home.title"),
        heroDescription: t("publicPresence.home.description"),
      },
      {
        pageSource: { ...source, pagePath: "/?intent=buy" },
        heroEyebrow: t("publicPresence.home.buyerHero.eyebrow"),
        heroTitle: t("publicPresence.home.buyerHero.title"),
        heroDescription: t("publicPresence.home.buyerHero.description"),
      },
    ];

    for (const variant of variants) {
      const { container } = render(<PublicPresenceHomePage actionData={null} source={variant.pageSource} />);

      const heroSection = container.querySelector('[data-public-presence-section="hero"]');
      if (!heroSection) throw new Error("Expected the hero section to render.");
      const titleEl = heroSection.querySelector("h1");
      if (!titleEl) throw new Error("Expected the hero h1 to render.");
      expect(titleEl.textContent).toBe(variant.heroTitle);
      expect(titleEl.previousElementSibling?.textContent).toBe(variant.heroEyebrow);
      expect(titleEl.nextElementSibling?.textContent).toBe(variant.heroDescription);

      expect(container.querySelector('nav a[href="/#waitlist-form"]')?.textContent).toBe(
        t("publicPresence.nav.waitlist"),
      );
      expect(container.querySelector('footer a[href="/help"]')?.textContent).toBe(t("publicPresence.nav.help"));
      expect(container.querySelector('footer a[href="/terms"]')?.textContent).toBe(t("publicPresence.nav.terms"));
      expect(container.querySelector('footer a[href="/privacy"]')?.textContent).toBe(t("publicPresence.nav.privacy"));
      expect(container.querySelector('footer a[href="/refunds-and-returns"]')?.textContent).toBe(
        t("publicPresence.nav.refunds"),
      );
      expect(container.querySelector('footer a[href="/order-protection"]')?.textContent).toBe(
        t("publicPresence.nav.buyerProtection"),
      );
      expect(container.querySelector('footer a[href="/sales-fees"]')?.textContent).toBe(
        t("publicPresence.nav.sellerFees"),
      );
      expect(container.querySelector('footer a[href="/founders"]')?.textContent).toBe(
        t("publicPresence.nav.foundersTerms"),
      );
      expect(container.querySelector('footer a[href="/contact"]')?.textContent).toBe(t("publicPresence.nav.contact"));

      const rosterSection = container.querySelector('[data-public-presence-section="game_roster"]');
      if (!rosterSection) throw new Error("Expected the game roster section to render.");
      for (const [slug, label] of gameRosterLabels) {
        const tile = Array.from(rosterSection.querySelectorAll<HTMLAnchorElement>("a")).find((anchor) =>
          anchor.getAttribute("href")?.includes(`game=${slug}`),
        );
        if (!tile) throw new Error(`Expected a game-roster tile for ${slug}.`);
        expect(tile.textContent).toBe(label);
      }

      const sellerToolsSection = container.querySelector('[data-public-presence-section="seller_tools"]');
      expect(sellerToolsSection?.querySelector('a[href="/#waitlist-form-final"]')?.textContent).toBe(
        t("publicPresence.home.sellerTools.cta.action"),
      );

      const foundersSection = container.querySelector('[data-public-presence-section="founders_offer"]');
      expect(foundersSection?.querySelector('a[href="/founders"]')?.textContent).toBe(
        t("publicPresence.home.foundersOffer.action"),
      );

      const timelineSection = container.querySelector('[data-public-presence-section="launch_timeline"]');
      expect(timelineSection?.querySelector('a[href="/#waitlist-form"]')?.textContent).toBe(
        t("publicPresence.home.launchTimeline.action"),
      );

      const previewSection = container.querySelector('[data-public-presence-section="product_preview"]');
      if (!previewSection) throw new Error("Expected the product preview section to render.");
      expect(previewSection.querySelector('a[href="/#waitlist-form"]')?.textContent).toBe(
        t("publicPresence.preview.listing.action"),
      );
      const orderProtectionLinks = Array.from(
        previewSection.querySelectorAll<HTMLAnchorElement>('a[href="/order-protection"]'),
      ).map((anchor) => anchor.textContent);
      expect(orderProtectionLinks).toHaveLength(2);
      expect(orderProtectionLinks).toEqual(
        expect.arrayContaining([
          t("publicPresence.preview.listing.secondaryAction"),
          t("publicPresence.preview.total.protectionLink"),
        ]),
      );

      const finalCtaSection = container.querySelector('[data-public-presence-section="final_cta"]');
      expect(finalCtaSection?.querySelector('a[href="/founders"]')?.textContent).toBe(
        t("publicPresence.home.foundersOffer.action"),
      );

      const faqSection = container.querySelector('[data-public-presence-section="faq"]');
      expect(faqSection?.querySelector('a[href="/faq"]')?.textContent).toBe(t("publicPresence.faq.all"));
    }
  });

  it.each([
    { label: "seller_first_v1", pageSource: source, variant: "seller_first_v1" },
    { label: "seller_first_v2", pageSource: { ...source, pagePath: "/?intent=buy" }, variant: "seller_first_v2" },
  ])(
    "fires section_viewed exactly once per section for the $label variant, deduping a repeat intersection (AC7)",
    ({ pageSource, variant }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
        ),
      );
      window.dataLayer = [];

      const instances: { callback: IntersectionObserverCallback; observed: Element[] }[] = [];
      vi.stubGlobal(
        "IntersectionObserver",
        vi.fn(function IntersectionObserverStub(callback: IntersectionObserverCallback) {
          const observed: Element[] = [];
          instances.push({ callback, observed });
          return {
            observe: (element: Element) => observed.push(element),
            disconnect: vi.fn(),
            unobserve: vi.fn(),
          };
        }),
      );

      const { events, stop } = captureAnalyticsEvents();

      render(<PublicPresenceHomePage actionData={null} source={pageSource} />);

      const expectedSections = [
        "hero",
        "game_roster",
        "open_offers",
        "seller_tools",
        "fee_comparison",
        "founders_offer",
        "launch_timeline",
        "product_preview",
        "founder_story",
        "final_cta",
        "faq",
      ];
      const sectionElements = Array.from(document.querySelectorAll<HTMLElement>("[data-public-presence-section]"));
      expect(sectionElements.map((element) => element.getAttribute("data-public-presence-section"))).toEqual(
        expectedSections,
      );

      // Two IntersectionObserver instances mount: MobileStickyWaitlistCta's
      // (observing only the hero form) and useLandingSectionViewTracking's
      // (observing every section). Identify the latter by observed-set
      // membership rather than mount order.
      const sectionInstance = instances.find((instance) =>
        sectionElements.every((element) => instance.observed.includes(element)),
      );
      if (!sectionInstance) {
        throw new Error("Expected an IntersectionObserver instance observing every landing section.");
      }

      for (const element of sectionElements) {
        act(() => {
          sectionInstance.callback(
            [{ target: element, isIntersecting: true } as IntersectionObserverEntry],
            {} as IntersectionObserver,
          );
        });
      }

      const sectionViewedEvents = events.filter((detail) => detail.event === "section_viewed");
      expect(sectionViewedEvents).toHaveLength(expectedSections.length);
      for (const section of expectedSections) {
        expect(sectionViewedEvents).toContainEqual({ event: "section_viewed", section, variant });
      }

      // Repeating the same intersecting entries must not refire section_viewed:
      // this is the executed proof of the viewedSections Set + observer.unobserve
      // dedupe, not just of the event shape.
      for (const element of sectionElements) {
        act(() => {
          sectionInstance.callback(
            [{ target: element, isIntersecting: true } as IntersectionObserverEntry],
            {} as IntersectionObserver,
          );
        });
      }
      expect(events.filter((detail) => detail.event === "section_viewed")).toHaveLength(expectedSections.length);

      stop();
    },
  );

  it("fires the exact cta_clicked window-event detail for every previously-uncovered trackCtaClick site (AC7)", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];
    const { events, stop } = captureAnalyticsEvents();

    const { container } = render(
      <PublicPresenceHomePage actionData={null} discordInviteUrl="https://discord.gg/chase-sets" source={source} />,
    );

    function clickAndExpect(selector: string, scope: ParentNode, expected: Record<string, unknown>) {
      const target = scope.querySelector<HTMLElement>(selector);
      if (!target) {
        throw new Error(`Expected an element matching ${selector} to render.`);
      }
      const before = events.length;
      fireEvent.click(target);
      expect(events.slice(before).filter((detail) => detail.event === "cta_clicked")).toEqual([
        { event: "cta_clicked", ...expected },
      ]);
    }

    const founderStorySection = container.querySelector('[data-public-presence-section="founder_story"]');
    if (!founderStorySection) throw new Error("Expected the founder-story section to render.");
    clickAndExpect('a[href="https://discord.gg/chase-sets"]', founderStorySection, {
      section: "founder_story",
      target: "discord",
      variant: "seller_first_v1",
    });

    const navSurface = container.querySelector("nav");
    if (!navSurface) throw new Error("Expected the nav to render.");
    clickAndExpect('a[href="/#waitlist-form"]', navSurface, {
      section: "nav",
      target: "waitlist_form",
      variant: "seller_first_v1",
    });

    const rosterSection = container.querySelector('[data-public-presence-section="game_roster"]');
    if (!rosterSection) throw new Error("Expected the game roster section to render.");
    const pokemonTile = Array.from(rosterSection.querySelectorAll<HTMLAnchorElement>("a")).find((anchor) =>
      anchor.getAttribute("href")?.includes("game=pokemon"),
    );
    if (!pokemonTile) throw new Error("Expected a Pokemon game-roster tile.");
    const beforeRoster = events.length;
    fireEvent.click(pokemonTile);
    expect(events.slice(beforeRoster).filter((detail) => detail.event === "cta_clicked")).toEqual([
      { event: "cta_clicked", section: "game_roster", target: "pokemon", variant: "seller_first_v1" },
    ]);

    const foundersSection = container.querySelector('[data-public-presence-section="founders_offer"]');
    if (!foundersSection) throw new Error("Expected the founders-offer section to render.");
    clickAndExpect('a[href="/founders"]', foundersSection, {
      section: "founders_offer",
      target: "founders_terms",
      variant: "seller_first_v1",
    });

    const timelineSection = container.querySelector('[data-public-presence-section="launch_timeline"]');
    if (!timelineSection) throw new Error("Expected the launch-timeline section to render.");
    clickAndExpect('a[href="/#waitlist-form"]', timelineSection, {
      section: "launch_timeline",
      target: "waitlist_form",
      variant: "seller_first_v1",
    });

    const previewSection = container.querySelector('[data-public-presence-section="product_preview"]');
    if (!previewSection) throw new Error("Expected the product-preview section to render.");
    clickAndExpect('a[href="/#waitlist-form"]', previewSection, {
      section: "product_preview",
      target: "waitlist_form",
      variant: "seller_first_v1",
    });

    const orderProtectionCta = Array.from(
      previewSection.querySelectorAll<HTMLAnchorElement>('a[href="/order-protection"]'),
    ).find((anchor) => anchor.textContent === t("publicPresence.preview.listing.secondaryAction"));
    if (!orderProtectionCta) throw new Error("Expected the product-preview order-protection CTA to render.");
    const beforeOrderProtection = events.length;
    fireEvent.click(orderProtectionCta);
    expect(events.slice(beforeOrderProtection).filter((detail) => detail.event === "cta_clicked")).toEqual([
      { event: "cta_clicked", section: "product_preview", target: "order_protection", variant: "seller_first_v1" },
    ]);

    const finalCtaSection = container.querySelector('[data-public-presence-section="final_cta"]');
    if (!finalCtaSection) throw new Error("Expected the final-CTA section to render.");
    clickAndExpect('a[href="/founders"]', finalCtaSection, {
      section: "final_cta",
      target: "founders_terms",
      variant: "seller_first_v1",
    });

    const faqSection = container.querySelector('[data-public-presence-section="faq"]');
    if (!faqSection) throw new Error("Expected the FAQ section to render.");
    clickAndExpect('a[href="/faq"]', faqSection, {
      section: "faq",
      target: "faq",
      variant: "seller_first_v1",
    });

    stop();
  });

  it("keeps the seller_tools CTA's cta_clicked payload variant-less even from the buyer (seller_first_v2) landing context (AC7)", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];
    const { events, stop } = captureAnalyticsEvents();

    const { container } = render(
      <PublicPresenceHomePage actionData={null} source={{ ...source, pagePath: "/?intent=buy" }} />,
    );

    const sellerToolsSection = container.querySelector('[data-public-presence-section="seller_tools"]');
    const cta = sellerToolsSection?.querySelector('a[href="/#waitlist-form-final"]');
    if (!cta) {
      throw new Error("Expected the seller-tools CTA to render.");
    }

    fireEvent.click(cta);

    expect(events.filter((detail) => detail.event === "cta_clicked")).toEqual([
      { event: "cta_clicked", section: "seller_tools", target: "waitlist_form_final", variant: "seller_first_v1" },
    ]);

    stop();
  });
});

function repositoryRoot(): string {
  let candidate = process.cwd();
  while (!existsSync(join(candidate, "pnpm-workspace.yaml"))) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(`Could not locate the repository root from ${process.cwd()}`);
    }
    candidate = parent;
  }
  return candidate;
}

describe("landing surface-diet census (AC5)", () => {
  const publicPagesSource = readFileSync(
    join(repositoryRoot(), "bounded-contexts", "public-presence", "features", "waitlist", "ui", "public-pages.tsx"),
    "utf8",
  );

  function surfaceElements(source: string) {
    const sourceFile = ts.createSourceFile("public-pages.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const results: { elevation: string | null; elevatedBoolean: boolean }[] = [];
    function attributeValue(attributes: ts.JsxAttributes, name: string) {
      return attributes.properties.find(
        (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === name,
      );
    }
    function visit(node: ts.Node) {
      const isSurface =
        (ts.isJsxSelfClosingElement(node) && node.tagName.getText(sourceFile) === "Surface") ||
        (ts.isJsxOpeningElement(node) && node.tagName.getText(sourceFile) === "Surface");
      if (isSurface) {
        const attributes = (node as ts.JsxSelfClosingElement | ts.JsxOpeningElement).attributes;
        const elevationAttribute = attributeValue(attributes, "elevation");
        const elevatedAttribute = attributeValue(attributes, "elevated");
        let elevation: string | null = null;
        if (
          elevationAttribute &&
          ts.isJsxAttribute(elevationAttribute) &&
          elevationAttribute.initializer &&
          ts.isStringLiteral(elevationAttribute.initializer)
        ) {
          elevation = elevationAttribute.initializer.text;
        }
        results.push({ elevation, elevatedBoolean: Boolean(elevatedAttribute) });
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return results;
  }

  it("gives every landing Surface root an explicit elevation intent, leaving exactly one legacy elevated boolean", () => {
    const surfaces = surfaceElements(publicPagesSource);
    // 2 shell roots (nav/footer, neither prop) + 11 landing roots (explicit
    // elevation) + 1 PublicInfoPage root (legacy elevated boolean) = 14,
    // matching the source-derived census.
    expect(surfaces).toHaveLength(14);

    const explicitElevation = surfaces.filter((surface) => surface.elevation !== null);
    const legacyElevated = surfaces.filter((surface) => surface.elevation === null && surface.elevatedBoolean);
    const untouchedShellRoots = surfaces.filter((surface) => surface.elevation === null && !surface.elevatedBoolean);

    expect(explicitElevation).toHaveLength(11);
    expect(legacyElevated).toHaveLength(1);
    expect(untouchedShellRoots).toHaveLength(2);

    expect(explicitElevation.filter((surface) => surface.elevation === "elevated")).toHaveLength(2);
    expect(explicitElevation.filter((surface) => surface.elevation === "tinted")).toHaveLength(9);
  });
});
