import { describe, expect, it } from "vitest";
import { compileHelpArticleCorpus, compileHelpArticleSource } from "./compile-help-articles.mjs";

const validSource = `---
slug: example
title: Example article
description: An honest example.
audience: buyer
category: buying
revisionDate: "2026-07-12"
citedPolicies: []
relatedFlows: []
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

  it("rejects impossible revision dates", () => {
    expect(() => compileHelpArticleSource("example.en.md", validSource.replace("2026-07-12", "2026-02-31"))).toThrow(
      "revisionDate must be a real date",
    );
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
});
