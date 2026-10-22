// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PricingBulkRepricePage } from "./bulk-reprice-page";

describe("PricingBulkRepricePage", () => {
  it("shows a reliant seller the exact prefilled editor URL, including zero", () => {
    const html = renderToStaticMarkup(
      <PricingBulkRepricePage nudge={{ status: "available", offsetPercent: 0, currencyCode: "USD" }} />,
    );
    const rendered = document.createElement("div");
    rendered.innerHTML = html;
    expect(rendered.querySelector('a[href^="/account/desk/repricing"]')?.getAttribute("href")).toBe(
      "/account/desk/repricing?create=1&prefill=market-offset&anchor=market-estimate&offsetPercent=0&currency=USD",
    );
  });
  it("hides the migration nudge for a non-reliant seller", () => {
    const html = renderToStaticMarkup(
      <PricingBulkRepricePage
        nudge={{ status: "unavailable", offsetPercent: null, currencyCode: null, reason: "reliance-not-met" }}
      />,
    );
    expect(html).not.toContain("/account/desk/repricing");
    expect(html).not.toContain("A migration suggestion is unavailable");
  });
  it("shows unavailable without a CTA when estimates cannot support a suggestion", () => {
    const html = renderToStaticMarkup(
      <PricingBulkRepricePage
        nudge={{ status: "unavailable", offsetPercent: null, currencyCode: null, reason: "mixed-currency" }}
      />,
    );
    expect(html).toContain("A migration suggestion is unavailable");
    expect(html).toContain("A migration suggestion could not be computed because the prices use multiple currencies.");
    expect(html).not.toContain("mixed-currency");
    expect(html).not.toContain("/account/desk/repricing");
  });
  it("flattens upload furniture and outlines the populated reprice job entity", () => {
    const html = renderToStaticMarkup(
      <PricingBulkRepricePage
        activeJobId="job_1"
        initialActiveJob={{
          jobId: "job_1",
          jobKind: "bulk-reprice",
          status: "running",
          progress: { phase: "processing", completed: 2, total: 5, message: "Applying price changes." },
          result: null,
          errorMessage: null,
          createdAt: "2026-08-15T12:00:00.000Z",
          startedAt: "2026-08-15T12:00:01.000Z",
          completedAt: null,
          updatedAt: "2026-08-15T12:00:02.000Z",
        }}
      />,
    );

    const rendered = document.createElement("div");
    rendered.innerHTML = html;
    const upload = rendered.querySelector('[data-testid="bulk-reprice-upload-furniture"]');
    expect(rendered.querySelector('[data-testid="bulk-reprice-job-entity"]')?.className).toBe(
      "rounded-tokenLg border border-muted overflow-hidden bg-surface p-4",
    );
    expect(upload?.closest(".ds-glass")).toBeNull();
    expect(upload?.closest(".shadow-tokenSm")).toBeNull();
    expect(html).toContain("Applying price changes.");
  });
});
