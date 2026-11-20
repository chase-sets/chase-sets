// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PricingBulkRepricePage } from "./bulk-reprice-page";

describe("PricingBulkRepricePage", () => {
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

  it("says bulk reprice is not available, with nothing to upload or download, while Pricing has it off", () => {
    const rendered = document.createElement("div");
    rendered.innerHTML = renderToStaticMarkup(<PricingBulkRepricePage available={false} />);

    expect(rendered.textContent).toContain("Bulk reprice is not available for your account yet.");
    expect(rendered.querySelector("form")).toBeNull();
    expect(rendered.querySelector('a[href$="/template.csv"]')).toBeNull();
    expect(rendered.querySelector('a[href="/account/repricing"]')).not.toBeNull();
  });
});
