import { describe, expect, it } from "vitest";
import {
  buildPublicDocsStaleReviewReport,
  DEFAULT_PUBLIC_DOC_REVIEW_MAX_AGE_DAYS,
} from "./public-docs-stale-review.mjs";

describe("public docs stale-review report", () => {
  it("lists only articles older than the configured review window", () => {
    const report = buildPublicDocsStaleReviewReport(
      [
        { title: "Current", href: "/help/current", locale: "en", reviewedAt: "2026-06-01" },
        { title: "Stale", href: "/help/stale", locale: "en", reviewedAt: "2026-01-01" },
      ],
      { now: new Date("2026-07-12T00:00:00Z"), maxAgeDays: 90 },
    );
    expect(report.stale.map((article) => article.title)).toEqual(["Stale"]);
    expect(report.markdown).toContain("2026-01-01");
    expect(report.markdown).not.toContain("/help/current");
  });

  it("keeps the default review window explicit", () => {
    expect(DEFAULT_PUBLIC_DOC_REVIEW_MAX_AGE_DAYS).toBe(90);
  });
});
