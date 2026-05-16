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
    vi.unstubAllEnvs();
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
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="icon" href="/favicon.svg"');
    expect(html).toContain('rel="alternate icon" href="/favicon.ico"');
    expect(html).toContain("Marketplace Search");
  });

  it("uses the loader origin when it is available", () => {
    mockUseLoaderData.mockReturnValue({
      actor: null,
      origin: "https://marketplace.example",
      shouldIndex: true,
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

  it("can noindex staging through environment configuration", () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_INDEXING", "false");
    mockUseLoaderData.mockReturnValue({
      actor: null,
      origin: "https://marketplace.staging.chasesets.com",
      shouldIndex: false,
    });

    const html = renderToString(
      <Layout>
        <main>Marketplace Search</main>
      </Layout>,
    );

    expect(html).toContain('name="robots" content="noindex,nofollow"');
  });
});
