import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockUseLoaderData,
  mockUseNavigation,
  mockUseSearchParams,
} = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseNavigation: vi.fn(),
  mockUseSearchParams: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
    useNavigation: mockUseNavigation,
    useSearchParams: mockUseSearchParams,
  };
});

import SearchRoute from "@chase-sets/discovery/routes/search";

describe("marketplace search route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to an empty search state when loader data is unavailable", () => {
    mockUseLoaderData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);

    const html = renderToString(<SearchRoute />);

    expect(html).toContain("Search catalog items...");
  });
});
