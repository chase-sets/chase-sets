import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildPublicDocsStaleReviewReport,
  DEFAULT_PUBLIC_DOC_REVIEW_MAX_AGE_DAYS,
} from "./public-docs-stale-review.mjs";

const workflow = readFileSync(new URL("../.github/workflows/public-docs-stale-review.yml", import.meta.url), "utf8");

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

  it("installs checker dependencies before building the stale-review report", () => {
    expect(workflow).toMatch(
      /uses: \.\/\.github\/actions\/setup-pnpm-workspace\s+with:\s+install: true\s+- name: Build stale-review report/s,
    );
  });
});
