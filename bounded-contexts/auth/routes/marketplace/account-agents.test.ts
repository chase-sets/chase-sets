// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import AccountAgentsRoute, { loader } from "./account-agents";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Connected agents sandbox reads", () => {
  it.each([
    ["configured internal origin", "http://localhost:6412", "http://localhost:6412"],
    ["unset internal origin control", undefined, "http://localhost:6403"],
  ])("uses the resolved destination with %s and renders the existing empty state", async (_name, internalOrigin, expectedOrigin) => {
    vi.stubEnv("CHASE_SETS_INTERNAL_API_ORIGIN", internalOrigin);
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ authorizations: [] }));
    vi.stubGlobal("fetch", fetch);
    const request = new Request("http://localhost:6403/account/agents", {
      headers: { cookie: "session=synthetic-buyer", authorization: "Bearer synthetic-token" },
    });
    const data = await loader({ request, params: {}, context: {}, url: new URL(request.url), pattern: "/account/agents" });
    expect(data).toEqual({ items: [], total: 0, count: 0, mcpUrl: "http://localhost:6403/mcp" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${expectedOrigin}/ucp/oauth/authorizations`);
    expect(init?.credentials).toBe("include");
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBe("session=synthetic-buyer");
    expect(headers.get("authorization")).toBe("Bearer synthetic-token");

    const router = createMemoryRouter([{ path: "/account/agents", loader: () => data, Component: AccountAgentsRoute }], {
      initialEntries: ["/account/agents"],
    });
    render(createElement(ChaseRoot, { linkComponent: RouterLinkAdapter }, createElement(RouterProvider, { router })));
    expect(await screen.findByText("No agents yet")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
    router.dispose();
  });
});
