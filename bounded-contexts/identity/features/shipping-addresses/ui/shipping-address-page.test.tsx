// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShippingAddressPage } from "./shipping-address-page";

function expectAutocomplete(markup: string, name: string, value: string) {
  expect(markup).toMatch(new RegExp(`<input(?=[^>]*\\bname="${name}")(?=[^>]*\\bautocomplete="${value}")[^>]*>`, "i"));
}

describe("ShippingAddressPage", () => {
  it("renders saved addresses with default management controls", () => {
    const { container } = render(
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

    expect(container.textContent).toContain("Shipping Addresses");
    expect(container.textContent).toContain("Home");
    expect(container.textContent).toContain("Default");
    expect(container.textContent).toContain("100 Market Street");
    expect(container.textContent).toContain("Update address");
    expect(container.textContent).toContain("Archive");
    expect(container.querySelectorAll(".min-w-0.max-w-full.rounded-tokenLg.shadow-tokenLg")).toHaveLength(1);
    expect(container.querySelectorAll(".min-w-0.max-w-full.rounded-tokenLg.bg-surface-2")).toHaveLength(1);
  });

  it("identifies every shipping-address field for browser autofill", () => {
    const { container } = render(<ShippingAddressPage addresses={[]} />);
    const markup = container.innerHTML;

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
    expect(container.querySelectorAll(".min-w-0.max-w-full.rounded-tokenLg.bg-surface-2")).toHaveLength(1);
    expect(markup).not.toContain('elevated="true"');
  });
});
