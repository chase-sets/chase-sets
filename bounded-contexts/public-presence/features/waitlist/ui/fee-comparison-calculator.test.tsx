import { cleanup, fireEvent, render as renderWithoutRouter, type RenderOptions } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FeeCalculatorSection,
  computeChaseSetsOutcome,
  computeEbayOutcome,
  computeTcgplayerOutcome,
  parseCalculatorCardCount,
  parseCalculatorPrice,
  toPublicMarketplaceFeeSchedule,
  type PublicMarketplaceFeeSchedule,
} from "./fee-comparison-calculator";
import { PublicPresenceHomePage } from "./public-pages";

function render(ui: ReactNode, options?: RenderOptions) {
  return renderWithoutRouter(ui, { wrapper: MemoryRouter, ...options });
}

// The ratified standard schedule (#4066): 5%, $0 fixed, $25/item cap. Tests
// feed it as a prop exactly like the loader does from the live policy read.
const ratifiedSchedule: PublicMarketplaceFeeSchedule = {
  percentageBps: 500,
  fixedAmount: "0.00",
  capAmount: "25.00",
  effectiveFrom: "2026-07-03T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("fee comparison worked examples (single card)", () => {
  // Expected kept-amounts, exact to the cent. Chase Sets mirrors the
  // commercial-terms quote math (percentage rounds up, then the per-item
  // cap); competitor fees round DOWN in the competitor's favor.
  const examples = [
    // [price cents, chase kept, tcgplayer kept, ebay kept]
    { price: 1_000n, chase: 950n, tcgplayer: 838n, ebay: 838n },
    { price: 5_000n, chase: 4_750n, tcgplayer: 4_308n, ebay: 4_298n },
    { price: 12_000n, chase: 11_400n, tcgplayer: 10_380n, ebay: 10_370n },
    { price: 60_000n, chase: 57_500n, tcgplayer: 52_020n, ebay: 52_010n },
  ];

  it.each(examples)("computes exact kept-amounts at $price cents", ({ price, chase, tcgplayer, ebay }) => {
    expect(computeChaseSetsOutcome(price, 1n, ratifiedSchedule).keptCents).toBe(chase);
    expect(computeTcgplayerOutcome(price, 1n).keptCents).toBe(tcgplayer);
    expect(computeEbayOutcome(price, 1n).keptCents).toBe(ebay);
  });

  it("breaks the $10 sale into the fee components shown on the landing table", () => {
    const tcgplayer = computeTcgplayerOutcome(1_000n, 1n);
    // TCGplayer: 10.75% commission = 107.5¢ -> $1.07 (rounded down in their
    // favor) + 2.5% + $0.30 processing = $0.55.
    expect(tcgplayer.marketplaceFeeCents).toBe(107n);
    expect(tcgplayer.processingFeeCents).toBe(55n);
    const ebay = computeEbayOutcome(1_000n, 1n);
    // eBay: 13.25% FVF = 132.5¢ -> $1.32 (rounded down) + $0.30 per-order
    // fee (order is exactly $10, the small-order boundary).
    expect(ebay.marketplaceFeeCents).toBe(132n);
    expect(ebay.processingFeeCents).toBe(30n);
  });

  it("binds the $25/item cap above $500: on a $600 sale the 5% fee stops at $25.00", () => {
    const outcome = computeChaseSetsOutcome(60_000n, 1n, ratifiedSchedule);
    expect(outcome.marketplaceFeeCents).toBe(2_500n);
    expect(outcome.capApplied).toBe(true);
    // Just below the cap threshold the fee is still percentage-driven.
    const below = computeChaseSetsOutcome(50_000n, 1n, ratifiedSchedule);
    expect(below.marketplaceFeeCents).toBe(2_500n);
    expect(below.capApplied).toBe(false);
  });

  it("charges eBay's $0.40 per-order fee only on orders over $10", () => {
    expect(computeEbayOutcome(1_001n, 1n).processingFeeCents).toBe(40n);
    expect(computeEbayOutcome(999n, 1n).processingFeeCents).toBe(30n);
  });

  it("applies TCGplayer's published $75/item commission cap in their favor", () => {
    const outcome = computeTcgplayerOutcome(80_000n, 1n);
    expect(outcome.marketplaceFeeCents).toBe(7_500n);
    expect(outcome.capApplied).toBe(true);
    // 2.5% of $800 + $0.30 = $20.30.
    expect(outcome.processingFeeCents).toBe(2_030n);
    expect(outcome.keptCents).toBe(70_470n);
  });

  it("applies eBay's 2.35% tier to the portion of a sale above $7,500", () => {
    const outcome = computeEbayOutcome(800_000n, 1n);
    // 13.25% of $7,500 = $993.75 + 2.35% of $500 = $11.75 -> $1,005.50.
    expect(outcome.marketplaceFeeCents).toBe(100_550n);
    expect(outcome.keptCents).toBe(699_410n);
  });
});

describe("fee comparison worked examples (multi-card orders)", () => {
  it("caps the Chase Sets fee per item, not per order: three $600 cards cost 3 x $25", () => {
    const outcome = computeChaseSetsOutcome(60_000n, 3n, ratifiedSchedule);
    expect(outcome.marketplaceFeeCents).toBe(7_500n);
    expect(outcome.keptCents).toBe(172_500n);
  });

  it("charges competitor per-order fixed fees once per order", () => {
    const tcgplayer = computeTcgplayerOutcome(60_000n, 3n);
    // Commission 3 x $64.50 = $193.50; processing 2.5% of $1,800 + $0.30 = $45.30.
    expect(tcgplayer.marketplaceFeeCents).toBe(19_350n);
    expect(tcgplayer.processingFeeCents).toBe(4_530n);
    expect(tcgplayer.keptCents).toBe(156_120n);
    const ebay = computeEbayOutcome(60_000n, 3n);
    // FVF 13.25% of $1,800 = $238.50; one $0.40 per-order fee.
    expect(ebay.marketplaceFeeCents).toBe(23_850n);
    expect(ebay.processingFeeCents).toBe(40n);
    expect(ebay.keptCents).toBe(156_110n);
  });
});

describe("calculator input parsing", () => {
  it("accepts dollar signs, commas, and bare decimals; rejects out-of-range prices", () => {
    expect(parseCalculatorPrice("$1,200.50")).toBe(120_050n);
    expect(parseCalculatorPrice("50")).toBe(5_000n);
    expect(parseCalculatorPrice("0")).toBeNull();
    expect(parseCalculatorPrice("-5")).toBeNull();
    expect(parseCalculatorPrice("10000")).toBeNull();
    expect(parseCalculatorPrice("abc")).toBeNull();
  });

  it("accepts 1-100 whole cards", () => {
    expect(parseCalculatorCardCount("1")).toBe(1);
    expect(parseCalculatorCardCount("100")).toBe(100);
    expect(parseCalculatorCardCount("0")).toBeNull();
    expect(parseCalculatorCardCount("101")).toBeNull();
    expect(parseCalculatorCardCount("2.5")).toBeNull();
  });
});

describe("schedule mapping from the public policy read", () => {
  it("narrows the whitelisted policy values to the calculator schedule", () => {
    expect(
      toPublicMarketplaceFeeSchedule({
        values: {
          "marketplace-sales-fee.standard.bps": { type: "bps", value: 500, effectiveFrom: "2026-07-03T00:00:00.000Z" },
          "marketplace-sales-fee.standard.fixed": { type: "money", value: "0.00", effectiveFrom: null },
          "marketplace-sales-fee.standard.cap": { type: "money", value: "25.00", effectiveFrom: null },
        },
      }),
    ).toEqual(ratifiedSchedule);
  });

  it("refuses to build a schedule from missing or malformed values", () => {
    expect(() => toPublicMarketplaceFeeSchedule({ values: {} })).toThrow(/unavailable/);
    expect(() =>
      toPublicMarketplaceFeeSchedule({
        values: {
          "marketplace-sales-fee.standard.bps": { type: "bps", value: "5%", effectiveFrom: null },
          "marketplace-sales-fee.standard.fixed": { type: "money", value: "0.00", effectiveFrom: null },
          "marketplace-sales-fee.standard.cap": { type: "money", value: "25.00", effectiveFrom: null },
        },
      }),
    ).toThrow(/basis-point/);
  });
});

describe("FeeCalculatorSection", () => {
  it("renders nothing without a live schedule — truth-gated, never hardcoded", () => {
    const { container } = render(<FeeCalculatorSection schedule={null} />);
    expect(container.querySelector('[data-public-presence-section="fee_calculator"]')).toBeNull();
  });

  it("recomputes the side-by-side kept amounts as the seller types, including the cap note at $600", () => {
    const { container } = render(<FeeCalculatorSection schedule={ratifiedSchedule} />);
    const section = container.querySelector('[data-public-presence-section="fee_calculator"]');
    if (!section) throw new Error("Expected the fee calculator to render with a live schedule.");

    // Default $50 example.
    expect(section.textContent).toContain("$47.50");
    expect(section.textContent).toContain("$43.08");
    expect(section.textContent).toContain("$42.98");
    expect(container.querySelector('[data-testid="fee-calculator-cap-note"]')).toBeNull();

    const priceInput = container.querySelector('input[name="fee-calculator-price"]');
    if (!priceInput) throw new Error("Expected the sale price input to render.");
    fireEvent.change(priceInput, { target: { value: "600" } });

    expect(section.textContent).toContain("$575.00");
    expect(section.textContent).toContain("$520.20");
    expect(section.textContent).toContain("$520.10");
    expect(container.querySelector('[data-testid="fee-calculator-cap-note"]')).not.toBeNull();

    fireEvent.change(priceInput, { target: { value: "not a price" } });
    expect(section.textContent).toContain("Enter a price from $0.01 to $9,999.99.");
  });

  it("shows the founders 0% window as a callout linking /founders while defaulting to the standard schedule", () => {
    const { container } = render(<FeeCalculatorSection schedule={ratifiedSchedule} />);
    const section = container.querySelector('[data-public-presence-section="fee_calculator"]');
    if (!section) throw new Error("Expected the fee calculator to render.");
    expect(section.querySelector('a[href="/founders"]')).not.toBeNull();
    expect(section.textContent).toContain("0% seller fee");
    // The default comparison stays on the standard schedule (5% on $50).
    expect(section.textContent).toContain("$47.50");
  });

  it("copies a UTM-tagged share link carrying the entered comparison", () => {
    const writeText = vi.fn<(text: string) => Promise<undefined>>(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    window.dataLayer = [];

    const { container, getByText } = render(<FeeCalculatorSection schedule={ratifiedSchedule} />);
    const priceInput = container.querySelector('input[name="fee-calculator-price"]');
    if (!priceInput) throw new Error("Expected the sale price input to render.");
    fireEvent.change(priceInput, { target: { value: "120" } });
    fireEvent.click(getByText("Copy share link"));

    expect(writeText).toHaveBeenCalledTimes(1);
    const link = new URL(writeText.mock.calls[0]?.[0] ?? "");
    expect(link.searchParams.get("price")).toBe("120.00");
    expect(link.searchParams.get("cards")).toBe("1");
    expect(link.searchParams.get("utm_source")).toBe("fee-calculator");
    expect(link.searchParams.get("utm_medium")).toBe("share");
    expect(link.searchParams.get("utm_campaign")).toBe("what-you-keep");
    expect(link.hash).toBe("#fee-calculator");
    expect(getByText("Link copied")).toBeTruthy();
    expect(window.dataLayer).toContainEqual(
      expect.objectContaining({ event: "cta_clicked", section: "fee_calculator", target: "copy_share_link" }),
    );
  });
});

describe("named competitors on the landing page (#3953 decision)", () => {
  const source = {
    pagePath: "/",
    referrer: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmContent: null,
    utmTerm: null,
    referredBySignupId: null,
  };

  it("names TCGplayer and eBay in the fee-comparison table and calculator; anonymized labels are gone", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(
      <PublicPresenceHomePage actionData={null} source={source} feeSchedule={ratifiedSchedule} />,
    );

    const table = container.querySelector('[data-public-presence-section="fee_comparison"]');
    const calculator = container.querySelector('[data-public-presence-section="fee_calculator"]');
    if (!table || !calculator) throw new Error("Expected both fee-comparison surfaces to render.");
    expect(table.textContent).toContain("TCGplayer");
    expect(table.textContent).toContain("eBay");
    expect(calculator.textContent).toContain("TCGplayer");
    expect(calculator.textContent).toContain("eBay");
    expect(container.textContent).not.toContain("Major marketplace");

    // The calculator sits inside the fees narrative: after the comparison
    // table and before the founders offer (#4081 placement preserved).
    const founders = container.querySelector('[data-public-presence-section="founders_offer"]');
    if (!founders) throw new Error("Expected the founders offer section to render.");
    expect(table.compareDocumentPosition(calculator) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(calculator.compareDocumentPosition(founders) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("hides the calculator without a live schedule but keeps the named table", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container } = render(<PublicPresenceHomePage actionData={null} source={source} feeSchedule={null} />);
    expect(container.querySelector('[data-public-presence-section="fee_calculator"]')).toBeNull();
    expect(container.querySelector('[data-public-presence-section="fee_comparison"]')?.textContent).toContain(
      "TCGplayer",
    );
  });
});
