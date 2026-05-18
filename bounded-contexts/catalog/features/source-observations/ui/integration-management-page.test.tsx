// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogListQuery } from "../../../support/shell-support/list-query-state";
import { IntegrationManagementPage } from "./integration-management-page";
import type { SourceObservationIntegrationScope } from "./contracts";

const {
  mockImportTcgdexSet,
  mockRevalidate,
  mockUseSourceObservationIntegrationOptions,
  mockSetSearchParams,
  mockUseNavigation,
  mockUseSearchParams,
} = vi.hoisted(() => ({
  mockImportTcgdexSet: vi.fn(),
  mockRevalidate: vi.fn(),
  mockUseSourceObservationIntegrationOptions: vi.fn(),
  mockSetSearchParams: vi.fn(),
  mockUseNavigation: vi.fn(),
  mockUseSearchParams: vi.fn(),
}));

vi.mock("react-router", () => ({
  useNavigation: mockUseNavigation,
  useRevalidator: () => ({ revalidate: mockRevalidate }),
  useSearchParams: mockUseSearchParams,
}));

vi.mock("./use-source-observations", () => ({
  importTcgdexSet: mockImportTcgdexSet,
  useSourceObservationIntegrationOptions: mockUseSourceObservationIntegrationOptions,
}));

const query: CatalogListQuery = {
  search: "",
  status: "",
  language: "",
  source: "",
  setId: "",
  typeKey: "",
  page: 0,
  pageSize: 50,
};

describe("IntegrationManagementPage", () => {
  beforeEach(() => {
    mockUseSourceObservationIntegrationOptions.mockImplementation((input: {
      queryKind: string;
    }) => integrationOptionsResult(input.queryKind));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows pulled provider scopes with language expansion series and review counts", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);

    render(
      <IntegrationManagementPage
        data={{ items: [integrationScope()], total: 1, count: 1 }}
        query={query}
      />,
    );

    expect(screen.getByText("Catalog Integrations")).toBeTruthy();
    expect(screen.getAllByText("Base Set").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Base").length).toBeGreaterThan(0);
    expect(screen.getAllByText("English").length).toBeGreaterThan(0);
    expect(screen.getAllByText("100").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Review" })[0].getAttribute("href"))
      .toBe("/catalog/source-observations?source=tcgdex&language=en&setId=base1");
  });

  it("imports a TCGdex expansion and scopes the integration view to the result", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
    mockImportTcgdexSet.mockResolvedValue({
      setId: "base1",
      expansionId: "base1",
      languageCode: "en",
      observed: 102,
      observationIds: [],
    });

    render(
      <IntegrationManagementPage
        data={{ items: [], total: 0, count: 0 }}
        query={query}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /Import TCGdex Expansion/i })[0]);
    expect(screen.queryByLabelText("TCGdex Expansion ID")).toBeNull();
    const importButton = screen.getByRole("button", { name: /^Import$/i });
    await waitFor(() =>
      expect((importButton as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(importButton);

    await waitFor(() =>
      expect(mockImportTcgdexSet).toHaveBeenCalledWith({
        languageCode: "en",
        setId: "base1",
      }),
    );
    expect(mockSetSearchParams).toHaveBeenCalled();
    expect(mockRevalidate).toHaveBeenCalled();
  });
});

function integrationOptionsResult(queryKind: string) {
  if (queryKind === "languages") {
    return {
      data: {
        items: [
          {
            providerKey: "tcgdex",
            queryKind: "languages",
            value: "en",
            label: "en",
            description: null,
            parentValue: null,
            imageUrl: null,
            metadata: { languageCode: "en" },
          },
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
  }

  if (queryKind === "series") {
    return {
      data: {
        items: [
          {
            providerKey: "tcgdex",
            queryKind: "series",
            value: "base",
            label: "Base",
            description: null,
            parentValue: "en",
            imageUrl: null,
            metadata: { seriesId: "base" },
          },
        ],
        total: 1,
        count: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
  }

  return {
    data: {
      items: [
        {
          providerKey: "tcgdex",
          queryKind: "expansions",
          value: "base1",
          label: "Base Set",
          description: "Base - 102 official cards",
          parentValue: "base",
          imageUrl: null,
          metadata: { expansionId: "base1" },
        },
      ],
      total: 1,
      count: 1,
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
  };
}

function integrationScope(): SourceObservationIntegrationScope {
  return {
    provider_key: "tcgdex",
    language_code: "en",
    expansion_id: "base1",
    expansion_name: "Base Set",
    series_id: "base",
    series_name: "Base",
    total_observations: 102,
    observed_observations: 100,
    promoted_observations: 2,
    rejected_observations: 0,
    first_observed_at: "2026-05-16T00:00:00.000Z",
    latest_observed_at: "2026-05-16T00:01:00.000Z",
    latest_source_updated_at: null,
  };
}
