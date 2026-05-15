import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShippingAddressPage } from "./shipping-address-page";

describe("ShippingAddressPage", () => {
  it("renders saved addresses with default management controls", () => {
    const markup = renderToString(
      <ShippingAddressPage
        addresses={[
          {
            shipping_address_id: "adr_home",
            account_id: "acc_buyer",
            label: "Home",
            recipient_name: "Jane Smith",
            company: null,
            line1: "100 Market Street",
            line2: null,
            city: "Chicago",
            state: "IL",
            postal_code: "60601",
            country: "US",
            phone: null,
            email: null,
            is_default: true,
            is_archived: false,
            created_at: "2026-05-13T10:00:00.000Z",
            updated_at: "2026-05-13T10:00:00.000Z",
          },
        ]}
      />,
    );

    expect(markup).toContain("Shipping Addresses");
    expect(markup).toContain("Home");
    expect(markup).toContain("Default");
    expect(markup).toContain("100 Market Street");
    expect(markup).toContain("Update address");
    expect(markup).toContain("Archive");
  });
});
