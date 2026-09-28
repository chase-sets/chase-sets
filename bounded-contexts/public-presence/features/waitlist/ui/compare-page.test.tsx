import { cleanup, render as renderWithoutRouter, within, type RenderOptions } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCompareFaqEntries, ComparePage } from "./compare-page";
import { FeeCalculatorSection, type PublicMarketplaceFeeSchedule } from "./fee-comparison-calculator";

function render(ui: ReactNode, options?: RenderOptions) {
  return renderWithoutRouter(ui, { wrapper: MemoryRouter, ...options });
}

const ratifiedSchedule: PublicMarketplaceFeeSchedule = {
  percentageBps: 500,
  fixedAmount: "0.00",
  capAmount: "25.00",
  effectiveFrom: "2026-07-03T00:00:00.000Z",
};

function stubPromoBarFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } })),
  );
}

const surfaceRootSelector = ".min-w-0.max-w-full.rounded-tokenLg";

// Reads a Surface root's rendered intent from design-system-owned classes:
// flush/tinted carry no `surface-border` and no `shadow-` class.
function surfaceIntent(surface: Element | null) {
  const classes = [...(surface?.classList ?? [])];
  if (classes.includes("surface-border") || classes.some((name) => name.startsWith("shadow-"))) {
    return classes.includes("shadow-tokenLg") ? "elevated" : "legacy";
  }
  if (classes.includes("border")) return "outlined";
  return classes.includes("bg-surface-2") ? "tinted" : "flush";
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ComparePage (#4087)", () => {
  it.each(["tcgplayer", "ebay"] as const)("renders undated availability and FAQ copy for %s", (competitor) => {
    stubPromoBarFetch();
    const { container } = render(<ComparePage competitor={competitor} feeSchedule={ratifiedSchedule} />);
    expect(container.innerHTML).not.toContain("September 1, 2026");
    expect(container.innerHTML).not.toContain("late July 2026");
    expect(container.querySelector('[data-public-presence-section="compare_table"]')?.textContent).toMatch(
      /waitlist.*numbered beta invite waves.*open signup/i,
    );
    expect(
      buildCompareFaqEntries(competitor).find(({ question }) => question === "Is Chase Sets live yet?")?.answer,
    ).toMatch(/waitlist.*numbered beta invite waves.*open signup/i);
  });

  it("renders the side-by-side table with live Chase Sets numbers and dated TCGplayer numbers", () => {
    stubPromoBarFetch();
    const { container } = render(<ComparePage competitor="tcgplayer" feeSchedule={ratifiedSchedule} />);

    const table = container.querySelector('[data-public-presence-section="compare_table"]');
    if (!table) throw new Error("Expected the comparison table section to render.");
    // Chase Sets fee cell comes from the live schedule prop, not hardcoded copy.
    expect(table.textContent).toContain("5%");
    expect(table.textContent).toContain("$25.00");
    // Competitor cells cite the dated published numbers from the calculator constants.
    expect(table.textContent).toContain("10.75%");
    expect(table.textContent).toContain("$75.00");
    expect(table.textContent).toContain("as of July 12, 2026");
    // The interactive calculator is embedded with the same schedule.
    expect(container.querySelector('[data-public-presence-section="fee_calculator"]')).not.toBeNull();
    // Cross-link to the other comparison page, founders callout, and honest prelaunch posture.
    expect(container.querySelector('a[href="/compare/ebay"]')).not.toBeNull();
    expect(container.querySelector('a[href="/founders"]')).not.toBeNull();
    expect(container.textContent).toContain("Where TCGplayer is ahead today");
    expect(container.textContent).toContain("open signup for everyone");
  });

  it("stays truthful without a live schedule: no invented Chase Sets numbers, calculator hidden", () => {
    stubPromoBarFetch();
    const { container } = render(<ComparePage competitor="ebay" feeSchedule={null} />);

    expect(container.querySelector('[data-public-presence-section="fee_calculator"]')).toBeNull();
    const table = container.querySelector('[data-public-presence-section="compare_table"]');
    if (!table) throw new Error("Expected the comparison table section to render.");
    expect(table.textContent).toContain("Current numbers are on the marketplace sales fees page.");
    // eBay's dated numbers still render from the shared constants.
    expect(table.textContent).toContain("13.25%");
    expect(container.textContent).toContain("Where eBay is ahead today");
  });

  it.each([
    {
      competitor: "tcgplayer" as const,
      feeSchedule: ratifiedSchedule,
      intents: ["tinted", "tinted", "tinted", "tinted"],
    },
    { competitor: "ebay" as const, feeSchedule: null, intents: ["tinted", "tinted", "tinted"] },
  ])(
    "tints the explanatory, founders and CTA panels on /compare/$competitor",
    ({ competitor, feeSchedule, intents }) => {
      stubPromoBarFetch();
      const { container } = render(<ComparePage competitor={competitor} feeSchedule={feeSchedule} />);
      const main = container.querySelector("main#main-content")!;

      // why + honesty, the calculator's founders panel when a schedule is live, then the CTA.
      expect([...main.querySelectorAll(surfaceRootSelector)].map(surfaceIntent)).toEqual(intents);
      const honestyTitle = within(main as HTMLElement).getByRole("heading", { level: 2, name: /is ahead today/ });
      expect(surfaceIntent(honestyTitle.closest(surfaceRootSelector))).toBe("tinted");
      const ctaLink = main.querySelector('a[href="/#waitlist-form"]');
      expect(surfaceIntent(ctaLink!.closest(surfaceRootSelector))).toBe("tinted");
    },
  );

  it("links the landing-page calculator to both comparison pages by default", () => {
    const { container } = render(<FeeCalculatorSection schedule={ratifiedSchedule} />);

    expect(container.querySelector('a[href="/compare/tcgplayer"]')).not.toBeNull();
    expect(container.querySelector('a[href="/compare/ebay"]')).not.toBeNull();
  });
});

function faqSectionOf(container: HTMLElement) {
  const section = container.querySelector('[data-public-presence-section="compare_faq"]');
  if (!section) throw new Error("Expected the compare_faq section to render.");
  return section as HTMLElement;
}

// React's server renderer HTML-escapes text node apostrophes; match that
// encoding rather than the raw copy when scanning the SSR markup string.
function asSsrText(value: string) {
  return value.replace(/'/g, "&#x27;");
}

describe("ComparePage FAQ disclosure collapse (#7178)", () => {
  it.each(["tcgplayer", "ebay"] as const)(
    "renders exactly four collapsed %s FAQ triggers, in order, with answers present in SSR and DOM markup",
    (competitor) => {
      const entries = buildCompareFaqEntries(competitor);

      const ssrMarkup = renderToString(
        <MemoryRouter>
          <ComparePage competitor={competitor} feeSchedule={null} />
        </MemoryRouter>,
      );
      for (const entry of entries) {
        expect(ssrMarkup).toContain(asSsrText(entry.answer));
      }

      stubPromoBarFetch();
      const { container } = render(<ComparePage competitor={competitor} feeSchedule={null} />);
      const faqSection = faqSectionOf(container);

      const triggers = within(faqSection).getAllByRole("button");
      expect(triggers).toHaveLength(4);
      triggers.forEach((trigger, index) => {
        expect(trigger.textContent).toBe(entries[index].question);
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
      });
      for (const entry of entries) {
        expect(faqSection.textContent).toContain(entry.answer);
      }
    },
  );

  it.each(["tcgplayer", "ebay"] as const)(
    "opens only the first and fourth %s FAQ items on click, leaving the middle two collapsed",
    async (competitor) => {
      stubPromoBarFetch();
      const user = userEvent.setup();
      const entries = buildCompareFaqEntries(competitor);
      const { container } = render(<ComparePage competitor={competitor} feeSchedule={null} />);
      const faqSection = faqSectionOf(container);
      const triggers = within(faqSection).getAllByRole("button");
      expect(triggers).toHaveLength(4);

      await user.click(triggers[0]);
      await user.click(triggers[3]);

      expect(triggers.map((trigger) => trigger.getAttribute("aria-expanded"))).toEqual([
        "true",
        "false",
        "false",
        "true",
      ]);
      expect(faqSection.textContent).toContain(entries[0].answer);
      expect(faqSection.textContent).toContain(entries[3].answer);
    },
  );
});
