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

describe("public-web root layout", () => {
  beforeEach(() => {
    mockUseLocation.mockReturnValue({ pathname: "/", search: "" });
    mockUseLoaderData.mockReturnValue({ origin: "https://chasesets.com", shouldIndex: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sets a theme-color meta tag matching the dark surface background", () => {
    const html = renderToString(
      <Layout>
        <main>Home</main>
      </Layout>,
    );

    expect(html).toContain('name="theme-color" content="#020617"');
  });
});
