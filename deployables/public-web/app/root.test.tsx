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

import { ErrorBoundary, Layout, waitlistAnalyticsBridgeScript } from "./root";
import { waitlistAnalyticsEventNames } from "@chase-sets/public-presence/web";

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

    expect(html).toContain('name="theme-color" content="#0e0c15"');
    expect(html.match(/name="theme-color"/g)).toHaveLength(1);
  });

  it("public-web root bridge emits unchanged payloads", () => {
    let listener = (_event: Event) => {};
    const fetch = vi.fn().mockResolvedValue(undefined);
    new Function("window", "navigator", "fetch", "Blob", "CustomEvent", waitlistAnalyticsBridgeScript)(
      {addEventListener: (name: string, handler: typeof listener) => {expect(name).toBe("chase-sets:waitlist-analytics"); listener = handler;}}, {}, fetch, Blob, CustomEvent,
    );
    const fields = {section: "hero", target: "join", field: "role", role: "seller", interest: "cards", variant: "control", status: "shown", page_path: "/welcome?source=launch", utm_source: "Launch +1%", utm_medium: "Social Media", utm_campaign: "campaign.1", checked: false};
    for (const event of waitlistAnalyticsEventNames) {
      listener(new CustomEvent("fixture", {detail: {event, ...fields, email: "private@example.test"}}));
      expect(fetch.mock.lastCall).toEqual(["/api/public-presence/analytics/waitlist", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({event, ...fields}), credentials: "same-origin", keepalive: true}]);
    }
    const count = fetch.mock.calls.length;
    for (const detail of [null, {}, {event: "unknown"}]) listener(new CustomEvent("fixture", {detail}));
    listener(new Event("fixture"));
    expect(fetch).toHaveBeenCalledTimes(count);
    listener(new CustomEvent("fixture", {detail: {event: waitlistAnalyticsEventNames[0], section: "a".repeat(81), page_path: "relative", utm_source: "a".repeat(121), checked: "true"}}));
    expect(JSON.parse(fetch.mock.lastCall?.[1].body)).toEqual({event: waitlistAnalyticsEventNames[0], ...Object.fromEntries(Object.keys(fields).map(field => [field, null]))});
  });
  it("emits exactly one candidate theme meta on the error document", () => {
    mockUseRouteError.mockReturnValue(new Error("Unavailable"));
    const html = renderToString(<ErrorBoundary />);
    expect(html.match(/name="theme-color"/g)).toHaveLength(1);
    expect(html).toContain('name="theme-color" content="#0e0c15"');
  });
});
