import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShippingAddressPage } from "./shipping-address-page";

function expectAutocomplete(markup: string, name: string, value: string) {
  expect(markup).toMatch(new RegExp(`<input(?=[^>]*\\bname="${name}")(?=[^>]*\\bautocomplete="${value}")[^>]*>`, "i"));
}

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
            verification: null,
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
    expect(markup).toContain("shadow-tokenLg");
    expect(markup.match(/bg-surface-2/g)?.length).toBe(1);
  });

  it("identifies every shipping-address field for browser autofill", () => {
    const markup = renderToString(<ShippingAddressPage addresses={[]} />);

    for (const [name, autocomplete] of [
      ["name", "name"],
      ["company", "organization"],
      ["country", "country"],
      ["line1", "address-line1"],
      ["line2", "address-line2"],
      ["city", "address-level2"],
      ["state", "address-level1"],
      ["postalCode", "postal-code"],
      ["phone", "tel"],
      ["email", "email"],
    ] as const) {
      expectAutocomplete(markup, name, autocomplete);
    }
    expect(markup).toContain("bg-surface-2");
    expect(markup).not.toContain('elevated="true"');
  });
});
