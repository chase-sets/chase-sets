// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import CustomerFeedbackAttentionRoute, { loader } from "../../../../routes/admin/attention";
import type { FeedbackAttentionResponse } from "../../api/attention-contract";

const payload: FeedbackAttentionResponse = {
  items: [],
  metrics: {
    activeCount: 0,
    overdueCount: 0,
    medianTimeToTriageMs: null,
    medianTimeToCloseMs: null,
    oldestOverdueMs: null,
    deliverySuccesses: 0,
    deliveryFailures: 0,
    digestPending: 0,
    digestFailures: 0,
    latestDigestAt: null,
  },
};

function stubFetch(response = Response.json(payload)) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function load(request: Request) {
  return loader({
    request,
    params: {},
    context: {},
    url: new URL(request.url),
    pattern: "/support/customer-feedback/attention",
  });
}

describe("public Customer Feedback attention loader", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("asks the API for the case a deep link names and returns it to the surface", async () => {
    const fetchMock = stubFetch();
    const data = await load(
      new Request("https://admin.test/support/customer-feedback/attention?caseId=fbcase_01JQZZ0000000000000000000B", {
        headers: { cookie: "chase_sets_session=synthetic" },
      }),
    );

    const [input, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.pathname).toBe("/api/customer-feedback/attention");
    expect(url.searchParams.get("caseId")).toBe("fbcase_01JQZZ0000000000000000000B");
    expect(init).toEqual({ headers: { cookie: "chase_sets_session=synthetic" } });
    expect(data).toEqual({ ...payload, caseId: "fbcase_01JQZZ0000000000000000000B" });
  });

  it("reads the full queue without a case", async () => {
    const fetchMock = stubFetch();
    const data = await load(new Request("https://admin.test/support/customer-feedback/attention"));

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(input)).searchParams.has("caseId")).toBe(false);
    expect(init).toEqual({ headers: { cookie: "" } });
    expect(data.caseId).toBeNull();
  });

  it.each([401, 403, 500])("propagates API status %i as the route error response", async (status) => {
    stubFetch(Response.json({ error: { code: "api_error" } }, { status }));
    const response = await load(new Request("https://admin.test/support/customer-feedback/attention")).catch(
      (error: unknown) => error,
    );
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("Expected a route error response");
    expect(response.status).toBe(status);
    await expect(response.text()).resolves.toBe("Unable to load customer feedback attention.");
  });

  it("renders loader data from the public route through React Router", async () => {
    stubFetch();
    const path = "/support/customer-feedback/attention";
    const router = createMemoryRouter(
      [{ path, loader, Component: CustomerFeedbackAttentionRoute, HydrateFallback: () => null }],
      { initialEntries: [`${path}?caseId=fbcase_01JQZZ0000000000000000000B`] },
    );
    try {
      render(<RouterProvider router={router} />);
      await screen.findByRole("heading", { name: "Customer feedback attention" });
      expect(screen.getByText("Case fbcase_01JQZZ0000000000000000000B has no active attention.")).toBeTruthy();
    } finally {
      router.dispose();
    }
  });
});
