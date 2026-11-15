import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { EbayConnectionJourney, type EbayJourneyState } from "../ui/connection-journey";
import { scopesForCapabilities } from "../domain/oauth";

describe("ebay-sandbox-connection-journey", () => {
  const render = (state: EbayJourneyState, publication = false) => {
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <EbayConnectionJourney
            state={state}
            scopes={scopesForCapabilities(publication)}
            publication={publication}
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
});
