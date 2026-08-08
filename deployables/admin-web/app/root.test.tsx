import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseLoaderData, mockUseLocation, mockUseRouteError } = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseLocation: vi.fn(),
  mockUseRouteError: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    Links: () => null,
    Meta: () => null,
    Outlet: () => null,
    Scripts: () => null,
    ScrollRestoration: () => null,
    useLoaderData: mockUseLoaderData,
    useLocation: mockUseLocation,
    useRouteError: mockUseRouteError,
  };
});

import { MemoryRouter } from "react-router";
import { ErrorBoundary, Layout } from "./root";

describe("admin root layout", () => {
  beforeEach(() => {
    mockUseLocation.mockReturnValue({
      pathname: "/catalog/catalog-items",
      search: "?status=draft",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("links install metadata and falls back to a safe origin", () => {
    mockUseLoaderData.mockReturnValue(undefined);

    const html = renderToString(
      <Layout>
        <main>Catalog Items</main>
      </Layout>,
    );

    expect(html).toContain(`href="${window.location.origin}/catalog/catalog-items?status=draft"`);
    expect(html).toContain('name="theme-color" content="#0f766e"');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="icon" href="/favicon.svg"');
    expect(html).toContain('rel="alternate icon" href="/favicon.ico"');
    expect(html).toContain("Catalog Items");
  });

  it("uses the loader origin when it is available", () => {
    mockUseLoaderData.mockReturnValue({
      origin: "https://admin.example",
    });

    const html = renderToString(
      <Layout>
        <main>Catalog Items</main>
      </Layout>,
    );

    expect(html).toContain('href="https://admin.example/catalog/catalog-items?status=draft"');
  });

  it("renders root errors inside the admin shell without a Catalog-specific recovery action", () => {
    mockUseRouteError.mockReturnValue(new Error("boom"));

    // AdminRootShell registers the DS RouterLinkAdapter, so rendering it requires
    // router context — exactly as it has in the production app tree.
    const html = renderToString(
      <MemoryRouter>
        <ErrorBoundary />
      </MemoryRouter>,
    );

    expect(html).toContain("Admin");
    expect(html).toContain("Admin Error");
    expect(html).toContain('href="/"');
    expect(html).toContain("Go to admin home");
    expect(html).not.toContain("Go to Catalog");
    expect(html).not.toContain('href="/catalog"');
  });

  it("redacts raw ids, emails, and tokens out of the rendered technical detail", () => {
    mockUseRouteError.mockReturnValue(
      new Error("membership_01H8ZZZZZZZZZZZZZZZZZZZZZZ update failed for operator@example.com"),
    );

    const html = renderToString(
      <MemoryRouter>
        <ErrorBoundary />
      </MemoryRouter>,
    );

    expect(html).toContain("[redacted-id]");
    expect(html).toContain("[redacted-email]");
    expect(html).not.toContain("membership_01H8ZZZZZZZZZZZZZZZZZZZZZZ");
    expect(html).not.toContain("operator@example.com");
  });
});
