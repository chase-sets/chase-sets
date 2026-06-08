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

import AccessLayout from "./routes/access-layout";
import CatalogLayout from "./routes/catalog-layout";
import CommerceLayout from "./routes/commerce-layout";
import GrowthLayout from "./routes/growth-layout";
import AdminIndex from "./routes/index";
import PlatformLayout from "./routes/platform-layout";
import SupportLayout from "./routes/support-layout";

const allSectionsActor = {
  permissions: [
    "accounts.view",
    "catalog.view",
    "commercial-terms.view",
    "google-shopping.view",
    "platform-feedback.view",
    "postage-policies.view",
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
      Component: AccessLayout,
      name: "Access",
      pathname: "/access/accounts",
      activeHref: "/access/accounts",
      localNavLabel: "Accounts",
    },
    {
      Component: CatalogLayout,
      name: "Catalog",
      pathname: "/catalog/dimensions",
      activeHref: "/catalog/dimensions",
      localNavLabel: "Dimensions",
    },
    {
      Component: CommerceLayout,
      name: "Commerce",
      pathname: "/commerce/postage-policies",
      activeHref: "/commerce/postage-policies",
      localNavLabel: "Postage Policies",
    },
    {
      Component: GrowthLayout,
      name: "Growth",
      pathname: "/growth/google-shopping",
      activeHref: "/growth/google-shopping",
      localNavLabel: "Google Shopping",
    },
    {
      Component: SupportLayout,
      name: "Support",
      pathname: "/support/requests",
      activeHref: "/support/requests",
      localNavLabel: "Support",
    },
    {
      Component: PlatformLayout,
      name: "Platform",
      pathname: "/platform/release-dashboard",
      activeHref: "/platform/release-dashboard",
      localNavLabel: "Release Dashboard",
    },
  ])(
    "renders $name with top-level and section-local navigation",
    ({ Component, pathname, activeHref, localNavLabel }) => {
      const html = renderAdminRoute(Component, pathname);

      expect(html).toContain("Nested admin route");
      expect(html).toContain("Access");
      expect(html).toContain("Catalog");
      expect(html).toContain("Commerce");
      expect(html).toContain("Growth");
      expect(html).toContain("Support");
      expect(html).toContain("Platform");
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
        { key: "access", label: "Access", href: "/access/accounts" },
        { key: "catalog", label: "Catalog", href: "/catalog/dimensions" },
        { key: "commerce", label: "Commerce", href: "/commerce/terms/schedules" },
        { key: "growth", label: "Growth", href: "/growth/google-shopping" },
        { key: "support", label: "Support", href: "/support/requests" },
        { key: "platform", label: "Platform", href: "/platform/projections" },
      ],
    });

    const html = renderToString(<AdminIndex />);

    expect(html).toContain("Admin sections");
    expect(html).toContain("/access/accounts");
    expect(html).toContain("/commerce/terms/schedules");
    expect(html).toContain("/growth/google-shopping");
    expect(html).toContain("/support/requests");
    expect(html).toContain("/platform/projections");
  });

  it("renders a no-access state when no sections are visible", () => {
    mockUseLoaderData.mockReturnValue({ sections: [] });

    const html = renderToString(<AdminIndex />);

    expect(html).toContain("No admin sections available");
    expect(html).toContain("does not have permission to view any admin sections");
  });
});
