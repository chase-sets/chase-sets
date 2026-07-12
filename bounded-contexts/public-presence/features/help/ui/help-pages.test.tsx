import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicHelpArticles } from "../domain/article-catalog";
import { HelpArticlePage, HelpCategoryPage, HelpHubPage } from "./help-pages";

describe("public help pages", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }));
  });

  afterEach(() => vi.unstubAllGlobals());

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
    const article = publicHelpArticles.find((candidate) => candidate.slug === "order-protection");
    const related = publicHelpArticles.filter((candidate) => candidate.category === "buying" && candidate !== article);
    expect(article).toBeDefined();
    render(<HelpArticlePage article={article!} related={related} />, { wrapper: MemoryRouter });
    expect(screen.getByRole("heading", { name: "Order protection", level: 1 })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "On this page" })).toBeTruthy();
    expect(screen.getByText("Last reviewed July 12, 2026")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Related articles" })).toBeTruthy();
  });

  it("renders future-effective policy changes as dated callouts", () => {
    const article = publicHelpArticles.find((candidate) => candidate.slug === "order-protection");
    expect(article).toBeDefined();
    render(
      <HelpArticlePage
        article={{
          ...article!,
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
});
