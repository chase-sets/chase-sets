import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { findDeveloperArticle } from "../domain/developer-article-catalog";
import { DeveloperArticlePage, DeveloperPortalPage } from "./developer-pages";

describe("developer portal pages", () => {
  it("renders the separate developer article manifest", () => {
    render(<DeveloperPortalPage />, { wrapper: MemoryRouter });
    expect(screen.getByRole("heading", { name: "Build with Chase Sets" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Developer quickstart" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open JSON manifest" }).getAttribute("href")).toBe(
      "/developers/manifest.json",
    );
  });

  it("renders available and planned generated MCP descriptors with schemas", () => {
    const article = findDeveloperArticle("mcp-tool-catalog");
    if (!article) throw new Error("missing MCP tool catalog article");
    render(<DeveloperArticlePage article={article} />, { wrapper: MemoryRouter });
    expect(screen.getByRole("heading", { name: "Available tools" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Planned tools" })).toBeTruthy();
    expect(screen.getAllByText("discovery.search-market").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Input schema").length).toBeGreaterThan(0);
  });
});
