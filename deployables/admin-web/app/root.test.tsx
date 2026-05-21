import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseLoaderData, mockUseLocation } = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseLocation: vi.fn(),
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
  };
});

import { Layout } from "./root";

describe("admin root layout", () => {
  beforeEach(() => {
    mockUseLocation.mockReturnValue({
      pathname: "/catalog-items",
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

    expect(html).toContain(`href="${window.location.origin}/catalog-items?status=draft"`);
    expect(html).toContain('name="theme-color" content="#1f6f68"');
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

    expect(html).toContain('href="https://admin.example/catalog-items?status=draft"');
  });
});
