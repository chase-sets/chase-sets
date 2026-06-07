import type React from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseLoaderData, mockUseLocation } = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseLocation: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    Outlet: () => <main>Nested admin route</main>,
    useLoaderData: mockUseLoaderData,
    useLocation: mockUseLocation,
  };
});

import CatalogLayout from "./routes/catalog-layout";
import CommercialLayout from "./routes/commercial-layout";
import ExperienceLayout from "./routes/experience-layout";
import IdentityLayout from "./routes/identity-layout";
import AdminIndex from "./routes/index";
import OperationsLayout from "./routes/operations-layout";

const allSectionsActor = {
  permissions: [
    "catalog.view",
    "commercial-terms.view",
    "platform-feedback.view",
    "public-presence.view",
    "security.manage",
    "support.manage",
  ],
};

function renderAdminRoute(Component: () => React.ReactElement, pathname: string) {
  mockUseLoaderData.mockReturnValue({ actor: allSectionsActor });
  mockUseLocation.mockReturnValue({ pathname });

  return renderToString(<Component />);
}

describe("admin web section layouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      Component: CatalogLayout,
      name: "Catalog",
      pathname: "/catalog/dimensions",
      activeHref: "/catalog/dimensions",
      localNavLabel: "Dimensions",
    },
    {
      Component: IdentityLayout,
      name: "Identity",
      pathname: "/identity/accounts",
      activeHref: "/identity/accounts",
      localNavLabel: "Accounts",
    },
    {
      Component: ExperienceLayout,
      name: "Experience",
      pathname: "/experience/platform-feedback",
      activeHref: "/experience/platform-feedback",
      localNavLabel: "Platform Feedback",
    },
    {
      Component: OperationsLayout,
      name: "Operations",
      pathname: "/operations/support-requests",
      activeHref: "/operations/projections",
      localNavLabel: "Support",
    },
    {
      Component: CommercialLayout,
      name: "Commercial Terms",
      pathname: "/commercial/terms/schedules",
      activeHref: "/commercial/terms/schedules",
      localNavLabel: "Commercial Terms",
    },
  ])(
    "renders $name with top-level and section-local navigation",
    ({ Component, pathname, activeHref, localNavLabel }) => {
      const html = renderAdminRoute(Component, pathname);

      expect(html).toContain("Nested admin route");
      expect(html).toContain("Catalog");
      expect(html).toContain("Identity");
      expect(html).toContain("Experience");
      expect(html).toContain("Operations");
      expect(html).toContain("Commercial Terms");
      expect(html).toContain(`href="${activeHref}" aria-current="page"`);
      expect(html).toContain(localNavLabel);
      expect(html).toMatch(/Sign [Oo]ut/);
    },
  );
});

describe("admin web root hub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all actor-visible sections", () => {
    mockUseLoaderData.mockReturnValue({
      sections: [
        { key: "catalog", label: "Catalog", href: "/catalog/dimensions" },
        { key: "operations", label: "Operations", href: "/operations/support-requests" },
        { key: "commercial", label: "Commercial Terms", href: "/commercial/terms/schedules" },
      ],
    });

    const html = renderToString(<AdminIndex />);

    expect(html).toContain("Admin sections");
    expect(html).toContain("Catalog");
    expect(html).toContain("/catalog/dimensions");
    expect(html).toContain("Operations");
    expect(html).toContain("/operations/support-requests");
    expect(html).toContain("Commercial Terms");
    expect(html).toContain("/commercial/terms/schedules");
  });

  it("renders a no-access state when no sections are visible", () => {
    mockUseLoaderData.mockReturnValue({ sections: [] });

    const html = renderToString(<AdminIndex />);

    expect(html).toContain("No admin sections available");
    expect(html).toContain("does not have permission to view any admin sections");
  });
});
