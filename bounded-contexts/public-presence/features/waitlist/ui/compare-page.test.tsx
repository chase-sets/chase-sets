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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ComparePage (#4087)", () => {
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
    expect(container.textContent).toContain("September 1, 2026");
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
