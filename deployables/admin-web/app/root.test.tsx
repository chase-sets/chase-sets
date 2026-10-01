import { renderToString } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseLoaderData, mockUseLocation, mockUseMatches, mockUseRouteError } = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseLocation: vi.fn(),
  mockUseMatches: vi.fn(),
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
    useMatches: mockUseMatches,
    useRouteError: mockUseRouteError,
  };
});

import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { ErrorBoundary, Layout } from "./root";

describe("admin root layout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T22:40:16Z"));
    mockUseMatches.mockReturnValue([{ id: "root" }, { id: "catalog/catalog/integrations" }]);
    mockUseLocation.mockReturnValue({
      pathname: "/catalog/catalog-items",
      search: "?status=draft",
      hash: "",
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.resetAllMocks();
    vi.restoreAllMocks();
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
    expect(html.match(/name="theme-color"/g)).toHaveLength(1);
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

  it("preserves a static route identity, UTC timestamp, and runtime category without URL values", () => {
    mockUseLocation.mockReturnValue({
      pathname: "/catalog/integrations/private-path-value",
      search: "?authorization=Bearer%20private-query-value&payload=private-provider-payload",
      hash: "#private-fragment-value",
    });
    mockUseRouteError.mockReturnValue(new TypeError("Cannot read properties of undefined"));

    const html = renderToString(
      <MemoryRouter>
        <ErrorBoundary />
      </MemoryRouter>,
    );
    const detail = new DOMParser().parseFromString(html, "text/html").querySelector("details")?.textContent;

    expect(detail).toContain('"route":"catalog/catalog/integrations"');
    expect(detail).toContain('"observedAt":"2026-09-30T22:40:16.000Z"');
    expect(detail).toContain('"category":"runtime-type-error"');
    expect(detail).not.toContain("private-path-value");
    expect(detail).not.toContain("private-query-value");
    expect(detail).not.toContain("private-provider-payload");
    expect(detail).not.toContain("private-fragment-value");
  });

  it.each([
    [new ReferenceError("missing dependency"), "runtime-reference-error"],
    [new SyntaxError("invalid syntax"), "runtime-syntax-error"],
    [new RangeError("out of range"), "runtime-range-error"],
    [new Error("boom"), "runtime-error"],
    [{ message: "private-provider-payload", name: "private-error-name" }, "unknown-error"],
    [null, "unknown-error"],
  ])("uses a closed category for %s", (error, category) => {
    mockUseRouteError.mockReturnValue(error);
    mockUseMatches.mockReturnValue([]);

    const html = renderToString(
      <MemoryRouter>
        <ErrorBoundary />
      </MemoryRouter>,
    );
    const detail = new DOMParser().parseFromString(html, "text/html").querySelector("details")?.textContent;

    expect(detail).toContain(`"category":"${category}"`);
    expect(detail).toContain('"route":"unmatched"');
    expect(detail).not.toContain("private-provider-payload");
    expect(detail).not.toContain("private-error-name");
  });

  it.each(["private-provider-payload", { payload: "private-provider-payload", accessToken: "private-token" }])(
    "preserves response status without rendering response data: %s",
    (data) => {
      mockUseRouteError.mockReturnValue({ status: 503, statusText: "", internal: false, data });

      const html = renderToString(
        <MemoryRouter>
          <ErrorBoundary />
        </MemoryRouter>,
      );
      const detail = new DOMParser().parseFromString(html, "text/html").querySelector("details")?.textContent;

      expect(detail).toContain('"category":"route-response"');
      expect(detail).toContain('"status":503');
      expect(detail).not.toContain("private-provider-payload");
      expect(detail).not.toContain("private-token");
    },
  );

  it("does not serialize circular response data or lose the 404 recovery surface", () => {
    const data: { self?: unknown } = {};
    data.self = data;
    mockUseRouteError.mockReturnValue({ status: 404, statusText: "Not Found", internal: false, data });

    const html = renderToString(
      <MemoryRouter>
        <ErrorBoundary />
      </MemoryRouter>,
    );

    expect(html).toContain("Admin page not found");
    expect(html).toContain("Not Found");
    expect(html).toContain("Retry");
  });

  it.each(["loader", "render"])(
    "keeps the failed child route identity when a %s error reaches the root",
    async (stage) => {
      vi.useRealTimers();
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      mockUseMatches.mockImplementation(actual.useMatches);
      mockUseRouteError.mockImplementation(actual.useRouteError);
      mockUseLocation.mockImplementation(actual.useLocation);
      function fail(): never {
        throw new ReferenceError("synthetic missing dependency");
      }
      const router = createMemoryRouter(
        [
          {
            id: "root",
            path: "/",
            element: <actual.Outlet />,
            errorElement: <ErrorBoundary />,
            children: [
              {
                id: "catalog/catalog/integrations",
                path: "catalog/integrations/:scope",
                loader: stage === "loader" ? fail : undefined,
                Component: stage === "render" ? fail : () => <p>Loaded</p>,
              },
            ],
          },
        ],
        { initialEntries: ["/catalog/integrations/private-path-value?accessToken=private-query-value"] },
      );

      try {
        render(<RouterProvider router={router} />);
        await screen.findByRole("heading", { name: "Admin Error" });
        const detail = document.querySelector("details")?.textContent;

        expect(detail).toContain('"route":"catalog/catalog/integrations"');
        expect(detail).toContain('"category":"runtime-reference-error"');
        expect(detail).toMatch(/"observedAt":"\d{4}-\d{2}-\d{2}T[^"]+Z"/);
        expect(detail).not.toContain("private-path-value");
        expect(detail).not.toContain("private-query-value");
      } finally {
        router.dispose();
      }
    },
  );
});
