// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { readCatalogListQuery } from "../../../../../support/shell-support/list-query-state";
import type { CatalogScopeRecordDetail } from "../../../../scope-registry/ui/contracts";
import { CatalogScopeLandingPage } from "./scope-landing-page";
import { buildCatalogScopeLandingReadModel } from "./scope-landing-read-model";

afterEach(cleanup);

const GENERATED_AT = "2026-07-13T12:00:00.000Z";

function scope(overrides: Partial<CatalogScopeRecordDetail> = {}): CatalogScopeRecordDetail {
  return {
    scopeRecordId: "scope_expansion_paldean_fates",
    productDomain: "pokemon",
    scopeKind: "expansion",
    referenceTypeKey: "expansion",
    referenceRecordId: "ref_expansion_paldean_fates",
    referenceRecordKey: "paldean-fates",
    name: "Paldean Fates",
    parentScopeRecordId: null,
    productLineScopeRecordId: null,
    seriesScopeRecordId: null,
    releaseDate: "2024-01-26",
    officialSetCode: "PAF",
    languageEditions: ["en", "ja"],
    lifecycleStatus: "active",
    updatedAt: GENERATED_AT,
    ...overrides,
  };
}

function renderLanding(input: { scopes: ListResponse<CatalogScopeRecordDetail>; url?: string; error?: string | null }) {
  const url = input.url ?? "https://admin.example/catalog/scopes";
  const query = readCatalogListQuery(new Request(url));
  const readModel = buildCatalogScopeLandingReadModel({
    scopes: input.scopes,
    filters: {
      search: query.search,
      productDomain: "",
      languageEdition: query.language,
      lifecycleStatus: query.status,
    },
    generatedAt: GENERATED_AT,
  });

  const router = createMemoryRouter(
    [
      {
        path: "/catalog/scopes",
        Component: () => (
          <CatalogScopeLandingPage
            readModel={readModel}
            query={query}
            productDomain=""
            loading={false}
            error={input.error ?? null}
          />
        ),
      },
      { path: "/catalog/scopes/:id", Component: () => <h1>Scope Detail</h1> },
    ],
    { initialEntries: [new URL(url).pathname + new URL(url).search] },
  );

  render(
    <ChaseRoot linkComponent={RouterLinkAdapter}>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
}

describe("CatalogScopeLandingPage", () => {
  // The DS DataTable renders both a desktop table and a mobile card layout in
  // jsdom, so cell values appear more than once; assert on "at least one".
  it("renders the canonical scope record list with promotion and sync signals, each linking to its Scope Detail", async () => {
    renderLanding({ scopes: { items: [scope()], total: 1, count: 1 } });

    expect(await screen.findByRole("heading", { name: "Scopes" })).toBeTruthy();
    expect(screen.getAllByText("Paldean Fates").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Live").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Fresh").length).toBeGreaterThan(0);

    const viewLinks = screen.getAllByRole("link", { name: "View" });
    expect(
      viewLinks.some((link) => link.getAttribute("href") === "/catalog/scopes/scope_expansion_paldean_fates"),
    ).toBe(true);
  });

  it("shows a stale-sync signal for a scope whose projection has not advanced recently", () => {
    renderLanding({
      scopes: { items: [scope({ updatedAt: "2026-01-01T00:00:00.000Z" })], total: 1, count: 1 },
    });

    expect(screen.getAllByText("Stale sync").length).toBeGreaterThan(0);
  });

  it("renders the empty state when no scope records match", () => {
    renderLanding({ scopes: { items: [], total: 0, count: 0 } });

    expect(screen.queryByText("Paldean Fates")).toBeNull();
    // EntityListPage renders its empty state (no rows) rather than the table.
    expect(screen.queryAllByRole("link", { name: "View" })).toHaveLength(0);
  });

  it("surfaces a blocked banner when the list load failed", () => {
    renderLanding({
      scopes: { items: [], total: 0, count: 0 },
      error: "Scope records are unavailable.",
    });

    expect(screen.getAllByText("Scope records are unavailable.").length).toBeGreaterThan(0);
  });
});
