import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";
import { FoundersOfferTermsRouteAdapter } from "../../policies/ui/policy-artifact-route-adapter";
import { helpCategories, listHelpArticlesByCategory, publicHelpArticles } from "../domain/article-catalog";
import { resolveArticlePolicyValues } from "../domain/resolve-article-policy-values";
import {
  POLICY_VALUE_KEY_ATTRIBUTE,
  POLICY_VALUE_STATE_ATTRIBUTE,
  POLICY_VALUE_UNAVAILABLE_STATE,
  POLICY_VALUES_AGGREGATE_KEYS_ATTRIBUTE,
  POLICY_VALUES_AGGREGATE_STATE_ATTRIBUTE,
  POLICY_VALUES_DEGRADED_STATE,
  parsePolicyValueKeys,
} from "../domain/policy-value-state";
import { helpAudienceLabel, HelpArticlePage, HelpCategoryPage, HelpHubPage, type HelpArticleCard } from "./help-pages";

const surfaceRootSelector = ".min-w-0.max-w-full.rounded-tokenLg";

// Reads a Surface root's rendered intent from design-system-owned classes:
// flush/tinted carry no `surface-border` and no `shadow-` class.
function surfaceIntent(surface: Element | null) {
  const classes = [...(surface?.classList ?? [])];
  if (classes.includes("surface-border") || classes.some((name) => name.startsWith("shadow-"))) {
    return classes.includes("shadow-tokenLg") ? "elevated" : "legacy";
  }
  if (classes.includes("border")) return "outlined";
  return classes.includes("bg-surface-2") ? "tinted" : "flush";
}

function unresolvedMarkerKeys() {
  return [...document.querySelectorAll(`[${POLICY_VALUE_STATE_ATTRIBUTE}="${POLICY_VALUE_UNAVAILABLE_STATE}"]`)]
    .map((node) => node.getAttribute(POLICY_VALUE_KEY_ATTRIBUTE))
    .sort();
}

function aggregateMarker() {
  return document.querySelector(`[${POLICY_VALUES_AGGREGATE_STATE_ATTRIBUTE}]`);
}

/** Every `policy-value` occurrence's key, with repeats — an article can cite the same key more than once, and each occurrence renders (and must mark) its own node. */
function policyValueOccurrenceKeys(article: ReturnType<typeof resolvedArticle> | (typeof publicHelpArticles)[number]) {
  const keys: string[] = [];
  for (const block of article.blocks) {
    const inlineLists = block.type === "list" ? block.items : [block.content];
    for (const inlines of inlineLists) {
      for (const inline of inlines) {
        if (inline.type === "policy-value") keys.push(inline.key);
      }
    }
  }
  return keys.sort();
}

function resolvedArticle(slug: string) {
  const article = publicHelpArticles.find((candidate) => candidate.slug === slug);
  if (!article) throw new Error(`missing article '${slug}'`);
  return resolveArticlePolicyValues(article, {
    values: Object.fromEntries(
      article.policyValueKeys.map((key) => [
        key,
        key.endsWith(".days")
          ? ({ type: "days", value: 30, effectiveFrom: "2026-07-03T00:00:00.000Z", upcoming: [] } as const)
          : ({ type: "hours", value: 48, effectiveFrom: "2026-07-03T00:00:00.000Z", upcoming: [] } as const),
      ]),
    ),
    resolvedAt: "2026-07-12T00:00:00.000Z",
    propagationSeconds: 360,
    changeCalloutDays: 30,
  });
}

function expectSalesFoundersRule(text: string) {
  expect(text).toContain("Every account admitted to beta");
  expect(text).toContain("0% marketplace sales fee for 60 days from the start of its beta access");
  expect(text).toContain("500 cap applies only to numbered founder badges");
  expect(text).toContain("first listing or submitted offer claims a badge while numbers remain");
}

function foundersPromise(article: (typeof publicHelpArticles)[number]) {
  const promises = article.promiseTable.filter((promise) => promise.issues.includes("#4068"));
  expect(promises).toHaveLength(1);
  return promises[0]!;
}

function renderedFoundersParagraph(container: HTMLElement, heading: string) {
  const article = container.querySelector("article")!;
  const paragraph = within(article).getByRole("heading", { name: heading, level: 2 }).nextElementSibling;
  expect(paragraph?.tagName).toBe("P");
  return paragraph!.textContent!;
}

describe("public help pages", () => {
  const sellerArticle = resolvedArticle("seller-migration-tcgplayer-ebay");
  const sellerLinks = sellerArticle.blocks.flatMap((block) =>
    (block.type === "list" ? block.items : [block.content]).flatMap((content) =>
      content.filter((inline) => inline.type === "link"),
    ),
  );
  const accountLinks = sellerLinks.filter((inline) => inline.href.startsWith("/account/"));

  it.each([undefined, "", "   "])("help account links without marketplace origin (%s)", (marketplaceOrigin) => {
    const { container } = render(
      <HelpArticlePage article={sellerArticle} related={[]} marketplaceOrigin={marketplaceOrigin} />,
      { wrapper: MemoryRouter },
    );
    const body = container.querySelector("article")!;
    expect(accountLinks).toHaveLength(8);
    expect(body.querySelectorAll('a[href*="/account"]')).toHaveLength(0);
    expect(body.innerHTML).not.toContain("/account");
    const textNodes: string[] = [];
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) textNodes.push(walker.currentNode.textContent!);
    for (const label of new Set(accountLinks.map((link) => link.label))) {
      const occurrences = accountLinks.filter((link) => link.label === label).length;
      expect(textNodes.filter((text) => text === label)).toHaveLength(occurrences);
      expect(within(body as HTMLElement).queryAllByRole("link", { name: label })).toHaveLength(0);
    }
  });

  it.each(["https://marketplace.chasesets.test", " https://marketplace.chasesets.test/ "])(
    "help account links with marketplace origin (%s)",
    (marketplaceOrigin) => {
      const { container } = render(
        <HelpArticlePage article={sellerArticle} related={[]} marketplaceOrigin={marketplaceOrigin} />,
        { wrapper: MemoryRouter },
      );
      const body = container.querySelector("article")!;
      expect([...body.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href"))).toEqual(
        sellerLinks.map((link) =>
          link.href.startsWith("/account/") ? `https://marketplace.chasesets.test${link.href}` : link.href,
        ),
      );
    },
  );

  it.each([undefined, "https://marketplace.chasesets.test/"])(
    "preserves account query/hash and non-account links in every inline block shape (%s)",
    (marketplaceOrigin) => {
      const links = [
        "/account",
        "/account?tab=listings#new",
        "/account/listings?status=draft#new",
        "/help/selling",
        "/sales-fees",
        "https://example.test",
        "https://example.test/account",
        "/accounting",
      ];
      const content = links.map((href) => ({ type: "link" as const, href, label: href }));
      const article: typeof sellerArticle = {
        ...sellerArticle,
        blocks: [
          { type: "heading" as const, id: "links", level: 2 as const, content, text: links.join(" ") },
          { type: "paragraph" as const, content },
          { type: "list" as const, ordered: false, items: [content] },
        ],
      };
      const { container } = render(
        <HelpArticlePage article={article} related={[]} marketplaceOrigin={marketplaceOrigin} />,
        { wrapper: MemoryRouter },
      );
      expect(
        [...container.querySelector("article")!.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href")),
      ).toEqual(
        Array.from({ length: 3 }, () =>
          links.flatMap((href, index) =>
            index < 3 ? (marketplaceOrigin ? [`https://marketplace.chasesets.test${href}`] : []) : [href],
          ),
        ).flat(),
      );
    },
  );

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("groups help categories by audience", () => {
    render(<HelpHubPage />, { wrapper: MemoryRouter });
    expect(screen.getByRole("heading", { name: "How can we help?" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "For buyers" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "For sellers" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Browse Selling/ }).getAttribute("href")).toBe("/help/selling");
    expect(screen.queryByRole("heading", { name: "For developers" })).toBeNull();
  });

  it.each(helpCategories)("renders every %s category card in catalog order with exact card fields", (category) => {
    const canonicalArticles = listHelpArticlesByCategory(category);
    expect(canonicalArticles.length).toBeGreaterThan(0);
    const cards: readonly HelpArticleCard[] = canonicalArticles.map(({ audience, title, description, href }) => ({
      audience,
      title,
      description,
      href,
    }));

    const { container } = render(<HelpCategoryPage category={category} articles={cards} />, {
      wrapper: MemoryRouter,
    });
    const renderedCards = [...container.querySelectorAll("article")];

    expect(renderedCards).toHaveLength(canonicalArticles.length);
    for (const [index, article] of canonicalArticles.entries()) {
      const card = renderedCards[index];
      expect(card).toBeDefined();
      const cardQueries = within(card!);
      expect(cardQueries.getByText(helpAudienceLabel(article.audience))).toBeTruthy();
      expect(cardQueries.getByRole("heading", { name: article.title })).toBeTruthy();
      expect(cardQueries.getByText(article.description)).toBeTruthy();
      expect(cardQueries.getByRole("link", { name: "Read article" }).getAttribute("href")).toBe(article.href);
    }
  });

  it("keeps category consumers on the card-only component prop", () => {
    type CategoryArticle = Parameters<typeof HelpCategoryPage>[0]["articles"][number];
    const readArticleOnlyField = (article: CategoryArticle) => {
      // @ts-expect-error Category cards deliberately do not expose compiled article blocks.
      return article.blocks;
    };

    expect(readArticleOnlyField).toBeTypeOf("function");
  });

  it("renders compiled blocks, review metadata, a table of contents, and related articles", () => {
    const article = resolvedArticle("order-protection");
    const related = publicHelpArticles.filter(
      (candidate) => candidate.category === "buying" && candidate.slug !== article.slug,
    );
    render(<HelpArticlePage article={article} related={related} />, { wrapper: MemoryRouter });
    expect(screen.getByRole("heading", { name: "Order protection", level: 1 })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "On this page" })).toBeTruthy();
    expect(screen.getByText("Last reviewed July 15, 2026")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Related articles" })).toBeTruthy();
  });

  it("states the beta-access window and badge-only cap in the compiled Sales fees promise", () => {
    expectSalesFoundersRule(foundersPromise(resolvedArticle("sales-fees")).claim);
  });

  it("states the beta-access window and badge-only cap in the rendered Sales fees paragraph", () => {
    const article = resolvedArticle("sales-fees");
    const { container } = render(<HelpArticlePage article={article} related={[]} />, { wrapper: MemoryRouter });
    const paragraph = renderedFoundersParagraph(container, "Founders window");
    expectSalesFoundersRule(paragraph);
    expect(paragraph).toContain(
      "Listings confirmed inside the window lock the 0% rate exactly like any other locked rate",
    );
    expect(paragraph).toContain("After the window ends, new listings lock at the standard schedule.");
  });

  it.each(["promise", "paragraph"] as const)("rejects the old Sales fees %s independently", (surface) => {
    const source = resolvedArticle("sales-fees");
    const headingIndex = source.blocks.findIndex((block) => block.type === "heading" && block.id === "founders-window");
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(source.blocks[headingIndex + 1]?.type).toBe("paragraph");
    const article: typeof source = {
      ...source,
      promiseTable: source.promiseTable.map((promise) =>
        surface === "promise" && promise.issues.includes("#4068")
          ? {
              ...promise,
              claim: "The founders window applies a 0% sales-fee agreement for 60 days, capped at 500 founders.",
            }
          : promise,
      ),
      blocks: source.blocks.map((block, index) =>
        surface === "paragraph" && index === headingIndex + 1
          ? {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  value:
                    "The first 500 accounts to list an item or submit an offer after receiving beta access claim a founders place. A founders account pays a 0% marketplace sales fee for 60 days from the start of its beta access; listings confirmed inside the window lock the 0% rate exactly like any other locked rate. After the window ends, new listings lock at the standard schedule.",
                },
              ],
            }
          : block,
      ),
    };
    const { container } = render(<HelpArticlePage article={article} related={[]} />, { wrapper: MemoryRouter });
    const claim = foundersPromise(article).claim;
    const paragraph = renderedFoundersParagraph(container, "Founders window");
    expectSalesFoundersRule(surface === "promise" ? paragraph : claim);
    expect(() => expectSalesFoundersRule(surface === "promise" ? claim : paragraph)).toThrow();
  });

  it("keeps the real press article aligned on the beta-access window and numbered badges", () => {
    const article = resolvedArticle("creators-and-press");
    expect(article.href).toBe("/press");
    const { container } = render(<HelpArticlePage article={article} related={[]} />, { wrapper: MemoryRouter });
    const paragraph = renderedFoundersParagraph(container, "The founders offer");
    expect(paragraph).toContain("The first 500 accounts to list or make an offer claim a numbered founder badge");
    expect(paragraph).toContain("Beta access also opens a 60-day 0% seller-fee window");
    expect(paragraph).toContain("every listing created in that window locks 0% seller fees until it sells");
  });

  it("keeps the default Founders terms aligned without changing their counsel-pending posture", () => {
    const { container } = render(<FoundersOfferTermsRouteAdapter />, { wrapper: MemoryRouter });
    const article = container.querySelector("article")!;
    const eligibility = within(article).getByRole("region", { name: "Eligibility and the founder cap" });
    expect(eligibility.textContent).toContain(
      "The first 500 accounts to list or make an offer claim a numbered founder badge",
    );
    expect(eligibility.textContent).toContain(
      "its first listing or offer claims a number in activation order, while numbers remain available",
    );
    expect(eligibility.textContent).toContain(
      "The cap applies to claimed Founder Numbers, not invitations or the number of accounts whose beta access opens a fee window.",
    );
    const window = within(article).getByRole("region", { name: "The offer window and listing fee locks" });
    expect(window.textContent).toContain("Beta access opens a 60-day 0% seller-fee window");
    expect(window.textContent).toContain("The window starts at beta access, independently of badge claim");
    expect(window.textContent).toContain("Listings you locked at 0% keep that rate until they sell.");
    expect(container.querySelector('[data-policy-publication-status="counsel-review-required"]')).not.toBeNull();
  });

  it("raises only the tiles a visitor opens and keeps reading furniture flush or tinted", () => {
    const hub = render(<HelpHubPage />, { wrapper: MemoryRouter });
    const categoryHeadings = screen.getAllByRole("heading", { level: 3 });
    expect(categoryHeadings.length).toBeGreaterThan(0);
    for (const heading of categoryHeadings) {
      expect(surfaceIntent(heading.closest(surfaceRootSelector)), heading.textContent ?? "").toBe("elevated");
    }
    hub.unmount();

    const article = resolvedArticle("order-protection");
    const related = publicHelpArticles.filter(
      (candidate) => candidate.category === "buying" && candidate.slug !== article.slug,
    );
    render(<HelpArticlePage article={article} related={related} />, { wrapper: MemoryRouter });
    const firstHeading = article.headings[0]!;
    expect(surfaceIntent(document.getElementById(firstHeading.id)!.closest(surfaceRootSelector))).toBe("flush");
    expect(surfaceIntent(screen.getByRole("navigation", { name: "On this page" }))).toBe("tinted");
    for (const candidate of related) {
      const title = screen.getByRole("heading", { name: candidate.title, level: 2 });
      expect(surfaceIntent(title.closest(surfaceRootSelector)), candidate.title).toBe("elevated");
    }
  });

  it("raises every category-page article card as an entity tile", () => {
    const cards: readonly HelpArticleCard[] = listHelpArticlesByCategory("buying");
    const { container } = render(<HelpCategoryPage category="buying" articles={cards} />, { wrapper: MemoryRouter });
    const renderedCards = [...container.querySelectorAll("article")];
    expect(renderedCards).toHaveLength(cards.length);
    expect(renderedCards.map(surfaceIntent)).toEqual(cards.map(() => "elevated"));
  });

  it("renders future-effective policy changes as dated callouts", () => {
    const article = resolvedArticle("order-protection");
    render(
      <HelpArticlePage
        article={{
          ...article,
          policyChanges: [
            {
              effectiveFrom: "2026-07-20T00:00:00.000Z",
              description: "The published policy values on this page will update automatically on this date.",
            },
          ],
        }}
        related={[]}
      />,
      { wrapper: MemoryRouter },
    );
    expect(screen.getByText("Changing on July 20, 2026")).toBeTruthy();
  });

  it("renders an explicit marker for policy values that could not be resolved", () => {
    const source = publicHelpArticles.find((article) => article.slug === "order-protection")!;
    const article = resolveArticlePolicyValues(
      source,
      {
        values: {},
        resolvedAt: "2026-07-12T00:00:00.000Z",
        propagationSeconds: 0,
        changeCalloutDays: 0,
      },
      { unavailableKeys: source.policyValueKeys },
    );

    render(<HelpArticlePage article={article} related={[]} />, { wrapper: MemoryRouter });

    // Rendered prose is unchanged (#6115 is a non-goal on visible copy).
    expect(screen.getAllByText("Temporarily unavailable").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("48 hours");

    // Machine-readable contract: every rendered occurrence of an unresolved
    // key carries its own marker (an article can cite the same key twice),
    // and the aggregate node's key set is exactly the union of them — the
    // whole set, not a sample.
    expect(unresolvedMarkerKeys()).toEqual(policyValueOccurrenceKeys(source));
    const aggregate = aggregateMarker();
    expect(aggregate?.getAttribute(POLICY_VALUES_AGGREGATE_STATE_ATTRIBUTE)).toBe(POLICY_VALUES_DEGRADED_STATE);
    const expectedAggregateKeys = [...new Set(source.policyValueKeys)].sort();
    expect([...parsePolicyValueKeys(aggregate!.getAttribute(POLICY_VALUES_AGGREGATE_KEYS_ATTRIBUTE)!)].sort()).toEqual(
      expectedAggregateKeys,
    );
  });

  it("carries no unresolved-value marker or aggregate node on a fully resolved page", () => {
    const article = resolvedArticle("order-protection");

    render(<HelpArticlePage article={article} related={[]} />, { wrapper: MemoryRouter });

    expect(unresolvedMarkerKeys()).toEqual([]);
    expect(aggregateMarker()).toBeNull();
  });

  it("marks exactly the unresolved keys in a mix of resolved, missing, and malformed values", () => {
    const source = publicHelpArticles.find((article) => article.slug === "order-protection")!;
    const [resolvedKey, missingKey, malformedKey, ...restKeys] = source.policyValueKeys;
    expect(resolvedKey).toBeDefined();
    expect(missingKey).toBeDefined();
    // `resolveArticlePolicyValues` never reads a key marked unavailable, so the
    // malformed key (already caught upstream by `resolvePublicPolicyArticle`'s
    // validation, exercised separately in help-route.test.ts) has no entry here
    // — only the resolved keys carry a real value.
    const values = Object.fromEntries(
      [resolvedKey, ...restKeys].map((key) => [
        key,
        { type: "hours", value: 48, effectiveFrom: "2026-07-03T00:00:00.000Z", upcoming: [] } as const,
      ]),
    );

    const article = resolveArticlePolicyValues(
      source,
      { values, resolvedAt: "2026-07-12T00:00:00.000Z", propagationSeconds: 0, changeCalloutDays: 0 },
      { unavailableKeys: [missingKey, malformedKey] },
    );

    render(<HelpArticlePage article={article} related={[]} />, { wrapper: MemoryRouter });

    const expectedUnresolved = [missingKey, malformedKey].sort();
    expect(unresolvedMarkerKeys()).toEqual(expectedUnresolved);
    const aggregate = aggregateMarker();
    expect([...parsePolicyValueKeys(aggregate!.getAttribute(POLICY_VALUES_AGGREGATE_KEYS_ATTRIBUTE)!)].sort()).toEqual(
      expectedUnresolved,
    );
    // The resolved key never shows up as unavailable, and the malformed
    // value never renders as raw provider text or an invented fallback.
    expect(unresolvedMarkerKeys()).not.toContain(resolvedKey);
    expect(document.body.textContent).not.toContain("not-a-real-value");
    expect(document.body.textContent).not.toContain("NaN");
  });

  it("is not fooled by a sibling that mimics the degraded copy without the canonical marker", () => {
    // Same visible words, none of the canonical renderer's tokens: proves a
    // text-matching check would have been fooled, and this attribute check isn't.
    render(
      <div>
        <span>Temporarily unavailable</span>
      </div>,
    );

    expect(unresolvedMarkerKeys()).toEqual([]);
    expect(aggregateMarker()).toBeNull();
  });
});

describe("public reading-page surface-diet census (#8271)", () => {
  // Source order per file; this pins the PR's per-root classification table.
  const expectedElevations: Record<string, readonly string[]> = {
    "help/ui/help-pages.tsx": ["elevated", "elevated", "flush", "tinted"],
    "developer-portal/ui/developer-pages.tsx": ["elevated", "flush"],
    "policies/ui/policy-artifact-page.tsx": ["tinted", "tinted", "flush"],
    "waitlist/ui/compare-page.tsx": ["tinted", "tinted", "tinted"],
    "waitlist/ui/success-page.tsx": ["tinted", "tinted", "tinted"],
    "waitlist/ui/fee-comparison-calculator.tsx": ["tinted"],
  };

  function surfaceRoots(fileName: string, source: string) {
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const roots: { elevation: string | null; elevatedBoolean: boolean }[] = [];
    function attribute(attributes: ts.JsxAttributes, name: string) {
      return attributes.properties.find(
        (candidate) => ts.isJsxAttribute(candidate) && candidate.name.getText(sourceFile) === name,
      );
    }
    function visit(node: ts.Node) {
      if (
        (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
        node.tagName.getText(sourceFile) === "Surface"
      ) {
        const elevation = attribute(node.attributes, "elevation");
        roots.push({
          elevation:
            elevation &&
            ts.isJsxAttribute(elevation) &&
            elevation.initializer &&
            ts.isStringLiteral(elevation.initializer)
              ? elevation.initializer.text
              : null,
          elevatedBoolean: Boolean(attribute(node.attributes, "elevated")),
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return roots;
  }

  it("gives every Surface root in the six reading-page files a literal elevation and no legacy elevated boolean", () => {
    const featuresRoot = join(repositoryRoot(), "bounded-contexts", "public-presence", "features");
    let total = 0;
    for (const [file, elevations] of Object.entries(expectedElevations)) {
      const roots = surfaceRoots(file, readFileSync(join(featuresRoot, file), "utf8"));
      expect(
        roots.filter((root) => root.elevation === null),
        `${file} bare roots`,
      ).toEqual([]);
      expect(
        roots.filter((root) => root.elevatedBoolean),
        `${file} legacy booleans`,
      ).toEqual([]);
      expect(
        roots.map((root) => root.elevation),
        file,
      ).toEqual(elevations);
      total += roots.length;
    }
    expect(total).toBe(16);
  });
});

function repositoryRoot() {
  let candidate = process.cwd();
  while (!existsSync(join(candidate, "pnpm-workspace.yaml"))) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(`Could not locate the repository root from ${process.cwd()}`);
    }
    candidate = parent;
  }
  return candidate;
}
