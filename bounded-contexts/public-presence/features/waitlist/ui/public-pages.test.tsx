import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { act, cleanup, fireEvent, render as renderWithoutRouter, type RenderOptions } from "@testing-library/react";
import { Children, type ComponentProps, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveChaseMotion, type StaggerProps } from "@chase-sets/design-system";
import ts from "@chase-sets/typescript-compiler-api";
import { checkoutFeeTranslationValues, fallbackCheckoutFeePreview } from "./checkout-fee-preview";
import { landingFaqEntries } from "./landing-faq";
import { developerArticles } from "../../developer-portal/domain/developer-article-catalog";
import { DeveloperArticlePage, DeveloperPortalPage } from "../../developer-portal/ui/developer-pages";
import { helpCategories, publicHelpArticles } from "../../help/domain/article-catalog";
import { HelpArticlePage, HelpCategoryPage, HelpHubPage } from "../../help/ui/help-pages";
import { PrivacyPolicyRouteAdapter } from "../../policies/ui/policy-artifact-route-adapter";
import { ComparePage } from "./compare-page";
import { PublicInfoPage, PublicPresenceHomePage } from "./public-pages";
import { publicPresenceT as t } from "./public-presence-translator";
import { WaitlistSuccessPage } from "./success-page";

const titleOverrides = vi.hoisted(() => new Map<string, string>());
const staggerRenders = vi.hoisted(() => [] as StaggerProps[]);
vi.mock("@chase-sets/design-system", async (importOriginal) => {
  const original = await importOriginal<typeof import("@chase-sets/design-system")>();
  return {
    ...original,
    Surface: (props: ComponentProps<typeof original.Surface>) => <original.Surface {...props} data-test-surface />,
    Stagger: (props: ComponentProps<typeof original.Stagger>) => {
      staggerRenders.push(props);
      return <original.Stagger {...props} />;
    },
  };
});
vi.mock("./public-presence-translator", async (importOriginal) => {
  const original = await importOriginal<typeof import("./public-presence-translator")>();
  return {
    ...original,
    publicPresenceT: (key: string, values?: Parameters<typeof original.publicPresenceT>[1]) =>
      titleOverrides.get(key) ?? original.publicPresenceT(key, values),
  };
});

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
const publicPagesSource = readFileSync(
  join(repositoryRoot(), "bounded-contexts", "public-presence", "features", "waitlist", "ui", "public-pages.tsx"),
  "utf8",
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  titleOverrides.clear();
  staggerRenders.length = 0;
});

// The seven landing identities (#8503), in order, for both experiment variants.
const landingSectionOrder = [
  "hero",
  "game_roster",
  "open_offers",
  "fee_comparison",
  "founders_offer",
  "final_cta",
  "faq",
] as const;
// Section, disclosure and CTA identities retired from `/` by #8503 (AC4).
const retiredLandingIdentities = [
  "seller_tools",
  "fee_calculator",
  "fee_calculator_source_note",
  "launch_timeline",
  "launch_timeline_wave_qualification",
  "product_preview",
  "product_preview_trust",
  "founder_story",
] as const;

const landingVariantCases = [
  { variant: "seller_first_v1", pagePath: "/" },
  { variant: "seller_first_v2", pagePath: "/?intent=buy" },
] as const;

const disclosureTargets = [["fee_comparison", "fee_comparison_source_note"]] as const;

describe("landing fine-print disclosures", () => {
  it.each(landingVariantCases)(
    "renders $variant at $pagePath with one collapsed mounted disclosure",
    ({ variant, pagePath }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ items: [] }))),
      );
      const { container } = render(<PublicPresenceHomePage actionData={null} source={{ ...source, pagePath }} />);
      const disclosures = container.querySelectorAll("[data-landing-disclosure]");
      expect([...disclosures].map((item) => item.getAttribute("data-landing-disclosure"))).toEqual(
        disclosureTargets.map(([, target]) => target),
      );
      expect([...disclosures].map((item) => item.querySelector("button")?.getAttribute("aria-expanded"))).toEqual([
        "false",
      ]);
      expect(
        container.querySelector(
          '[data-public-presence-section="fee_comparison"] [data-landing-disclosure="fee_comparison_source_note"]',
        ),
      ).not.toBeNull();
      expect(container.textContent).toContain(t("publicPresence.home.sellerEconomics.comparison.sourceNote"));
      expect(container.textContent).toContain(variant === "seller_first_v2" ? "The cards you need" : "marketplace");
    },
  );

  it("keeps the source note and every FAQ answer in SSR with closed triggers (AC2)", () => {
    const html = renderToString(
      <MemoryRouter>
        <PublicPresenceHomePage actionData={null} source={source} />
      </MemoryRouter>,
    );
    // One fine-print disclosure plus the four collapsed FAQ items.
    expect(html.match(/aria-expanded="false"/g) ?? []).toHaveLength(1 + landingFaqEntries.length);
    expect(html.match(/aria-expanded="true"/g) ?? []).toHaveLength(0);
    const text = html.replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
    expect(text).toContain(t("publicPresence.home.sellerEconomics.comparison.sourceNote"));
    for (const { question, answer } of landingFaqEntries) {
      expect(text).toContain(t(question));
      expect(text).toContain(t(answer, checkoutFeeTranslationValues(fallbackCheckoutFeePreview)));
    }
  });

  it.each(landingVariantCases)(
    "emits one bounded disclosure_opened for the source note across a remount, and none for FAQ items (AC4) in $variant",
    ({ variant, pagePath }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ items: [] }))),
      );
      window.dataLayer = [];
      const pageSource = { ...source, pagePath };
      const { container, rerender } = render(<PublicPresenceHomePage actionData={null} source={pageSource} />);
      const opened = () => (window.dataLayer ?? []).filter((event) => event.event === "disclosure_opened");
      const sourceNote = () =>
        container.querySelector<HTMLButtonElement>('[data-landing-disclosure="fee_comparison_source_note"] button')!;
      expect(opened()).toHaveLength(0);

      // FAQ items (prior art compare_faq) open and close without any event.
      const faqSection = container.querySelector('[data-public-presence-section="faq"]')!;
      const faqTriggers = [...faqSection.querySelectorAll<HTMLButtonElement>("button")];
      expect(faqTriggers).toHaveLength(landingFaqEntries.length);
      for (const trigger of faqTriggers) {
        fireEvent.click(trigger);
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
      }
      expect(opened()).toHaveLength(0);

      fireEvent.click(sourceNote());
      expect(sourceNote().getAttribute("aria-expanded")).toBe("true");
      const expected = [
        { event: "disclosure_opened", section: "fee_comparison", target: "fee_comparison_source_note", variant },
      ];
      expect(opened()).toEqual(expected);
      fireEvent.click(sourceNote());
      fireEvent.click(sourceNote());
      expect(opened()).toEqual(expected);

      // A new page view (new source object) resets the per-view dedupe.
      rerender(<PublicPresenceHomePage actionData={null} source={{ ...pageSource }} />);
      fireEvent.click(sourceNote());
      fireEvent.click(sourceNote());
      expect(opened()).toEqual([...expected, ...expected]);
    },
  );

  it("keeps no emitter for a retired landing identity in public-pages.tsx (AC4)", () => {
    for (const identity of retiredLandingIdentities) {
      expect(publicPagesSource, identity).not.toContain(identity);
    }
  });
});

describe("public waitlist form migration smoke", () => {
  it("renders the open_offers OfferCard outside every Surface ancestor without changing content order", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];
    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);
    const section = container.querySelector('[data-public-presence-section="open_offers"]');
    expect(section).not.toBeNull();
    const titles = Array.from(section!.querySelectorAll("h3"));
    const offerTitle = titles.find(
      (element) => element.textContent === t("publicPresence.home.openOffers.after.offerCard.title"),
    );
    expect(offerTitle).toBeDefined();
    expect(offerTitle!.closest("[data-test-surface]")).toBeNull();
    expect(offerTitle!.closest(".ds-glass")?.textContent).toContain(
      t("publicPresence.home.openOffers.after.offerCard.details"),
    );
    expect(titles.map((title) => title.textContent)).toEqual([
      t("publicPresence.home.openOffers.after.offerCard.title"),
    ]);
  });

  it.each(landingVariantCases)(
    "renders open_offers as #open-offers with its title, one OfferCard and the post, accept, checkout steps and no before/after cards in $variant (#8506 AC1)",
    ({ pagePath }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ items: [] }))),
      );
      const { container } = render(<PublicPresenceHomePage actionData={null} source={{ ...source, pagePath }} />);
      const section = container.querySelector<HTMLElement>('[data-public-presence-section="open_offers"]')!;
      expect(section).not.toBeNull();
      expect(section.id).toBe("open-offers");
      expect(container.querySelectorAll("#open-offers")).toHaveLength(1);
      expect(section.querySelector("h2")?.textContent).toBe(t("publicPresence.home.openOffers.title"));

      // One OfferCard: its title is the section's only card title.
      expect([...section.querySelectorAll("h3")].map((title) => title.textContent)).toEqual([
        t("publicPresence.home.openOffers.after.offerCard.title"),
      ]);
      expect(section.querySelectorAll(".ds-glass")).toHaveLength(1);

      const steps = [...section.querySelectorAll<HTMLElement>("[data-open-offers-step]")];
      expect(steps.map((step) => step.textContent)).toEqual(
        ["post", "accept", "checkout"].map(
          (step, index) => `${index + 1}${t(`publicPresence.home.openOffers.step.${step}`)}`,
        ),
      );

      // The before/after cards were tinted Surfaces carrying this copy.
      expect(section.querySelector("[data-test-surface]")).toBeNull();
      for (const retired of ["The old way", "Social card groups", "On Chase Sets", "Post it once."]) {
        expect(section.textContent, retired).not.toContain(retired);
      }
    },
  );

  it("plays the open_offers steps once in view and finishes within 5,000ms, with no video, canvas or image (#8506 AC2)", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }))),
    );
    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);
    const section = container.querySelector<HTMLElement>('[data-public-presence-section="open_offers"]')!;

    expect(staggerRenders.length).toBeGreaterThan(0);
    const props = staggerRenders.at(-1)!;
    expect(props.trigger).toBe("in-view");
    const steps = Children.count(props.children);
    expect(steps).toBe(3);
    expect(section.querySelectorAll("[data-open-offers-step]")).toHaveLength(steps);

    const motion = resolveChaseMotion();
    const preset = props.preset ?? "lift";
    const presetDurationMs = (motion.presets[preset].transition?.duration ?? Number.NaN) * 1_000;
    if (preset === "lift") {
      expect(presetDurationMs).toBe(motion.durations.base * 1_000);
    }
    const staggerMs = props.staggerMs ?? 70;
    const sequenceMs = (steps - 1) * staggerMs + presetDurationMs;
    expect(sequenceMs).toBeGreaterThan(0);
    expect(sequenceMs).toBeLessThanOrEqual(5_000);

    expect(section.querySelector("video, canvas, img, picture, object, embed, iframe")).toBeNull();
  });

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

  it("renders the Discord CTA only in the final section, and hides it when unconfigured", () => {
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
    // #8503 removed founder_story, the only other Discord placement.
    expect(discordLinks).toHaveLength(1);
    const finalCtaSection = container.querySelector('[data-public-presence-section="final_cta"]');
    expect(finalCtaSection?.querySelector('a[href="https://discord.gg/chase-sets"]')).not.toBeNull();

    rerender(<PublicPresenceHomePage actionData={null} discordInviteUrl={null} source={source} />);
    expect(container.querySelectorAll('a[href="https://discord.gg/chase-sets"]').length).toBe(0);
  });

  it("renders the open-offers section ahead of the fee comparison, with a sample offer mock and no unrecorded demo placeholder", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);

    const offersSection = container.querySelector('[data-public-presence-section="open_offers"]');
    const feeComparisonSection = container.querySelector('[data-public-presence-section="fee_comparison"]');
    if (!offersSection || !feeComparisonSection) {
      throw new Error("Expected both the open-offers and fee-comparison sections to render.");
    }

    // DOCUMENT_POSITION_FOLLOWING (4) on feeComparisonSection means offersSection comes first.
    expect(offersSection.compareDocumentPosition(feeComparisonSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(offersSection.textContent).toContain(t("publicPresence.home.openOffers.after.offerCard.title"));
    // #5617: the demo/video placeholder is hidden until a recording ships.
    expect(offersSection.textContent).not.toContain("Watch a 30-second offer get posted and accepted");
  });

  it.each(landingVariantCases)(
    "keeps fee_comparison to the three You-keep values, the source note and a /compare/tcgplayer link in $variant (AC2)",
    ({ pagePath }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
        ),
      );
      window.dataLayer = [];

      const { container } = render(<PublicPresenceHomePage actionData={null} source={{ ...source, pagePath }} />);

      const feeComparisonSection = container.querySelector('[data-public-presence-section="fee_comparison"]');
      if (!feeComparisonSection) {
        throw new Error("Expected the fee-comparison section to render.");
      }

      expect(feeComparisonSection.querySelector("h2")?.textContent).toBe(
        t("publicPresence.home.sellerEconomics.comparison.title"),
      );
      // Exactly one table with exactly one body row: the kept amount per marketplace.
      expect(feeComparisonSection.querySelectorAll("table")).toHaveLength(1);
      const rows = [...feeComparisonSection.querySelectorAll("tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent),
      );
      expect(rows).toEqual([
        [
          t("publicPresence.home.sellerEconomics.comparison.row.youKeep.label"),
          t("publicPresence.home.sellerEconomics.comparison.row.youKeep.chaseSets"),
          t("publicPresence.home.sellerEconomics.comparison.row.youKeep.tcgplayer"),
          t("publicPresence.home.sellerEconomics.comparison.row.youKeep.ebay"),
        ],
      ]);
      expect([...feeComparisonSection.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual([
        t("publicPresence.home.sellerEconomics.comparison.column.metric"),
        t("publicPresence.home.sellerEconomics.comparison.column.chaseSets"),
        t("publicPresence.home.sellerEconomics.comparison.column.tcgplayer"),
        t("publicPresence.home.sellerEconomics.comparison.column.ebay"),
      ]);
      // The removed rows, worked examples and description are gone, including from the caption (F6).
      expect(feeComparisonSection.textContent).not.toContain("Marketplace fee");
      expect(feeComparisonSection.textContent).not.toContain("per-order");
      expect(feeComparisonSection.textContent).not.toContain("founder math");
      expect(feeComparisonSection.textContent).not.toContain("beta seller math");
      expect(feeComparisonSection.querySelector("caption")).toBeNull();
      expect(feeComparisonSection.textContent).toContain(
        t("publicPresence.home.sellerEconomics.comparison.sourceNote"),
      );

      const compareLink = feeComparisonSection.querySelector<HTMLAnchorElement>('a[href="/compare/tcgplayer"]');
      expect(compareLink?.textContent).toBe(t("publicPresence.home.sellerEconomics.comparison.compareLink"));
      expect(feeComparisonSection.querySelectorAll("a")).toHaveLength(1);
      // The landing calculator is gone: no calculator anchor renders anywhere on `/`.
      expect(document.getElementById("fee-calculator")).toBeNull();
      expect(document.getElementById("product-preview")).toBeNull();
      expect(document.getElementById("seller-tools")).toBeNull();
    },
  );

  it("keeps founders_offer to its title, description and /founders link, with the footer terms link (AC2)", () => {
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
    if (!feeComparisonSection || !foundersSection) {
      throw new Error("Expected fee-comparison and founders-offer sections to render.");
    }

    // DOCUMENT_POSITION_FOLLOWING (4) means the founders section still renders
    // after fee comparison ("immediately after the fees section", #4081).
    expect(feeComparisonSection.compareDocumentPosition(foundersSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    expect(foundersSection.querySelector("h2")?.textContent).toBe(t("publicPresence.home.foundersOffer.title"));
    expect(foundersSection.textContent).toContain(t("publicPresence.home.foundersOffer.description"));
    expect(foundersSection.textContent).toContain("500");
    // #8503: the badge row and the five-point list are gone; the terms live on /founders.
    expect(foundersSection.textContent).not.toContain("Capped at 500 founders");
    expect(foundersSection.querySelectorAll("li")).toHaveLength(0);
    expect(foundersSection.querySelectorAll("a")).toHaveLength(1);
    expect(foundersSection.querySelector('a[href="/founders"]')?.textContent).toBe(
      t("publicPresence.home.foundersOffer.action"),
    );

    expect(container.querySelector('footer a[href="/founders"]')?.textContent).toBe(
      t("publicPresence.nav.foundersTerms"),
    );
  });

  it("renders all four FAQ questions collapsed, in JSON-LD order, with answers in the DOM and the All-FAQs link (AC2)", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);

    const foundersSection = container.querySelector('[data-public-presence-section="founders_offer"]');
    const faqSection = container.querySelector('[data-public-presence-section="faq"]');
    if (!foundersSection || !faqSection) {
      throw new Error("Expected founders-offer and FAQ sections to render.");
    }
    expect(foundersSection.compareDocumentPosition(faqSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    const triggers = [...faqSection.querySelectorAll<HTMLButtonElement>("button")];
    expect(triggers.map((trigger) => trigger.textContent)).toEqual(
      landingFaqEntries.map(({ question }) => t(question)),
    );
    expect(triggers.map((trigger) => trigger.getAttribute("aria-expanded"))).toEqual(
      landingFaqEntries.map(() => "false"),
    );
    const answerValues = checkoutFeeTranslationValues(fallbackCheckoutFeePreview);
    for (const { answer } of landingFaqEntries) {
      expect(faqSection.textContent).toContain(t(answer, answerValues));
    }
    // The launch answer states the undated access order (timing moved here from launch_timeline).
    expect(faqSection.textContent).toMatch(/waitlist.*numbered beta invite waves.*open signup/i);
    expect(container.innerHTML).not.toContain("September 1, 2026");
    expect(container.innerHTML).not.toContain("late July 2026");
    expect(faqSection.textContent).not.toContain("{publicLaunchDate}");
    // No per-question Surface cards remain: the four items are one disclosure group.
    expect(faqSection.querySelectorAll("[data-test-surface]")).toHaveLength(0);
    expect(faqSection.querySelector('a[href="/faq"]')?.textContent).toBe(t("publicPresence.faq.all"));
  });

  // #8606: the hero and FAQ bound the 0% claim to the founder 60-day window
  // and never claim the seller keeps 100% (the Order Protection contribution
  // applies to every order). Pinned as literal copy, not via t(), so a locale
  // edit that reintroduces the claim fails here as well as in the guard.
  it("renders the hero highlight and FAQ fee answer bounded to the founder 60-day window (#8606 AC2)", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} />);

    const heroSection = container.querySelector('[data-public-presence-section="hero"]');
    const faqSection = container.querySelector('[data-public-presence-section="faq"]');
    if (!heroSection || !faqSection) {
      throw new Error("Expected hero and FAQ sections to render.");
    }

    const highlightCells = Array.from(
      heroSection.querySelector('[aria-label="Marketing highlights"]')?.children ?? [],
    ).map((cell) => cell.textContent);
    expect(highlightCells).toContain("Founders window0% sales fee on listings you create in your first 60 days of beta");
    expect(heroSection.textContent).not.toContain("Keep 100% of the sale");
    expect(heroSection.textContent).not.toContain("0% beta seller fees");
    expect(heroSection.textContent).not.toContain("0% fees during beta");

    expect(faqSection.textContent).toContain(
      "Listings you create in your first 60 days of beta lock a 0% sales fee until they sell. Listings created after that window lock the published standard sales fee at listing time.",
    );
    expect(faqSection.textContent).not.toContain("Listings created during beta keep a 0% seller fee");
    expect(container.textContent).not.toContain("100%");
  });

  it.each([
    { role: "both", pagePath: "/" },
    { role: "buy", pagePath: "/?intent=buy" },
  ])(
    "posts email, role, interest and consent from the final form with no seller-inventory fields for role=$role (AC3)",
    ({ role, pagePath }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
        ),
      );
      window.dataLayer = [];

      render(<PublicPresenceHomePage actionData={null} source={{ ...source, pagePath }} />);

      const panel = document.getElementById("waitlist-form-final");
      const form = panel?.querySelector("form");
      if (!form) {
        throw new Error("Expected final-CTA waitlist panel to render a form.");
      }

      // Field inventory: every control the final form renders, by name.
      const controlNames = [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")].map(
        (control) => `${control.tagName.toLowerCase()}[${control.type}]:${control.name}`,
      );
      expect(controlNames).toEqual([
        "input[email]:email",
        "select[select-one]:role",
        "select[select-one]:interests",
        "input[checkbox]:marketingConsent",
        "input[text]:website",
        "input[hidden]:pagePath",
        "input[hidden]:referrer",
        "input[hidden]:utmSource",
        "input[hidden]:utmMedium",
        "input[hidden]:utmCampaign",
        "input[hidden]:utmContent",
        "input[hidden]:utmTerm",
        "input[hidden]:referredBySignupId",
        "input[hidden]:landingExperimentVariant",
      ]);
      for (const name of ["games", "inventorySize", "hasStoreLink", "storeUrl"]) {
        expect(form.querySelector(`[name="${name}"]`), name).toBeNull();
      }
      expect(form.textContent).not.toContain("Takes under a minute");

      fireEvent.change(form.querySelector('input[name="email"]')!, { target: { value: "seller@example.com" } });
      fireEvent.change(form.querySelector('select[name="interests"]')!, { target: { value: "bulk-listing" } });
      fireEvent.click(form.querySelector('input[name="marketingConsent"]')!);

      const formData = new FormData(form);
      expect(form.getAttribute("method")).toBe("post");
      expect(form.getAttribute("action")).toBe("?index");
      expect(formData.get("email")).toBe("seller@example.com");
      expect(formData.get("role")).toBe(role);
      expect(formData.get("interests")).toBe("bulk-listing");
      expect(formData.get("marketingConsent")).toBe("yes");
      expect(formData.getAll("games")).toEqual([]);
      expect(formData.has("inventorySize")).toBe(false);
      expect(formData.has("hasStoreLink")).toBe(false);
      expect(formData.has("storeUrl")).toBe(false);
    },
  );

  it("keeps the final_cta heading, description, founder byline and links, with no badge or point list (AC2)", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(
      <PublicPresenceHomePage actionData={null} discordInviteUrl="https://discord.gg/chase-sets" source={source} />,
    );

    const finalCtaSection = container.querySelector('[data-public-presence-section="final_cta"]');
    if (!finalCtaSection) {
      throw new Error("Expected the final-CTA section to render.");
    }
    expect([...finalCtaSection.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      t("publicPresence.home.finalCta.title"),
      t("publicPresence.waitlist.formTitle"),
    ]);
    expect(finalCtaSection.textContent).toContain(t("publicPresence.home.finalCta.description"));
    expect(finalCtaSection.querySelector("[data-public-presence-founder-byline]")?.textContent).toBe(
      t("publicPresence.home.finalCta.byline", {
        name: t("publicPresence.home.founderStory.name"),
        role: t("publicPresence.home.founderStory.role"),
      }),
    );
    expect(finalCtaSection.textContent).toContain("Todd Skelton, Founder, Chase Sets");
    expect(finalCtaSection.textContent).not.toContain("Takes under a minute");
    expect(finalCtaSection.querySelectorAll("li")).toHaveLength(0);
    // The signup panel's own "Early access" header badge is untouched; it is the only badge left in the section.
    const panelBadge = t("publicPresence.waitlist.badge");
    expect(finalCtaSection.textContent?.split(panelBadge)).toHaveLength(2);
    expect(finalCtaSection.querySelector('a[href="https://discord.gg/chase-sets"]')).not.toBeNull();
    expect(finalCtaSection.querySelector('a[href="/founders"]')?.textContent).toBe(
      t("publicPresence.home.foundersOffer.action"),
    );
    expect(document.getElementById("waitlist-form-final")).not.toBeNull();
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

  it("posts the ?game= prefill from the final-CTA form as a hidden games value with no visible games control (AC3)", () => {
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
    const gamesInputs = [...form.querySelectorAll<HTMLInputElement>('input[name="games"]')];
    expect(gamesInputs.map((input) => input.type)).toEqual(["hidden"]);
    expect(form.querySelector('input[type="checkbox"][name="games"]')).toBeNull();
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

  it.each(landingVariantCases)(
    "#8503 AC1: renders exactly the seven surviving section identities in order for $variant",
    ({ pagePath }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
        ),
      );
      window.dataLayer = [];

      const { container } = render(<PublicPresenceHomePage actionData={null} source={{ ...source, pagePath }} />);

      const sections = Array.from(container.querySelectorAll<HTMLElement>("[data-public-presence-section]")).map(
        (section) => section.getAttribute("data-public-presence-section"),
      );
      expect(sections).toEqual([...landingSectionOrder]);

      // The #5617 cuts stay cut, and the #8503 cuts never render, hidden or otherwise.
      for (const identity of [
        "signup_expectations",
        "marketplace_model",
        "audience_paths",
        "seller_economics",
        "balance_flywheel",
        ...retiredLandingIdentities,
      ]) {
        expect(container.querySelector(`[data-public-presence-section="${identity}"]`), identity).toBeNull();
      }
      for (const id of ["seller-tools", "product-preview", "fee-calculator"]) {
        expect(document.getElementById(id), id).toBeNull();
      }
    },
  );

  it("#5617: preserves the hero and final-CTA form anchors and the game-prefill link mechanism", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} selectedGame="pokemon" />);

    // Both anchors survive #8503 unchanged: the sticky CTAs (and the nav) still target them.
    expect(document.getElementById("waitlist-form")).not.toBeNull();
    expect(document.getElementById("waitlist-form-final")).not.toBeNull();
    expect(container.querySelector('nav a[href="/#waitlist-form"]')).not.toBeNull();

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

    const heroEmail = heroForm.querySelector<HTMLInputElement>('input[name="email"]');
    const finalEmail = finalForm.querySelector<HTMLInputElement>('input[name="email"]');
    const roleSelect = finalForm.querySelector<HTMLSelectElement>('select[name="role"]');
    const interestsSelect = finalForm.querySelector<HTMLSelectElement>('select[name="interests"]');

    const landingTextControls = [heroEmail, finalEmail, roleSelect, interestsSelect];
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
    const heroSegmentedControl = heroForm.querySelector('[role="radiogroup"]');
    expect(marketingConsentCheckbox?.closest("label")?.className).not.toContain("text-base");
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

    // The fee-comparison Table renders at compact density with `wrapFirstColumn`,
    // which constrains the metric-label column to a narrow max-width and allows
    // mid-word breaks so the table fits a 375px viewport without the compact
    // density change alone (~8px/column savings) closing the ~30px overflow.
    const feeComparisonSection = container.querySelector('[data-public-presence-section="fee_comparison"]');
    const table = feeComparisonSection?.querySelector("table");
    expect(table?.parentElement?.className).toContain("overflow-x-auto");
    expect(table?.parentElement?.className).toContain("modern-surface");
    expect(feeComparisonSection?.querySelectorAll("table")).toHaveLength(1);
    expect(publicPagesSource).not.toMatch(/<table\b|overflow-x-auto/);
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

  it.each([
    { variant: "seller_first_v1", pagePath: source.pagePath },
    { variant: "seller_first_v2", pagePath: "/?intent=buy" },
  ])("leaves zero, subword and duplicate hero subjects plain in $variant", ({ pagePath, variant }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }))),
    );
    const key = variant === "seller_first_v1" ? "publicPresence.home.title" : "publicPresence.home.buyerHero.title";
    const word = variant === "seller_first_v1" ? "marketplace" : "cards";
    for (const title of [`No subject here.`, `The ${word}ful subject.`, `The ${word} and ${word}.`]) {
      titleOverrides.set(key, title);
      const { container, unmount } = render(
        <PublicPresenceHomePage actionData={null} source={{ ...source, pagePath }} />,
      );
      expect(container.querySelector("h1")?.textContent).toBe(title);
      expect(container.querySelector("h1 .ds-brand-foil-text")).toBeNull();
      unmount();
    }
  });

  it.each([
    { variant: "seller_first_v1", pagePath: source.pagePath },
    { variant: "seller_first_v2", pagePath: "/?intent=buy" },
  ])("maps DS-owned Surface intent by section in $variant", ({ pagePath }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }))),
    );
    // #8503: fee_comparison, founders_offer and faq no longer wrap content in
    // a Surface; the two signup panels are the only elevated roots.
    const expected: Record<(typeof landingSectionOrder)[number], string[]> = {
      hero: ["elevated"],
      game_roster: [],
      // #8506: the walkthrough steps are plain badge rows; the OfferCard is a
      // Card, never a Surface.
      open_offers: [],
      fee_comparison: [],
      founders_offer: [],
      final_cta: ["elevated"],
      faq: [],
    };
    const { container } = render(<PublicPresenceHomePage actionData={null} source={{ ...source, pagePath }} />);
    for (const [section, intents] of Object.entries(expected)) {
      const root = container.querySelector(`[data-public-presence-section="${section}"]`);
      expect(root, section).not.toBeNull();
      const surfaces = Array.from(root!.querySelectorAll<HTMLElement>(".min-w-0.max-w-full.rounded-tokenLg"));
      expect(
        surfaces.map((surface) =>
          surface.classList.contains("surface-border") || surface.classList.contains("shadow-tokenLg")
            ? "elevated"
            : surface.classList.contains("bg-surface-2")
              ? "tinted"
              : "unexpected",
        ),
        section,
      ).toEqual(intents);
    }
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

    const stickyCta = document.body.querySelector<HTMLAnchorElement>(
      '[data-public-presence-sticky-cta] a[href="/#waitlist-form-final"]',
    );
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

    const observerInstances: { callback: IntersectionObserverCallback; observed: Element[] }[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserverStub(callback: IntersectionObserverCallback) {
        const observed: Element[] = [];
        observerInstances.push({ callback, observed });
        return { observe: (element: Element) => observed.push(element), disconnect: vi.fn(), unobserve: vi.fn() };
      }),
    );

    const variants = [
      {
        pageSource: source,
        heroTitle: t("publicPresence.home.title"),
        heroDescription: t("publicPresence.home.description"),
      },
      {
        pageSource: { ...source, pagePath: "/?intent=buy" },
        heroTitle: t("publicPresence.home.buyerHero.title"),
        heroDescription: t("publicPresence.home.buyerHero.description"),
      },
    ];

    for (const variant of variants) {
      const { container, unmount } = render(
        <PublicPresenceHomePage
          actionData={null}
          source={variant.pageSource}
          discordInviteUrl="https://discord.gg/chase-sets"
        />,
      );

      expect(container.querySelector('nav a[href="/"] > span')?.textContent).toBe(t("publicPresence.brand"));
      const stickyObserver = observerInstances.find((instance) =>
        instance.observed.includes(document.getElementById("waitlist-form")!),
      );
      expect(stickyObserver).toBeDefined();
      act(() => {
        stickyObserver!.callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
      });
      expect(
        document.body.querySelector('[data-public-presence-sticky-cta] a[href="/#waitlist-form-final"]')?.textContent,
      ).toBe(t("publicPresence.home.stickyCta.action"));

      const heroSection = container.querySelector('[data-public-presence-section="hero"]');
      if (!heroSection) throw new Error("Expected the hero section to render.");
      const titleEl = heroSection.querySelector("h1");
      if (!titleEl) throw new Error("Expected the hero h1 to render.");
      expect(titleEl.textContent).toBe(variant.heroTitle);
      // The hero opens on the h1: no eyebrow sits above it (#8504).
      expect(titleEl.previousElementSibling).toBeNull();
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

      const feeComparisonSection = container.querySelector('[data-public-presence-section="fee_comparison"]');
      expect(feeComparisonSection?.querySelector('a[href="/compare/tcgplayer"]')?.textContent).toBe(
        t("publicPresence.home.sellerEconomics.comparison.compareLink"),
      );

      const foundersSection = container.querySelector('[data-public-presence-section="founders_offer"]');
      expect(foundersSection?.querySelector('a[href="/founders"]')?.textContent).toBe(
        t("publicPresence.home.foundersOffer.action"),
      );

      const finalCtaSection = container.querySelector('[data-public-presence-section="final_cta"]');
      expect(finalCtaSection?.querySelector('a[href="/founders"]')?.textContent).toBe(
        t("publicPresence.home.foundersOffer.action"),
      );
      expect(finalCtaSection?.querySelector('a[href="https://discord.gg/chase-sets"]')?.textContent).toBe(
        t("publicPresence.home.discordCta"),
      );

      const faqSection = container.querySelector('[data-public-presence-section="faq"]');
      expect(faqSection?.querySelector('a[href="/faq"]')?.textContent).toBe(t("publicPresence.faq.all"));
      unmount();
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
          async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
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

      const expectedSections = [...landingSectionOrder];
      const sectionElements = Array.from(document.querySelectorAll<HTMLElement>("[data-public-presence-section]"));
      expect(sectionElements.map((element) => element.getAttribute("data-public-presence-section"))).toEqual(
        expectedSections,
      );

      // Three IntersectionObserver instances mount: the shared sticky-bar
      // observer (observing only the hero form), the desktop sticky bar's
      // (observing only the final form panel) and useLandingSectionViewTracking's
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
            [{ target: element, isIntersecting: true } as unknown as IntersectionObserverEntry],
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
            [{ target: element, isIntersecting: true } as unknown as IntersectionObserverEntry],
            {} as IntersectionObserver,
          );
        });
      }
      expect(events.filter((detail) => detail.event === "section_viewed")).toHaveLength(expectedSections.length);

      stop();
    },
  );

  it.each([
    { variant: "seller_first_v1", pagePath: source.pagePath },
    { variant: "seller_first_v2", pagePath: "/?intent=buy" },
  ])("fires the exact cta_clicked window-event detail for $variant (AC7)", ({ variant, pagePath }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];
    const { events, stop } = captureAnalyticsEvents();

    const { container } = render(
      <PublicPresenceHomePage
        actionData={null}
        discordInviteUrl="https://discord.gg/chase-sets"
        source={{ ...source, pagePath }}
      />,
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

    const navSurface = container.querySelector("nav");
    if (!navSurface) throw new Error("Expected the nav to render.");
    clickAndExpect('a[href="/#waitlist-form"]', navSurface, {
      section: "nav",
      target: "waitlist_form",
      variant,
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
      { event: "cta_clicked", section: "game_roster", target: "pokemon", variant },
    ]);

    const feeComparisonSection = container.querySelector('[data-public-presence-section="fee_comparison"]');
    if (!feeComparisonSection) throw new Error("Expected the fee-comparison section to render.");
    clickAndExpect('a[href="/compare/tcgplayer"]', feeComparisonSection, {
      section: "fee_comparison",
      target: "compare_tcgplayer",
      variant,
    });

    const foundersSection = container.querySelector('[data-public-presence-section="founders_offer"]');
    if (!foundersSection) throw new Error("Expected the founders-offer section to render.");
    clickAndExpect('a[href="/founders"]', foundersSection, {
      section: "founders_offer",
      target: "founders_terms",
      variant,
    });

    const finalCtaSection = container.querySelector('[data-public-presence-section="final_cta"]');
    if (!finalCtaSection) throw new Error("Expected the final-CTA section to render.");
    clickAndExpect('a[href="/founders"]', finalCtaSection, {
      section: "final_cta",
      target: "founders_terms",
      variant,
    });
    clickAndExpect('a[href="https://discord.gg/chase-sets"]', finalCtaSection, {
      section: "final_cta",
      target: "discord",
      variant,
    });

    const faqSection = container.querySelector('[data-public-presence-section="faq"]');
    if (!faqSection) throw new Error("Expected the FAQ section to render.");
    clickAndExpect('a[href="/faq"]', faqSection, {
      section: "faq",
      target: "faq",
      variant,
    });

    // Every landing CTA has now been clicked once; no tuple names a retired section or target (AC4).
    const ctaTuples = events
      .filter((detail) => detail.event === "cta_clicked")
      .map((detail) => `${String(detail.section)}:${String(detail.target)}`);
    expect(ctaTuples).toEqual([
      "nav:waitlist_form",
      "game_roster:pokemon",
      "fee_comparison:compare_tcgplayer",
      "founders_offer:founders_terms",
      "final_cta:founders_terms",
      "final_cta:discord",
      "faq:faq",
    ]);

    stop();
  });
});

describe("landing hero signup panel first screen (#8504)", () => {
  const heroVariants = [
    { variant: "seller_first_v1", pagePath: source.pagePath },
    { variant: "seller_first_v2", pagePath: "/?intent=buy" },
  ] as const;

  function stubWaitlistCount(displayCount: number | null) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/waitlist/count")
        ? new Response(JSON.stringify({ displayCount }), { headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function visibleTextNodes(root: Element) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.trim()) nodes.push(node as Text);
    }
    return nodes;
  }

  function follows(earlier: Node, later: Node) {
    return Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  it.each(
    heroVariants.flatMap(({ variant, pagePath }) => [
      { variant, pagePath, displayCount: 125 },
      { variant, pagePath, displayCount: null },
    ]),
  )(
    "$variant panel orders intent, email, submit, notes, then counter (displayCount $displayCount)",
    async ({ pagePath, displayCount }) => {
      const fetchMock = stubWaitlistCount(displayCount);
      window.dataLayer = [];

      const { container } = render(<PublicPresenceHomePage actionData={null} source={{ ...source, pagePath }} />);

      await vi.waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith("/api/public-presence/waitlist/count", expect.anything()),
      );
      await act(async () => {});

      const h1 = container.querySelector('[data-public-presence-section="hero"] h1');
      expect(h1?.previousElementSibling).toBeNull();

      const panel = document.getElementById("waitlist-form")!;
      const intentControl = panel.querySelector('[role="radiogroup"]')!;
      const email = panel.querySelector('input[name="email"]')!;
      const submit = panel.querySelector('button[type="submit"]')!;
      const intentLabel = t("publicPresence.waitlist.heroIntent.label");
      expect(intentControl.getAttribute("aria-label")).toBe(intentLabel);
      expect(panel.textContent).not.toContain(intentLabel);

      const textNodes = visibleTextNodes(panel);
      // No title, description, counter or visible label precedes the intent control.
      expect(textNodes.filter((node) => follows(node, intentControl))).toEqual([]);

      const noPayment = textNodes.find((node) => node.textContent === t("publicPresence.waitlist.compactDescription"))!;
      const consent = textNodes.find((node) => node.textContent === t("publicPresence.waitlist.impliedConsent"))!;
      const ordered = [intentControl, email, submit, noPayment, consent];
      expect(ordered.every(Boolean)).toBe(true);
      for (let index = 1; index < ordered.length; index += 1) {
        expect(follows(ordered[index - 1]!, ordered[index]!)).toBe(true);
      }

      const trailingText = textNodes.filter((node) => follows(consent, node)).map((node) => node.textContent);
      expect(trailingText).toEqual(
        displayCount === null ? [] : [t("publicPresence.waitlist.counter.label", { count: displayCount })],
      );
    },
  );

  it.each(heroVariants)("hero form analytics unchanged ($variant)", ({ pagePath }) => {
    stubWaitlistCount(null);
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={{ ...source, pagePath }} />);

    const panel = document.getElementById("waitlist-form")!;
    fireEvent.focus(panel.querySelector('input[name="email"]')!);
    const sellSegment = [...panel.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((segment) =>
      segment.textContent?.includes(t("publicPresence.waitlist.heroIntent.sell")),
    );
    fireEvent.click(sellSegment!);

    expect(
      window.dataLayer.filter((detail) =>
        ["waitlist_form_started", "waitlist_role_selected"].includes(String(detail.event)),
      ),
    ).toEqual([
      expect.objectContaining({ event: "waitlist_form_started", section: "hero", field: "email" }),
      expect.objectContaining({ event: "waitlist_role_selected", section: "hero", role: "sell" }),
    ]);
  });
});

describe("landing desktop sticky early-access bar", () => {
  const landingVariants = [
    { variant: "seller_first_v1", pagePath: source.pagePath },
    { variant: "seller_first_v2", pagePath: "/?intent=buy" },
  ];

  // Renders the full landing page with observer instances keyed by their
  // actually-observed targets, so lookups never depend on mount order.
  function renderLandingWithObservers(pagePath: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const instances: { callback: IntersectionObserverCallback; observed: Element[] }[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function IntersectionObserverStub(callback: IntersectionObserverCallback) {
        const observed: Element[] = [];
        instances.push({ callback, observed });
        return { observe: (element: Element) => observed.push(element), disconnect: vi.fn(), unobserve: vi.fn() };
      }),
    );

    const { container } = render(<PublicPresenceHomePage actionData={null} source={{ ...source, pagePath }} />);

    const heroForm = document.getElementById("waitlist-form");
    const finalForm = document.getElementById("waitlist-form-final");
    if (!heroForm || !finalForm) {
      throw new Error("Expected the hero and final waitlist form panels to render.");
    }
    const heroObservers = instances.filter((instance) => instance.observed.includes(heroForm));
    const finalObservers = instances.filter((instance) => instance.observed.includes(finalForm));

    function report(observers: typeof instances, isIntersecting: boolean) {
      act(() => {
        for (const observer of observers) {
          observer.callback([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
        }
      });
    }

    return {
      container,
      heroForm,
      finalForm,
      heroObservers,
      finalObservers,
      reportHero: (isIntersecting: boolean) => report(heroObservers, isIntersecting),
      reportFinal: (isIntersecting: boolean) => report(finalObservers, isIntersecting),
      desktopBar: () => document.body.querySelector<HTMLElement>("[data-public-presence-desktop-sticky-cta]"),
      mobileBar: () => document.body.querySelector<HTMLElement>("[data-public-presence-sticky-cta]"),
    };
  }

  it.each(landingVariants)(
    "shows the md+ top bar only after the single shared hero-form observer reports the form out of view for $variant",
    ({ pagePath }) => {
      const page = renderLandingWithObservers(pagePath);

      expect(page.heroObservers).toHaveLength(1);
      expect(page.heroObservers[0]?.observed).toEqual([page.heroForm]);
      expect(page.desktopBar()).toBeNull();

      page.reportHero(true);
      expect(page.desktopBar()).toBeNull();
      expect(page.mobileBar()).toBeNull();

      page.reportHero(false);
      const desktopBar = page.desktopBar();
      if (!desktopBar) {
        throw new Error("Expected the desktop sticky bar once the hero form leaves view.");
      }
      expect(desktopBar.classList).toContain("top-0");
      expect(desktopBar.classList).toContain("fixed");
      expect(desktopBar.parentElement?.classList).toContain("hidden");
      expect(desktopBar.parentElement?.classList).toContain("md:block");
      expect(page.mobileBar()).not.toBeNull();

      page.reportHero(true);
      expect(page.desktopBar()).toBeNull();
      expect(page.mobileBar()).toBeNull();
    },
  );

  it.each(landingVariants)(
    "hides the desktop bar while the final form panel is in view and leaves the mobile bar unchanged for $variant",
    ({ pagePath }) => {
      const page = renderLandingWithObservers(pagePath);

      expect(page.finalObservers).toHaveLength(1);
      expect(page.finalObservers[0]?.observed).toEqual([page.finalForm]);

      page.reportHero(false);
      expect(page.desktopBar()).not.toBeNull();
      expect(page.mobileBar()).not.toBeNull();

      page.reportFinal(true);
      expect(page.desktopBar()).toBeNull();
      expect(page.mobileBar()).not.toBeNull();

      page.reportFinal(false);
      expect(page.desktopBar()).not.toBeNull();
      expect(page.mobileBar()).not.toBeNull();
    },
  );

  it.each(landingVariants)(
    "links the desktop bar to the final form with the shipped labels and tracks desktop_sticky for $variant",
    ({ variant, pagePath }) => {
      const page = renderLandingWithObservers(pagePath);
      const { events, stop } = captureAnalyticsEvents();

      page.reportHero(false);
      const desktopBar = page.desktopBar();
      if (!desktopBar) {
        throw new Error("Expected the desktop sticky bar once the hero form leaves view.");
      }

      expect(desktopBar.querySelectorAll("a")).toHaveLength(2);
      expect(desktopBar.querySelector('a[href="/"] > span')?.textContent).toBe(t("publicPresence.brand"));
      const action = desktopBar.querySelector<HTMLAnchorElement>('a[href="/#waitlist-form-final"]');
      if (!action) {
        throw new Error("Expected the desktop sticky bar's action to link to the final form.");
      }
      expect(action.textContent).toBe(t("publicPresence.home.stickyCta.action"));

      fireEvent.click(action);
      expect(events.filter((detail) => detail.event === "cta_clicked")).toEqual([
        { event: "cta_clicked", section: "desktop_sticky", target: "waitlist_form_final", variant },
      ]);

      stop();
    },
  );

  it.each(landingVariants)(
    "keeps a single mobile sticky marker, the nav brand and one foil word with both bars rendered for $variant",
    ({ pagePath }) => {
      const page = renderLandingWithObservers(pagePath);

      page.reportHero(false);
      const desktopBar = page.desktopBar();
      if (!desktopBar) {
        throw new Error("Expected the desktop sticky bar once the hero form leaves view.");
      }

      const mobileMarkers = document.body.querySelectorAll("[data-public-presence-sticky-cta]");
      expect(mobileMarkers).toHaveLength(1);
      expect(desktopBar.contains(mobileMarkers[0]!)).toBe(false);
      expect(page.container.querySelector('nav a[href="/"] > span')?.textContent).toBe(t("publicPresence.brand"));
      expect(desktopBar.closest("nav")).toBeNull();
      expect(desktopBar.querySelector("nav, header, footer, aside, [role]")).toBeNull();
      expect(desktopBar.querySelector(".ds-brand-foil-text")).toBeNull();
      expect(document.body.querySelectorAll(".ds-brand-foil-text")).toHaveLength(1);
    },
  );
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

  it("gives every Surface root in public-pages.tsx an explicit elevation intent with no bare or legacy elevated roots (#8270 AC3)", () => {
    const surfaces = surfaceElements(publicPagesSource);
    // 2 shell roots (nav/footer, flush) + 1 landing root (the elevated panel;
    // #8506 retired the 3 tinted open-offers cards) + 1 PublicInfoPage
    // section root (tinted) = 4, matching the source-derived census.
    expect(surfaces).toHaveLength(4);

    const explicitElevation = surfaces.filter((surface) => surface.elevation !== null);
    const legacyElevated = surfaces.filter((surface) => surface.elevatedBoolean);
    const bareRoots = surfaces.filter((surface) => surface.elevation === null && !surface.elevatedBoolean);

    expect(explicitElevation).toHaveLength(4);
    expect(legacyElevated).toHaveLength(0);
    expect(bareRoots).toHaveLength(0);

    expect(explicitElevation.filter((surface) => surface.elevation === "flush")).toHaveLength(2);
    expect(explicitElevation.filter((surface) => surface.elevation === "tinted")).toHaveLength(1);
    expect(explicitElevation.filter((surface) => surface.elevation === "elevated")).toHaveLength(1);
    expect(explicitElevation.filter((surface) => surface.elevation === "outlined")).toHaveLength(0);
    // Source-level guard: a bare `elevated` attribute (boolean or expression)
    // never returns; `elevation="elevated"` on the panel is not a match.
    expect(publicPagesSource).not.toMatch(/<Surface\b[^>]*\s+elevated(?:\s|>|\/|=\{)/);
  });
});

describe("public shell and info page surface diet (#8270 AC3)", () => {
  // DS-owned Surface recipe → elevation intent (see
  // packages/design-system/src/primitives/layout.tsx `Surface`). Legacy
  // (no `elevation`) and explicit `elevated` both carry `surface-border` plus a
  // shadow, so they classify as "elevated"; `flush` is the bare
  // `min-w-0 max-w-full rounded-tokenLg` frame with no fill, border or shadow.
  function surfaceIntent(element: Element) {
    const classes = element.classList;
    if (
      classes.contains("surface-border") ||
      classes.contains("shadow-tokenLg") ||
      classes.contains("shadow-tokenSm")
    ) {
      return "elevated";
    }
    if (classes.contains("border")) {
      return "outlined";
    }
    if (classes.contains("bg-surface-2") || Array.from(classes).some((token) => /^bg-.+-soft$/.test(token))) {
      return "tinted";
    }
    if (classes.contains("min-w-0") && classes.contains("max-w-full") && classes.contains("rounded-tokenLg")) {
      return "flush";
    }
    return "unexpected";
  }
  // Chrome vocabulary the surface-diet law forbids on furniture; responsive and
  // state variants are stripped so `md:border` still counts.
  const chromeClassPattern =
    /^(?:border|border-.+|surface-border|bg-surface(?:-.+)?|shadow-.+|backdrop-blur(?:-.+)?|bg-\[color-mix.*|ring|ring-.+|outline|outline-.+)$/;
  function chromeTokens(element: Element) {
    return element.className
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => token.replace(/^(?:[a-z0-9-]+:)+/, ""))
      .filter((token) => chromeClassPattern.test(token));
  }

  it.each([
    { variant: "seller_first_v1", pagePath: source.pagePath },
    { variant: "seller_first_v2", pagePath: "/?intent=buy" },
  ])(
    "renders nav and footer flush and keeps the signup panel as the hero's only raised element in $variant",
    ({ pagePath }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ items: [] }))),
      );
      const { container } = render(<PublicPresenceHomePage actionData={null} source={{ ...source, pagePath }} />);

      const nav = container.querySelector("nav");
      const footer = container.querySelector("footer");
      expect(nav).not.toBeNull();
      expect(footer).not.toBeNull();
      expect(container.querySelectorAll("nav")).toHaveLength(1);
      expect(container.querySelectorAll("footer")).toHaveLength(1);

      const heroSection = container.querySelector('[data-public-presence-section="hero"]');
      expect(heroSection).not.toBeNull();
      const heroRoot = heroSection!.querySelector("section");
      expect(heroRoot).not.toBeNull();
      const mobileHighlightRow = heroRoot!.querySelector('[aria-label="Marketing highlight"]');
      const desktopHighlightRow = heroRoot!.querySelector('[aria-label="Marketing highlights"]');
      expect(mobileHighlightRow).not.toBeNull();
      expect(desktopHighlightRow).not.toBeNull();
      const panel = heroRoot!.querySelector("#waitlist-form");
      expect(panel).not.toBeNull();

      // Per-root intent map (review packet seed): nav, footer, hero root,
      // highlight rows and panel.
      expect({
        nav: surfaceIntent(nav!),
        footer: surfaceIntent(footer!),
        heroRoot: chromeTokens(heroRoot!),
        mobileHighlightRow: chromeTokens(mobileHighlightRow!),
        desktopHighlightRow: chromeTokens(desktopHighlightRow!),
        panel: surfaceIntent(panel!),
      }).toEqual({
        nav: "flush",
        footer: "flush",
        heroRoot: [],
        mobileHighlightRow: [],
        desktopHighlightRow: [],
        panel: "elevated",
      });
      expect(panel!.classList.contains("ds-glow")).toBe(true);
      expect(heroRoot!.classList.contains("relative")).toBe(true);

      // The whole hero subtree outside the caller-owned panel is chrome-free,
      // so chrome cannot hide on an inner wrapper.
      const heroOwnedNodes = [heroRoot!, ...Array.from(heroRoot!.querySelectorAll("*"))].filter(
        (element) => element !== panel && !panel!.contains(element),
      );
      expect(heroOwnedNodes.length).toBeGreaterThan(5);
      expect(
        heroOwnedNodes.flatMap((element) =>
          chromeTokens(element).map((token) => `${element.tagName.toLowerCase()}.${token}`),
        ),
      ).toEqual([]);
      // Highlights are copy, not tiles: no Surface/Card root outside the panel.
      expect(heroOwnedNodes.filter((element) => element.matches(".min-w-0.max-w-full.rounded-tokenLg"))).toEqual([]);
      // The panel is the only raised element inside the hero.
      expect(
        Array.from(heroRoot!.querySelectorAll(".surface-border, .shadow-tokenLg, .shadow-tokenSm")).filter(
          (element) => !panel!.contains(element),
        ),
      ).toEqual([]);
    },
  );

  it("renders every PublicInfoPage section root tinted inside the flush shell", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }))),
    );
    const { container } = render(
      <PublicInfoPage
        content={{
          eyebrow: "Contact",
          title: "Talk to the team",
          description: "Support and status channels.",
          sections: [
            { title: "Support", body: ["Email support@example.test."] },
            { title: "Status", body: ["Check status.example.test.", "Subscribe for incident updates."] },
          ],
        }}
      />,
    );

    expect(surfaceIntent(container.querySelector("nav")!)).toBe("flush");
    expect(surfaceIntent(container.querySelector("footer")!)).toBe("flush");

    const main = container.querySelector("main#main-content");
    expect(main).not.toBeNull();
    expect(main!.textContent).toContain("Talk to the team");
    const sectionRoots = Array.from(main!.querySelectorAll<HTMLElement>(".min-w-0.max-w-full.rounded-tokenLg"));
    expect(sectionRoots).toHaveLength(2);
    expect(sectionRoots.map((root) => root.querySelector("h2")?.textContent)).toEqual(["Support", "Status"]);
    expect(sectionRoots.map(surfaceIntent)).toEqual(["tinted", "tinted"]);
    // A tinted section root carries exactly its tint fill and no border, shadow or ring.
    for (const root of sectionRoots) {
      expect(chromeTokens(root)).toEqual(["bg-surface-2"]);
    }
    expect(main!.querySelectorAll(".surface-border, .shadow-tokenLg, .shadow-tokenSm")).toHaveLength(0);
  });
});

describe("public shell single content gutter (#8499)", () => {
  // `Page` owns the content gutter; furniture outside `main` repeats its tokens.
  const pageGutterTokens = ["md:px-6", "px-4"];
  // Any `p-*`, `px-*`, `pl-*`, `pr-*`, `ps-*` or `pe-*` class, with or without
  // responsive/state prefixes, except a `*-0` class (the `px-0` that
  // `paddingX={0}` emits is not padding).
  const horizontalPaddingPattern = /^(?:[a-z0-9-]+:)*(?:p|px|pl|pr|ps|pe)-(?!0$).+$/;
  const promoSelector = 'section[aria-label="Marketplace announcements"]';

  function horizontalPaddingTokens(element: Element) {
    return (element.getAttribute("class") ?? "")
      .split(/\s+/)
      .filter((token) => horizontalPaddingPattern.test(token))
      .sort();
  }

  function ancestorsBetween(main: Element, root: Element) {
    const chain: Element[] = [];
    for (let node = main.parentElement; node && node !== root; node = node.parentElement) {
      chain.push(node);
    }
    return chain;
  }

  function stubPromoMessages(items: readonly Record<string, unknown>[]) {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function settlePromoFetch(fetchMock: ReturnType<typeof stubPromoMessages>) {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function shellParts(container: HTMLElement) {
    const main = container.querySelector<HTMLElement>("main#main-content");
    const nav = container.querySelector("nav");
    const footer = container.querySelector("footer");
    expect(main).not.toBeNull();
    expect(nav).not.toBeNull();
    expect(footer).not.toBeNull();
    const stack = main!.parentElement!;
    return { main: main!, nav: nav!, footer: footer!, stack, furniture: Array.from(stack.children) };
  }

  const infoContent = {
    eyebrow: "Contact",
    title: "Talk to the team",
    description: "Support and status channels.",
    sections: [{ title: "Support", body: ["Email support@example.test."] }],
  };
  const helpArticle =
    publicHelpArticles.find((article) => article.policyValueKeys.length === 0) ?? publicHelpArticles[0]!;
  const developerArticle = developerArticles[0]!;

  // Every `<PublicPresencePageShell` render site: ten sites in six files.
  const shellConsumers: readonly (readonly [string, () => ReactNode])[] = [
    ["landing page", () => <PublicPresenceHomePage actionData={null} source={source} />],
    ["PublicInfoPage", () => <PublicInfoPage content={infoContent} />],
    ["compare page", () => <ComparePage competitor="tcgplayer" feeSchedule={null} />],
    ["success page", () => <WaitlistSuccessPage signupId="wls_public" publicOrigin="https://chasesets.com" />],
    ["help hub", () => <HelpHubPage />],
    ["help category", () => <HelpCategoryPage category={helpCategories[0]} articles={[]} />],
    ["help article", () => <HelpArticlePage article={helpArticle} related={[]} />],
    ["developer portal", () => <DeveloperPortalPage />],
    ["developer article", () => <DeveloperArticlePage article={developerArticle} />],
    ["policy artifact page", () => <PrivacyPolicyRouteAdapter />],
  ];

  it("lists every PublicPresencePageShell render site as a consumer", () => {
    const featuresDirectory = join(repositoryRoot(), "bounded-contexts", "public-presence", "features");
    const renderSiteFiles = [
      ["waitlist", "ui", "public-pages.tsx"],
      ["waitlist", "ui", "compare-page.tsx"],
      ["waitlist", "ui", "success-page.tsx"],
      ["help", "ui", "help-pages.tsx"],
      ["developer-portal", "ui", "developer-pages.tsx"],
      ["policies", "ui", "policy-artifact-page.tsx"],
    ];
    const renderSites = renderSiteFiles.reduce(
      (count, segments) =>
        count +
        (readFileSync(join(featuresDirectory, ...segments), "utf8").match(/<PublicPresencePageShell\b/g) ?? []).length,
      0,
    );

    expect(renderSites).toBe(10);
    expect(shellConsumers).toHaveLength(renderSites);
  });

  it.each(shellConsumers)(
    "renders main#main-content > Page root with no horizontally padded ancestor or wrapper for the %s",
    (_name, renderConsumer) => {
      stubPromoMessages([]);
      const { container } = render(renderConsumer());
      const { main } = shellParts(container);

      expect(main.children).toHaveLength(1);
      expect(horizontalPaddingTokens(main.firstElementChild!)).toEqual(pageGutterTokens);
      const ancestors = ancestorsBetween(main, container);
      expect(ancestors.length).toBeGreaterThan(0);
      expect(
        ancestors
          .map((ancestor) => ({ tag: ancestor.tagName.toLowerCase(), padding: horizontalPaddingTokens(ancestor) }))
          .filter(({ padding }) => padding.length > 0),
      ).toEqual([]);
    },
  );

  it("renders no promo wrapper or extra stack gap with zero titled messages", async () => {
    const fetchMock = stubPromoMessages([]);
    const { container } = render(<PublicInfoPage content={infoContent} />);
    await settlePromoFetch(fetchMock);
    const { nav, footer, stack, furniture } = shellParts(container);

    expect(container.querySelector(promoSelector)).toBeNull();
    expect(furniture).toHaveLength(3);
    expect(furniture[0]!.contains(nav)).toBe(true);
    expect(furniture[2]!.contains(footer)).toBe(true);
    expect(Array.from(stack.children).every((child) => child.childElementCount > 0)).toBe(true);
  });

  it("renders no promo wrapper when every fetched message lacks a title", async () => {
    const fetchMock = stubPromoMessages([
      { id: "promo_untitled", description: "No title" },
      { id: "promo_blank", title: "" },
    ]);
    const { container } = render(<PublicInfoPage content={infoContent} />);
    await settlePromoFetch(fetchMock);
    const { nav, furniture } = shellParts(container);

    expect(container.querySelector(promoSelector)).toBeNull();
    expect(furniture).toHaveLength(3);
    expect(furniture[0]!.contains(nav)).toBe(true);
  });

  it("matches the Page gutter with one titled promo message", async () => {
    const fetchMock = stubPromoMessages([{ id: "promo_one", title: "Founders offer is open", tone: "info" }]);
    const { container } = render(<PublicInfoPage content={infoContent} />);
    await settlePromoFetch(fetchMock);
    const { main, nav, footer, stack, furniture } = shellParts(container);
    const promo = container.querySelector(promoSelector);

    expect(promo).not.toBeNull();
    expect(furniture).toHaveLength(4);
    expect(furniture[0]).toBe(promo!.parentElement);
    expect(furniture[1]).toBe(nav.parentElement);
    expect(furniture[3]).toBe(footer.parentElement);

    const pageRootTokens = horizontalPaddingTokens(main.firstElementChild!);
    expect(pageRootTokens).toEqual(pageGutterTokens);
    for (const wrapper of [promo!.parentElement!, nav.parentElement!, footer.parentElement!]) {
      expect(wrapper.parentElement).toBe(stack);
      expect(horizontalPaddingTokens(wrapper)).toEqual(pageRootTokens);
    }
  });

  it.each([
    ["landing page", () => <PublicPresenceHomePage actionData={null} source={source} />],
    ["compare page", () => <ComparePage competitor="ebay" feeSchedule={null} />],
  ] as const)("gives the nav and footer the Page gutter tokens on the %s", async (_name, renderPage) => {
    const fetchMock = stubPromoMessages([]);
    const { container } = render(renderPage());
    await settlePromoFetch(fetchMock);
    const { main, nav, footer } = shellParts(container);

    const pageRootTokens = horizontalPaddingTokens(main.firstElementChild!);
    expect(pageRootTokens).toEqual(pageGutterTokens);
    expect(horizontalPaddingTokens(nav.parentElement!)).toEqual(pageRootTokens);
    expect(horizontalPaddingTokens(footer.parentElement!)).toEqual(pageRootTokens);
  });
});
