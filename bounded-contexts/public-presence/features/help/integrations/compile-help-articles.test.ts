import { describe, expect, it } from "vitest";
import { compileHelpArticleCorpus, compileHelpArticleSource } from "./compile-help-articles.mjs";

const validSource = `---
slug: example
title: Example article
description: An honest example.
audience: buyer
category: buying
reviewedAt: "2026-07-12"
citedPolicies: []
relatedFlows: []
claimCategories: []
promiseTable:
  - claim: The example renders.
    issues: ["#4352"]
    tests: []
---
## Start here

Read the [help hub](/help).
`;

describe("help article compiler", () => {
  it("compiles strict frontmatter and Markdown into typed render blocks", () => {
    expect(compileHelpArticleSource("example.en.md", validSource)).toMatchObject({
      slug: "example",
      locale: "en",
      href: "/help/buying/example",
      headings: [{ level: 2, id: "start-here", text: "Start here" }],
      blocks: [
        { type: "heading", id: "start-here" },
        {
          type: "paragraph",
          content: [
            { type: "text", value: "Read the " },
            { type: "link", label: "help hub", href: "/help" },
            { type: "text", value: "." },
          ],
        },
      ],
    });
  });

  it("fails when required frontmatter is missing", () => {
    expect(() =>
      compileHelpArticleSource("example.en.md", validSource.replace("title: Example article\n", "")),
    ).toThrow("title must be a non-empty string");
  });

  it("rejects impossible review dates", () => {
    expect(() => compileHelpArticleSource("example.en.md", validSource.replace("2026-07-12", "2026-02-31"))).toThrow(
      "reviewedAt must be a real date",
    );
  });

  it("requires promises for claim-bearing categories", () => {
    expect(() =>
      compileHelpArticleSource(
        "example.en.md",
        validSource
          .replace("claimCategories: []", 'claimCategories: ["shipping"]')
          .replace(/promiseTable:[\s\S]*?---\n/, "promiseTable: []\n---\n"),
      ),
    ).toThrow("claim-bearing article categories (shipping) require promiseTable entries");
  });

  it("fails the corpus for a broken internal help link", () => {
    expect(() =>
      compileHelpArticleCorpus([
        {
          fileName: "example.en.md",
          source: validSource.replace("[help hub](/help)", "[missing](/help/buying/missing)"),
        },
      ]),
    ).toThrow("broken help link '/help/buying/missing'");
  });

  it("rejects raw HTML and relative links", () => {
    expect(() =>
      compileHelpArticleSource("example.en.md", validSource.replace("Read the", "<aside>Read</aside> the")),
    ).toThrow("raw HTML is not supported");
    expect(() =>
      compileHelpArticleCorpus([{ fileName: "example.en.md", source: validSource.replace("/help", "other.md") }]),
    ).toThrow("relative link 'other.md' is not allowed");
  });

  it("compiles reviewed policy tokens and rejects every non-whitelisted key", () => {
    const compiled = compileHelpArticleSource(
      "example.en.md",
      validSource
        .replace("citedPolicies: []", 'citedPolicies: ["commercial-terms.marketplace-sales-fee-schedule"]')
        .replace("Read the [help hub](/help).", "The fee is {{policy:marketplace-sales-fee.standard.bps}}."),
    );
    expect(compiled).toMatchObject({
      policyValueKeys: ["marketplace-sales-fee.standard.bps"],
      blocks: expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([{ type: "policy-value", key: "marketplace-sales-fee.standard.bps" }]),
        }),
      ]),
    });
    expect(() =>
      compileHelpArticleSource(
        "example.en.md",
        validSource.replace("Read the [help hub](/help).", "{{policy:commercial-terms.authenticity-fee.internal}}"),
      ),
    ).toThrow("is not publicly whitelisted");
    expect(() =>
      compileHelpArticleSource(
        "example.en.md",
        validSource.replace("Read the [help hub](/help).", "**{{policy:marketplace-sales-fee.standard.bps}}**"),
      ),
    ).toThrow("cannot be nested");
    expect(() =>
      compileHelpArticleSource(
        "example.en.md",
        validSource.replace("Read the [help hub](/help).", "{{policy:NOT_VALID}}"),
      ),
    ).toThrow("is malformed");
    expect(() =>
      compileHelpArticleSource(
        "example.en.md",
        validSource.replace("Read the [help hub](/help).", "{{policy:marketplace-sales-fee.standard.bps}}"),
      ),
    ).toThrow("citedPolicies must include 'commercial-terms.marketplace-sales-fee-schedule'");
  });
});
