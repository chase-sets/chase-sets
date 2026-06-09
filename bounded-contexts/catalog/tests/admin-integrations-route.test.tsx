// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import IntegrationsRoute from "../routes/admin/integrations";
import { buildCatalogPrimaryWorkbenchReadModel } from "../features/source-observations/ui/primary-workbench-read-model";
import {
  profileReview,
  sourceObservationScope,
} from "../features/source-observations/ui/primary-workbench-test-fixtures";

const { mockUseLoaderData, mockUseRouteLoaderData } = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseRouteLoaderData: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
    useRouteLoaderData: mockUseRouteLoaderData,
  };
});

describe("Catalog integrations route", () => {
  it("renders the rebuilt primary workbench as the default integrations experience", () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const requestUrl = "https://admin.example/catalog/integrations?providerKey=tcgdex";
    mockUseLoaderData.mockReturnValue({
      data: scopes,
      query: {},
      profileReviews,
      controlPlaneOverview: null,
      requestUrl,
      readModel: buildCatalogPrimaryWorkbenchReadModel({
        requestUrl,
        scopes,
        profileReviews,
        controlPlaneOverview: null,
        canManageCatalog: true,
      }),
    });
    mockUseRouteLoaderData.mockReturnValue({
      actor: { permissions: ["catalog.view", "catalog.manage"] },
    });

    render(<IntegrationsRoute />);

    expect(
      screen.getByRole("heading", {
        name: "Pull provider data, review Source Observations, promote Catalog facts",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Integration Management")).toBeNull();
    expect(screen.queryByText("Old integrations surface")).toBeNull();
  });
});
