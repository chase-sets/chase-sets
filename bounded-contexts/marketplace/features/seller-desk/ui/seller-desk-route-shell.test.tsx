import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SellerDeskRouteShell, resolveSellerDeskNavigation } from "./seller-desk-route-shell";

const sellerActor = {
  permissions: ["inventory.view", "listings.view", "offers.view", "fulfillment.view", "payouts.view"],
};

describe("SellerDeskRouteShell", () => {
  it("provides one localized navigation model for every Seller Desk surface", () => {
    const items = resolveSellerDeskNavigation(sellerActor);

    expect(items.map((item) => [item.key, item.href])).toEqual([
      ["seller-desk-home", "/account/desk"],
      ["seller-desk-fulfillment", "/account/desk/shipments"],
      ["seller-desk-money", "/account/desk/money"],
      ["seller-desk-offers", "/account/desk/offers"],
      ["seller-desk-settings", "/account/desk/settings"],
    ]);
  });

  it("marks an entity route's owning module active and renders the mounted surface", () => {
    const html = renderToString(
      <SellerDeskRouteShell pathname="/account/desk/shipments/shipment-3" actor={sellerActor}>
        <article>Shipment workspace</article>
      </SellerDeskRouteShell>,
    );

    expect(html).toContain('aria-label="Seller Desk navigation"');
    expect(html).toContain('href="/account/desk/shipments" aria-current="page"');
    expect(html).toContain("Shipment workspace");
  });

  it("keeps unavailable modules out of navigation while preserving the Desk home", () => {
    const items = resolveSellerDeskNavigation({ permissions: ["inventory.view"] });

    expect(items.map((item) => item.key)).toEqual(["seller-desk-home", "seller-desk-settings"]);
  });
});
