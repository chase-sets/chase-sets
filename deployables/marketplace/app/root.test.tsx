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

describe("marketplace root layout", () => {
  beforeEach(() => {
    mockUseLocation.mockReturnValue({
      pathname: "/search",
      search: "?search=charizard",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to a safe origin when loader data is unavailable", () => {
    mockUseLoaderData.mockReturnValue(undefined);

    const html = renderToString(
      <Layout>
        <main>Marketplace Search</main>
      </Layout>,
    );

    expect(html).toContain(
      `href="${window.location.origin}/search?search=charizard"`,
    );
    expect(html).toContain("Marketplace Search");
  });

  it("uses the loader origin when it is available", () => {
    mockUseLoaderData.mockReturnValue({
      actor: null,
      origin: "https://marketplace.example",
    });

    const html = renderToString(
      <Layout>
        <main>Marketplace Search</main>
      </Layout>,
    );

    expect(html).toContain(
      'href="https://marketplace.example/search?search=charizard"',
    );
  });
});
