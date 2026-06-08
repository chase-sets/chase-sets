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
import OfflineRoute from "./routes/offline";
import PlatformLayout from "./routes/platform-layout";
import SupportLayout from "./routes/support-layout";

const allSectionsActor = {
  sessionId: "session_admin",
  tenantId: "tenant_chase_sets",
  userId: "user_admin",
  accountId: "account_platform",
  membershipId: "membership_admin",
  roleKey: "platform-admin",
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
      expect(html).toContain('aria-label="Account menu"');
      expect(html).toContain('action="/access/sign-out"');
      expect(html).not.toContain("Verified");
    },
  );

  it("keeps Reference Data active for Catalog reference type routes", () => {
    const html = renderAdminRoute(CatalogLayout, "/catalog/reference-types");

    expect(html).toContain('href="/catalog/reference-records" aria-current="page"');
    expect(html).toContain("Reference Data");
  });
});

describe("admin web root hub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all actor-visible sections", () => {
    mockUseLoaderData.mockReturnValue({
      actor: allSectionsActor,
      sections: [
        { key: "access", label: "Access", href: "/access" },
        { key: "catalog", label: "Catalog", href: "/catalog" },
        { key: "commerce", label: "Commerce", href: "/commerce" },
        { key: "growth", label: "Growth", href: "/growth" },
        { key: "support", label: "Support", href: "/support" },
        { key: "platform", label: "Platform", href: "/platform" },
      ],
    });

    const html = renderToString(<AdminIndex />);

    expect(html).toContain("Admin sections");
    expect(html).toContain('aria-label="Account menu"');
    expect(html).toContain("/access");
    expect(html).toContain("/commerce");
    expect(html).toContain("/growth");
    expect(html).toContain("/support");
    expect(html).toContain("/platform");
  });

  it("renders a no-access state when no sections are visible", () => {
    mockUseLoaderData.mockReturnValue({ actor: allSectionsActor, sections: [] });

    const html = renderToString(<AdminIndex />);

    expect(html).toContain("Admin");
    expect(html).toContain('aria-label="Account menu"');
    expect(html).toContain("No admin sections available");
    expect(html).toContain("does not have permission to view any admin sections");
  });

  it("renders the offline fallback inside the admin shell", () => {
    const html = renderToString(<OfflineRoute />);

    expect(html).toContain("Admin");
    expect(html).toContain("Admin is offline");
    expect(html).toContain('id="main-content"');
  });
});
