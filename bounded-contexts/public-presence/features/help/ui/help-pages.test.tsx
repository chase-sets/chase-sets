import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicHelpArticles } from "../domain/article-catalog";
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
import { HelpArticlePage, HelpCategoryPage, HelpHubPage } from "./help-pages";

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

describe("public help pages", () => {
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

  it("renders a category's compiled article cards", () => {
    const articles = publicHelpArticles.filter((article) => article.category === "buying");
    render(<HelpCategoryPage category="buying" articles={articles} />, { wrapper: MemoryRouter });
    expect(screen.getByRole("heading", { name: "Buying", level: 1 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Order protection" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Refunds and returns" })).toBeTruthy();
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
