import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLoaderData } from "react-router";
import GoogleShoppingOperationsRoute, { action, loader } from "./google-shopping";

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  Form: ({ children }: { children?: ReactNode }) => createElement("form", null, children),
  useLoaderData: vi.fn(),
  useActionData: () => null,
  useMatches: () => [],
  useSearchParams: () => [new URLSearchParams()],
  useRevalidator: () => ({ revalidate: vi.fn() }),
}));

describe("Google Shopping operations route", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps an unavailable-data zero summary visibly distinct from success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: "Feed data is unavailable." },
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const result = await loader({
      request: new Request("https://admin.chasesets.test/growth/google-shopping"),
      params: {},
      context: undefined,
    } as never);
    expect(result.data.summary).toEqual({
      totalRows: 0,
      eligibleRows: 0,
      excludedRows: 0,
      attentionRows: 0,
      failedRows: 0,
      disapprovedRows: 0,
      pendingDeleteRows: 0,
      staleRows: 0,
      nearingRefreshRows: 0,
      pendingDiagnosticsRows: 0,
    });
    expect(result.data.rows).toEqual([]);
    expect(result.unavailableMessage).toBe("Feed data is unavailable.");
    vi.mocked(useLoaderData).mockReturnValue(result);
    const markup = renderToString(createElement(GoogleShoppingOperationsRoute));
    expect(markup).toContain("Feed data is unavailable.");
    expect(markup).toContain("google-shopping-notice-surface");
    expect(markup).toContain("0 row(s) need attention");
  });

  it("returns an explicit launch gate error for live production intents", async () => {
    const result = await action({
      request: new Request("https://admin.chasesets.test/growth/google-shopping", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ intent: "live-full-sync" }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      error: "Live Google Shopping writes remain gated by launch-readiness issue #3032.",
    });
  });
});
