import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SellerShippingSetupResult } from "../../../support/request-support/api-client";
import { ShippingSetupPage, emptyShippingSetupValues, shippingSetupValues } from "./shipping-setup-page";

describe("shipping setup presentation", () => {
  it("renders accessible empty controls and only the two existing label choices", () => {
    const markup = renderToString(<ShippingSetupPage result={null} values={emptyShippingSetupValues} />);
    expect(markup).toContain("Add your current shipping origin");
    for (const field of ["name", "line1", "line2", "city", "state", "postalCode", "country", "labelPreference"])
      expect(markup).toContain(`name="${field}"`);
    expect(markup).toContain('value="prepaid-label"');
    expect(markup).toContain('value="seller-label-later"');
    expect(markup).toContain("not a carrier guarantee or checkout approval");
  });
  it("disables save and announces pending work", () => {
    const markup = renderToString(<ShippingSetupPage result={null} values={emptyShippingSetupValues} pending />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("disabled");
    expect(markup).toContain("Saving shipping setup");
  });
  it.each(["missing", "revoked", "invalidated", "enabled"] as const)(
    "does not confuse saved setup with %s support",
    (supportStatus) => {
      const result: SellerShippingSetupResult = {
        setup: {
          origin: { ...emptyShippingSetupValues, name: "Seller", line2: null },
          labelPreference: "prepaid-label",
          shipFromLocationId: "sfl_test",
        },
        revision: 7,
        recordedAt: null,
        supportStatus,
      };
      const markup = renderToString(<ShippingSetupPage result={result} values={shippingSetupValues(result)} />);
      expect(markup).toContain(
        supportStatus === "enabled" ? "saved with platform shipping support" : "awaiting platform shipping support",
      );
      expect(markup).not.toContain(
        supportStatus === "enabled" ? "Shipping remains blocked" : "saved with platform shipping support",
      );
      expect(markup).not.toContain('name="revision"');
    },
  );
  it("retains rejected input with an error, but exposes only recovery when identity/source is missing", () => {
    const values = { ...emptyShippingSetupValues, name: "Retained seller" };
    const markup = renderToString(<ShippingSetupPage result={null} values={values} error="Save rejected" />);
    expect(markup).toContain('value="Retained seller"');
    expect(markup).toContain("Save rejected");
    for (const state of [{ missingIdentity: true }, { unavailable: true, error: "Unavailable" }]) {
      const recovery = renderToString(<ShippingSetupPage result={null} values={values} {...state} />);
      expect(recovery).toContain('href="/account/sell-list"');
      expect(recovery).not.toContain("<form");
      expect(recovery).not.toContain("Retained seller");
    }
  });
});
