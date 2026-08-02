import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compileHelpArticleCorpus,
  compileHelpArticleSource,
  renderCitationContract,
  renderGeneratedManifest,
} from "./compile-help-articles.mjs";

const integrationsDirectory = dirname(fileURLToPath(import.meta.url));
const articlesDirectory = resolve(integrationsDirectory, "../domain/articles");
const generatedManifestPath = resolve(integrationsDirectory, "../domain/generated/articles.ts");
const citationContractPath = resolve(
  integrationsDirectory,
  "../../../../../contracts/public-docs/generated/help-article-policy-citations.ts",
);

function repositoryCorpusSources() {
  return readdirSync(articlesDirectory)
    .filter((fileName) => fileName.endsWith(".md"))
    .sort()
    .map((fileName) => ({ fileName, source: readFileSync(join(articlesDirectory, fileName), "utf8") }));
}

function withoutCompiledContent(article: ReturnType<typeof compileHelpArticleSource>) {
  const { blocks: _blocks, headings: _headings, ...metadata } = article;
  return metadata;
}

function assertSingleArticleContentChange(
  before: ReturnType<typeof compileHelpArticleCorpus>,
  after: ReturnType<typeof compileHelpArticleCorpus>,
  targetSlug: string,
) {
  for (const article of before) {
    const candidate = after.find(({ slug, locale }) => slug === article.slug && locale === article.locale);
    if (!candidate) throw new Error(`compiled sibling ${article.slug} disappeared`);
    if (article.slug === targetSlug) {
      if (JSON.stringify(article.blocks) === JSON.stringify(candidate.blocks)) {
        throw new Error(`${targetSlug} compiled content remained byte-identical`);
      }
      if (JSON.stringify(withoutCompiledContent(article)) !== JSON.stringify(withoutCompiledContent(candidate))) {
        throw new Error(`${targetSlug} metadata changed during a content-only mutation`);
      }
    } else if (JSON.stringify(article) !== JSON.stringify(candidate)) {
      throw new Error(`compiled sibling ${article.slug} changed`);
    }
  }
}

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

  it("isolates a true content-only mutation to sales-tax and leaves the citation artifact byte-identical", async () => {
    const sources = repositoryCorpusSources();
    const before = compileHelpArticleCorpus(sources, { allowedAudiences: ["buyer", "seller"] });
    const afterSources = sources.map((candidate) =>
      candidate.fileName === "sales-tax.en.md"
        ? { ...candidate, source: `${candidate.source.trimEnd()}\n\nContent-only isolation control.\n` }
        : candidate,
    );
    const after = compileHelpArticleCorpus(afterSources, { allowedAudiences: ["buyer", "seller"] });

    expect(() => assertSingleArticleContentChange(before, after, "sales-tax")).not.toThrow();
    expect(await renderGeneratedManifest(after)).not.toBe(await renderGeneratedManifest(before));
    expect(await renderCitationContract(after)).toBe(await renderCitationContract(before));
    expect(await renderCitationContract(before)).toBe(readFileSync(citationContractPath, "utf8"));
    expect(await renderGeneratedManifest(before)).toBe(readFileSync(generatedManifestPath, "utf8"));

    expect(() => assertSingleArticleContentChange(before, before, "sales-tax")).toThrow(
      "sales-tax compiled content remained byte-identical",
    );
  });

  it("proves citation sensitivity with condition-and-photo-standards while preserving every sibling", async () => {
    const sources = repositoryCorpusSources();
    const before = compileHelpArticleCorpus(sources, { allowedAudiences: ["buyer", "seller"] });
    const afterSources = sources.map((candidate) =>
      candidate.fileName === "condition-and-photo-standards.en.md"
        ? {
            ...candidate,
            source: candidate.source.replace('citedPolicies: ["marketplace.listing-evidence"]', "citedPolicies: []"),
          }
        : candidate,
    );
    const after = compileHelpArticleCorpus(afterSources, { allowedAudiences: ["buyer", "seller"] });
    const beforeFixture = before.find(({ slug }) => slug === "condition-and-photo-standards")!;
    const afterFixture = after.find(({ slug }) => slug === "condition-and-photo-standards")!;
    const { citedPolicies: beforeCitations, ...beforeFrozen } = beforeFixture;
    const { citedPolicies: afterCitations, ...afterFrozen } = afterFixture;

    expect(beforeCitations).toEqual(["marketplace.listing-evidence"]);
    expect(afterCitations).toEqual([]);
    expect(afterFrozen).toEqual(beforeFrozen);
    expect(after.filter(({ slug }) => slug !== beforeFixture.slug)).toEqual(
      before.filter(({ slug }) => slug !== beforeFixture.slug),
    );
    expect(await renderCitationContract(after)).not.toBe(await renderCitationContract(before));
    expect(await renderCitationContract(before)).toContain('slug: "condition-and-photo-standards"');
    expect(await renderCitationContract(after)).not.toContain('slug: "condition-and-photo-standards"');
  });
});
