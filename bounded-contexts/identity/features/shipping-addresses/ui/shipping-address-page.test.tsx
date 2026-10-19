// @vitest-environment jsdom

import { renderAccountManagementPage as render } from "../../account-management/ui/test-support";
import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as routerApi from "react-router";
import { ShippingAddressPage } from "./shipping-address-page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it("renders the address-issue notice as a tinted surface", () => {
    const { container } = render(<ShippingAddressPage addresses={[]} errorMessage="Street is required" />);

    expect(container.textContent).toContain("Street is required");
    expect(container.querySelectorAll(".min-w-0.max-w-full.rounded-tokenLg.bg-surface-2")).toHaveLength(2);
    expect(container.querySelectorAll(".min-w-0.max-w-full.rounded-tokenLg.shadow-tokenLg")).toHaveLength(0);
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
  });

  it("shipping field errors are presented by the submitted form with one focused summary", async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.spyOn(routerApi, "UNSAFE_decodeViaTurboStream").mockResolvedValue({
      value: {
        data: {
          failure: {
            kind: "validation",
            status: 400,
            code: "validation_failed",
            message: "City is required.",
            intent: "create",
            classification: "FIELD",
            errors: { fieldErrors: { city: ["City is required."] }, formErrors: [] },
          },
        },
      },
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("synthetic", { status: 400 })),
    );

    const { container } = render(<ShippingAddressPage addresses={[]} />, "/account/shipping-addresses");
    const form = screen.getByRole("button", { name: "Save address" }).closest("form");
    expect(form).not.toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save address" }).matches(":disabled")).toBe(false));
    fireEvent.submit(form!);

    const summary = await screen.findByRole("alert");
    const city = container.querySelector('input[name="city"]');
    expect(summary.textContent).toContain("City");
    expect(city?.getAttribute("aria-invalid")).toBe("true");
    expect(summary.querySelector(`a[href="#${city?.id}"]`)).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(summary));
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
});
