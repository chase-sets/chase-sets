import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { findDeveloperArticle } from "../domain/developer-article-catalog";
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
