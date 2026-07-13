import { cleanup, render as renderWithoutRouter, type RenderOptions } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComparePage } from "./compare-page";
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
