import type React from "react";
import { render as renderWithoutRouter, screen, waitFor, within, type RenderOptions } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardProps } from "@chase-sets/design-system";

const { mockUseLoaderData, mockUseLocation, futureCardElevationDefault } = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseLocation: vi.fn(),
  // Baseline `undefined` preserves the real Card's current omitted-elevation
  // behavior; tests flip this to prove the hub still pins an explicit elevation.
  futureCardElevationDefault: { current: undefined as CardProps["elevation"] | undefined },
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

vi.mock("@chase-sets/design-system", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/design-system")>("@chase-sets/design-system");

  function FutureDefaultCard({ elevation, ...props }: React.ComponentProps<typeof actual.Card>) {
    return <actual.Card {...props} elevation={elevation ?? futureCardElevationDefault.current} />;
  }

  return {
    ...actual,
    Card: Object.assign(FutureDefaultCard, {
      Header: actual.Card.Header,
      Title: actual.Card.Title,
      Description: actual.Card.Description,
      Body: actual.Card.Body,
      Footer: actual.Card.Footer,
    }),
  };
});

import { MemoryRouter } from "react-router";
import AccessLayout from "./routes/access-layout";
import CatalogLayout from "./routes/catalog-layout";
import CommerceLayout from "./routes/commerce-layout";
import GrowthLayout from "./routes/growth-layout";
import AdminIndex from "./routes/index";
import OfflineRoute from "./routes/offline";
import PlatformLayout from "./routes/platform-layout";
import SupportLayout from "./routes/support-layout";
import * as adminHost from "./host";

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
    "projection-operations.view",
    "public-presence.view",
    "security.manage",
    "support.manage",
  ],
};

// The admin shells register the DS RouterLinkAdapter, so rendering them requires
// router context — exactly as they have in the production app tree.
function ssr(ui: React.ReactElement) {
  return renderToString(<MemoryRouter>{ui}</MemoryRouter>);
}

type AdminHubSection = Readonly<{
  key: string;
  label: string;
  href: string;
}>;

function hubCardMarkup(html: string, section: AdminHubSection) {
  const labelIndex = html.indexOf(`>${section.label}</h4>`);
  expect(labelIndex).toBeGreaterThanOrEqual(0);

  const cardStart = html.lastIndexOf('<div class="ds-glass', labelIndex);
  expect(cardStart).toBeGreaterThanOrEqual(0);

  const linkStart = html.indexOf(`href="${section.href}"`, labelIndex);
  expect(linkStart).toBeGreaterThan(labelIndex);

  const linkEnd = html.indexOf("</a>", linkStart);
  expect(linkEnd).toBeGreaterThan(linkStart);

  return html.slice(cardStart, linkEnd + "</a>".length);
}

function hubGridMarkup(html: string, firstSection: AdminHubSection) {
  const firstCard = hubCardMarkup(html, firstSection);
  const firstCardStart = html.indexOf(firstCard);
  const gridClasses = html.lastIndexOf("grid-cols-1", firstCardStart);
  expect(gridClasses).toBeGreaterThanOrEqual(0);

  return html.slice(html.lastIndexOf("<div ", gridClasses), firstCardStart);
}

function render(ui: React.ReactNode, options?: RenderOptions) {
  return renderWithoutRouter(ui, { wrapper: MemoryRouter, ...options });
}

function renderAdminRoute(Component: () => React.ReactElement, pathname: string) {
  mockUseLoaderData.mockReturnValue({ actor: allSectionsActor });
  mockUseLocation.mockReturnValue({ pathname });

  return ssr(<Component />);
}

// Attribute order on rendered anchors is an implementation detail of the registered
// link component (raw `<a>` vs the DS RouterLinkAdapter), so assert the active link
// semantically: some single anchor tag carries both the href and aria-current="page".
function expectActiveLink(html: string, href: string) {
  const anchors = html.match(/<a [^>]*>/g) ?? [];

  expect(anchors.some((anchor) => anchor.includes(`href="${href}"`) && anchor.includes('aria-current="page"'))).toBe(
    true,
  );
}

function occurrenceCount(source: string, value: string) {
  return source.split(value).length - 1;
}

function mobileBottomNavMarkup(html: string) {
  const start = html.indexOf('class="fixed inset-x-0 bottom-0');
  expect(start).not.toBe(-1);

  const end = html.indexOf("</nav>", start);
  expect(end).not.toBe(-1);

  return html.slice(start, end);
}

describe("admin web section layouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
      pathname: "/platform/projections",
      activeHref: "/platform/projections",
      localNavLabel: "Projection Operations",
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
      expectActiveLink(html, activeHref);
      expect(html).toContain(localNavLabel);
      expect(html).toContain('aria-label="Account menu"');
      expect(html).toContain('action="/access/sign-out"');
      expect(html).not.toContain("Verified");
    },
  );

  it("keeps Reference Data active for Catalog reference type routes", () => {
    const html = renderAdminRoute(CatalogLayout, "/catalog/reference-types");

    expectActiveLink(html, "/catalog/reference-records");
    expect(html).toContain("Reference Data");
  });

  it("renders the support section navigation for a reported-content operator", () => {
    // Literal role fixtures exercise rendering; production grants are proven in Auth/Identity.
    const operator = { ...allSectionsActor, permissions: [...allSectionsActor.permissions, "reported-content.view"] };
    const operatorHrefs = ["/support/reported-content", "/support/risk-alerts"];
    mockUseLoaderData.mockReturnValue({ actor: operator });
    mockUseLocation.mockReturnValue({ pathname: "/support/reported-content" });
    const html = ssr(<SupportLayout />);
    const markup = document.createElement("div");
    markup.innerHTML = html;
    for (const href of operatorHrefs) {
      expect(markup.querySelector(`a[href="${href}"]`)).not.toBeNull();
    }
    expect(markup.querySelector('a[href="/support/reported-content"] svg.lucide-flag')).not.toBeNull();

    for (const roleKey of ["owner", "manager", "fulfillment", "viewer"]) {
      const permissions = roleKey === "viewer" ? ["support.view"] : ["support.view", "support.manage"];
      mockUseLoaderData.mockReturnValue({ actor: { ...allSectionsActor, roleKey, permissions } });
      const ordinaryHtml = ssr(<SupportLayout />);
      for (const href of operatorHrefs) {
        expect(ordinaryHtml, roleKey).not.toContain(`href="${href}"`);
      }
    }

    // Keep the resolved item and actor intact; only this synthetic icon name varies.
    mockUseLoaderData.mockReturnValue({ actor: operator });
    const resolveNavItems = adminHost.resolveAdminWebNavItems;
    const syntheticIcon = vi
      .spyOn(adminHost, "resolveAdminWebNavItems")
      .mockImplementation((actor, options) =>
        resolveNavItems(actor, options).map((item) =>
          item.href === "/support/reported-content"
            ? { ...item, icon: "__unmapped_icon_probe__" as typeof item.icon }
            : item,
        ),
      );
    try {
      expect(() => ssr(<SupportLayout />)).toThrow("Element type is invalid");
    } finally {
      syntheticIcon.mockRestore();
    }
  });

  it("applies the shell viewer color mode preference", () => {
    mockUseLoaderData.mockReturnValue({
      actor: allSectionsActor,
      viewer: {
        actor: allSectionsActor,
        preferences: { colorMode: "dark", reducedMotion: "user" },
      },
    });
    mockUseLocation.mockReturnValue({ pathname: "/catalog/dimensions" });

    const html = ssr(<CatalogLayout />);

    expect(html).toContain('data-color-mode="dark"');
  });

  it("persists account menu color mode changes through Identity preferences", async () => {
    const user = userEvent.setup({ document });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
      if (url.pathname === "/api/identity/preferences") {
        expect(init?.method ?? request?.method).toBe("PUT");
        expect(JSON.parse(String(init?.body ?? (request ? await request.clone().text() : "")))).toEqual({
          colorMode: "light",
        });
        return Response.json({
          preferences: {
            colorMode: "light",
          },
        });
      }

      return Response.json({});
    });
    vi.stubGlobal("fetch", fetch);
    mockUseLoaderData.mockReturnValue({
      actor: allSectionsActor,
      viewer: {
        actor: allSectionsActor,
        preferences: { colorMode: "dark", reducedMotion: "user" },
      },
    });
    mockUseLocation.mockReturnValue({ pathname: "/catalog/dimensions" });

    render(<CatalogLayout />);

    await user.click(screen.getAllByRole("button", { name: "Account menu" })[0]);
    const accountMenu = await screen.findByRole("menu", { name: "Account menu" });

    expect((within(accountMenu).getByRole("radio", { name: "Dark" }) as HTMLInputElement).checked).toBe(true);
    await user.click(within(accountMenu).getByRole("radio", { name: "Light" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(document.querySelector('[data-color-mode="light"]')).toBeTruthy();
  });

  it.each([
    [AccessLayout, "/access/accounts", "Accounts"],
    [CatalogLayout, "/catalog/dimensions", "Dimensions"],
    [CommerceLayout, "/commerce/postage-policies", "Postage Policies"],
    [GrowthLayout, "/growth/google-shopping", "Google Shopping"],
    [SupportLayout, "/support/requests", "Support"],
    [PlatformLayout, "/platform/projections", "Projection Operations"],
  ] as const)(
    "wires mobile section switching, local nav, active state, and account actions for %s",
    (Component, pathname, localNavLabel) => {
      const html = renderAdminRoute(Component, pathname);
      const bottomNav = mobileBottomNavMarkup(html);

      expect(html).toContain('aria-label="Admin menu"');
      for (const href of ["/access", "/catalog", "/commerce", "/growth", "/support", "/platform"]) {
        expect(occurrenceCount(html, `href="${href}"`)).toBeGreaterThanOrEqual(2);
      }
      expect(occurrenceCount(html, 'action="/access/sign-out"')).toBeGreaterThanOrEqual(2);
      expect(bottomNav).toContain(localNavLabel);
      expect(bottomNav).toContain("bg-surface-2 text-accent");
    },
  );

  it("keeps Catalog mobile local navigation compact with active overflow access", () => {
    const html = renderAdminRoute(CatalogLayout, "/catalog/reference-types");
    const bottomNav = mobileBottomNavMarkup(html);

    expect(bottomNav).toContain("grid-cols-4");
    expect(bottomNav).toContain("Reference Data");
    expect(bottomNav).toContain("More");
    expect(bottomNav).toContain("Catalog Items");
    expect(bottomNav).toContain('href="/catalog/reference-records"');
    expect(bottomNav).toContain("bg-surface-2 text-accent");
  });
});

describe("admin web root hub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all actor-visible sections", () => {
    const sections = [
      { key: "access", label: "Access", href: "/access" },
      { key: "catalog", label: "Catalog", href: "/catalog" },
      { key: "commerce", label: "Commerce", href: "/commerce" },
      { key: "growth", label: "Growth", href: "/growth" },
      { key: "support", label: "Support", href: "/support" },
      { key: "platform", label: "Platform", href: "/platform" },
    ] as const;
    mockUseLoaderData.mockReturnValue({
      actor: allSectionsActor,
      sections,
    });

    const html = ssr(<AdminIndex />);
    const hubCards = sections.map((section) => hubCardMarkup(html, section));
    const grid = hubGridMarkup(html, sections[0]);

    expect(html).toContain("Admin sections");
    expect(html).toContain('aria-label="Account menu"');
    expect(hubCards).toHaveLength(sections.length);
    expect(grid).toContain("grid-cols-1");
    expect(grid).toContain("md:grid-cols-2");
    expect(grid).toContain("xl:grid-cols-3");
    expect(grid).toContain("gap-4");
    const labelPositions = sections.map((section) => html.indexOf(`>${section.label}</h4>`));
    expect(labelPositions.every((position) => position >= 0)).toBe(true);
    expect(labelPositions).toEqual([...labelPositions].sort((left, right) => left - right));

    for (const [index, section] of sections.entries()) {
      const card = hubCards[index];

      expect(card).toContain(`>${section.label}</h4>`);
      expect(card).toContain(`href="${section.href}"`);
      expect(card).toContain("ds-glass");
      expect(card).toContain("border border-muted");
      expect(card).toContain("shadow-tokenSm");
      expect(card).toContain("cursor-pointer transition");
      expect(card).toContain('tabindex="0"');
      expect(card).toContain(">Open</span>");
    }
  });

  it("keeps hub Cards elevated when an omitted elevation defaults to outlined", () => {
    mockUseLoaderData.mockReturnValue({
      actor: allSectionsActor,
      sections: [{ key: "catalog", label: "Catalog", href: "/catalog" }],
    });

    futureCardElevationDefault.current = "outlined";
    try {
      const html = ssr(<AdminIndex />);
      const card = hubCardMarkup(html, { key: "catalog", label: "Catalog", href: "/catalog" });

      expect(card).toContain("ds-glass");
      expect(card).toContain("border border-muted");
      expect(card).toContain("shadow-tokenSm");
    } finally {
      futureCardElevationDefault.current = undefined;
    }
  });

  it("renders a no-access state when no sections are visible", () => {
    mockUseLoaderData.mockReturnValue({ actor: allSectionsActor, sections: [] });

    const html = ssr(<AdminIndex />);

    expect(html).toContain("Admin");
    expect(html).toContain('aria-label="Account menu"');
    expect(html).toContain("No admin sections available");
    expect(html).toContain("does not have permission to view any admin sections");
  });

  it("applies the shell viewer color mode preference to the root hub", () => {
    mockUseLoaderData.mockReturnValue({
      actor: allSectionsActor,
      sections: [{ key: "catalog", label: "Catalog", href: "/catalog" }],
      viewer: {
        actor: allSectionsActor,
        preferences: { colorMode: "dark", reducedMotion: "user" },
      },
    });

    const html = ssr(<AdminIndex />);

    expect(html).toContain('data-color-mode="dark"');
  });

  it("applies the shell viewer reduced-motion preference", () => {
    mockUseLoaderData.mockReturnValue({
      actor: allSectionsActor,
      viewer: {
        actor: allSectionsActor,
        preferences: { colorMode: "dark", reducedMotion: "always" },
      },
    });
    mockUseLocation.mockReturnValue({ pathname: "/catalog/dimensions" });

    const html = ssr(<CatalogLayout />);

    expect(html).toContain('data-color-mode="dark"');
    expect(html).toContain('data-reduced-motion="true"');
  });

  it("renders the offline fallback inside the admin shell", () => {
    const html = ssr(<OfflineRoute />);

    expect(html).toContain("Admin");
    expect(html).toContain("Admin is offline");
    expect(html).toContain('id="main-content"');
  });
});
