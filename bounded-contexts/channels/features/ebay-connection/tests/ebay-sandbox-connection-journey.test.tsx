import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EbayConnectionJourney, type EbayJourneyState } from "../ui/connection-journey";
import { scopesForCapabilities } from "../domain/oauth";
import { action, loader } from "../../../routes/marketplace/account-channels-ebay";

const boundary = vi.hoisted(() => ({ ebay: vi.fn(), disconnect: vi.fn() }));
vi.mock("@chase-sets/platform-runtime/auth", () => ({ requireActorFromAuthApi: vi.fn(async () => ({})) }));
vi.mock("../ui/api-client", () => ({ createEbayConnectionClient: () => boundary.ebay }));
vi.mock("../../../support/request-support/api-client", () => ({
  createChannelsConnectionsRequestApiClient: () => ({ disconnectConnection: boundary.disconnect }),
}));

describe("ebay-sandbox-connection-journey", () => {
  beforeEach(() => vi.clearAllMocks());
  const render = (state: EbayJourneyState, publication = false, authorizationAvailable = true) => {
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <EbayConnectionJourney
            state={state}
            scopes={scopesForCapabilities(publication)}
            publication={publication}
            authorizationAvailable={authorizationAvailable}
            connectionId={state === "connect" || state === "consent" ? null : "synthetic-connection"}
          />
        ),
      },
    ]);
    try {
      return renderToStaticMarkup(<RouterProvider router={router} />);
    } finally {
      router.dispose();
    }
  };
  it.each([
    "connect",
    "consent",
    "awaiting-callback",
    "declined",
    "failed",
    "pending-setup",
    "connected",
    "reauthorize",
    "disconnected",
  ] as const)("renders %s without a custom component override", (state) => {
    const html = render(state);
    expect(html).toContain("eBay Sandbox");
    expect(html).not.toContain("channels.ebay.");
    if (state === "awaiting-callback") expect(html).toContain("Complete consent on eBay");
    else for (const scope of scopesForCapabilities(false)) expect(html).toContain(scope);
    if (state === "disconnected") {
      expect(html).toContain("eBay revocation is unconfirmed");
      expect(html).toContain("Remove Chase Sets access");
      expect(html).not.toContain('value="disconnect"');
    }
  });
  it("shows exactly the consented scopes and separately opts into publication", () => {
    expect(render("consent")).not.toContain("api_scope/sell.inventory</");
    const expanded = render("consent", true);
    for (const scope of scopesForCapabilities(true)) expect(expanded).toContain(scope);
    expect(expanded).toContain('name="publication" value="true"');
  });
  it.each(["pending-setup", "disconnected"] as const)(
    "keeps %s reachable without consent when OAuth configuration is withdrawn",
    async (status) => {
      boundary.ebay.mockImplementation(async (path: string) => {
        if (path === "/connections/synthetic-connection") return { status, authorizationAvailable: false };
        throw new Error("authorization-disabled");
      });
      const url = new URL("http://localhost/account/channels/ebay?connectionId=synthetic-connection");
      const data = await loader({ request: new Request(url), params: {}, context: {}, url, pattern: url.pathname });
      expect(data).toMatchObject({ state: status, scopes: [], authorizationAvailable: false });
      expect(boundary.ebay.mock.calls).toEqual([["/connections/synthetic-connection"]]);
      const html = render(status, false, false);
      expect(html).not.toContain('value="authorize"');
      if (status === "pending-setup") expect(html).toContain('value="disconnect"');
      else expect(html).toContain("eBay revocation is unconfirmed");
    },
  );
  it("uses composed disconnect and shows a failed local commit rather than acknowledging success", async () => {
    const url = new URL("http://localhost/account/channels/ebay?connectionId=synthetic-connection");
    const args = () => ({
      request: new Request(url, {
        method: "POST",
        body: new URLSearchParams({ intent: "disconnect", connectionId: "synthetic-connection" }),
      }),
      params: {},
      context: {},
      url,
      pattern: url.pathname,
    });
    boundary.disconnect.mockResolvedValueOnce({});
    const result = await action(args());
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe(
      "/account/channels/ebay?connectionId=synthetic-connection",
    );
    expect(boundary.disconnect).toHaveBeenCalledWith("synthetic-connection");
    boundary.disconnect.mockRejectedValueOnce(new Error("synthetic-local-commit-failed"));
    expect(await action(args())).toEqual({ failed: true });
  });
});
