import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  developerArticles,
  findDeveloperArticle,
  listDeveloperToolsByAvailability,
} from "../domain/developer-article-catalog";
import type { DeveloperArticle } from "../domain/developer-article-model";
import {
  POLICY_VALUE_KEY_ATTRIBUTE,
  POLICY_VALUE_STATE_ATTRIBUTE,
  POLICY_VALUE_UNAVAILABLE_STATE,
  POLICY_VALUES_AGGREGATE_KEYS_ATTRIBUTE,
  POLICY_VALUES_AGGREGATE_STATE_ATTRIBUTE,
  parsePolicyValueKeys,
} from "../../help/domain/policy-value-state";
import { DeveloperArticlePage, DeveloperPortalPage } from "./developer-pages";

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

describe("developer portal pages", () => {
  it("renders the separate developer article manifest", () => {
    render(<DeveloperPortalPage />, { wrapper: MemoryRouter });
    expect(screen.getByRole("heading", { name: "Build with Chase Sets" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Developer quickstart" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open JSON manifest" }).getAttribute("href")).toBe(
      "/developers/manifest.json",
    );
    expect(screen.getByRole("link", { name: "Review Agent Connector Terms" }).getAttribute("href")).toBe(
      "/agent-terms",
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

  it("raises the article link cards a visitor opens", () => {
    const { container, unmount } = render(<DeveloperPortalPage />, { wrapper: MemoryRouter });
    for (const article of developerArticles) {
      const title = within(container).getByRole("heading", { name: article.title, level: 2 });
      expect(surfaceIntent(title.closest(surfaceRootSelector)), article.title).toBe("elevated");
    }
    unmount();
  });

  it("keeps the article body and every MCP tool descriptor flush as reading furniture", () => {
    const article = findDeveloperArticle("mcp-tool-catalog");
    if (!article) throw new Error("missing MCP tool catalog article");
    const { container, unmount } = render(<DeveloperArticlePage article={article} />, { wrapper: MemoryRouter });
    const tools = [...listDeveloperToolsByAvailability("available"), ...listDeveloperToolsByAvailability("planned")];
    const toolHeadings = within(container).getAllByRole("heading", { level: 4 });
    expect(toolHeadings.map((heading) => heading.textContent)).toEqual(tools.map((tool) => tool.title));
    expect(toolHeadings.map((heading) => surfaceIntent(heading.closest(surfaceRootSelector)))).toEqual(
      tools.map(() => "flush"),
    );
    // The compiled body renders before the catalog, so it is the first article.
    const articleBody = container.querySelector("article");
    expect(toolHeadings.some((heading) => articleBody?.contains(heading))).toBe(false);
    expect(surfaceIntent(articleBody)).toBe("flush");
    unmount();
  });

  it("marks an unresolved policy value on a sibling route through the shared compiled-body chokepoint (#6115)", () => {
    // Developer articles never carry policy tokens today, but they render
    // through the same `CompiledArticleBody` every help/press/sales-fees
    // article does. Planting the domain discriminant here — with none of
    // the help route's loaders or wiring involved — proves the marker is
    // emitted by construction from the discriminant itself, not re-derived
    // per route.
    const base = findDeveloperArticle("mcp-tool-catalog");
    if (!base) throw new Error("missing MCP tool catalog article");
    const unresolvedKey = "sibling-route-probe.unavailable-key";
    const article: DeveloperArticle = {
      ...base,
      blocks: [{ type: "paragraph", content: [{ type: "policy-value-unavailable", key: unresolvedKey }] }],
    };

    render(<DeveloperArticlePage article={article} />, { wrapper: MemoryRouter });

    const marker = document.querySelector(`[${POLICY_VALUE_STATE_ATTRIBUTE}="${POLICY_VALUE_UNAVAILABLE_STATE}"]`);
    expect(marker?.getAttribute(POLICY_VALUE_KEY_ATTRIBUTE)).toBe(unresolvedKey);
    const aggregate = document.querySelector(`[${POLICY_VALUES_AGGREGATE_STATE_ATTRIBUTE}]`);
    expect([...parsePolicyValueKeys(aggregate!.getAttribute(POLICY_VALUES_AGGREGATE_KEYS_ATTRIBUTE)!)]).toEqual([
      unresolvedKey,
    ]);
  });
});
