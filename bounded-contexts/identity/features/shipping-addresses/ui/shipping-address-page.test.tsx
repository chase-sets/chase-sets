// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  renderAccountManagementPage as render,
  renderHeldAccountManagementRoute,
  stubHeldAccountManagementTransport,
} from "../../account-management/ui/test-support";
import { syntheticMutationResult } from "../../account-management/api/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShippingAddress } from "./contracts";
import { ShippingAddressPage } from "./shipping-address-page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const actor = { tenantId: "tnt_test", userId: "usr_test", accountId: "acc_test" };
const route = "/account/shipping-addresses";

function address(id: string, label: string, isDefault: boolean): ShippingAddress {
  return {
    shipping_address_id: id,
    account_id: actor.accountId,
    label,
    recipient_name: "Jane Smith",
    company: null,
    line1: `${label} Street`,
    line2: null,
    city: "Chicago",
    state: "IL",
    postal_code: "60601",
    country: "US",
    phone: null,
    email: null,
    verification: null,
    is_default: isDefault,
    is_archived: false,
    created_at: "2026-05-13T10:00:00.000Z",
    updated_at: "2026-05-13T10:00:00.000Z",
  };
}

function busy(button: HTMLElement) {
  return { disabled: button.matches(":disabled"), busy: button.getAttribute("aria-busy") };
}

describe("ShippingAddressPage pending state", () => {
  it("identity account forms busy only themselves", async () => {
    const transport = stubHeldAccountManagementTransport();
    const base = address("adr_base", "Base", true);
    const { loads } = renderHeldAccountManagementRoute(
      route,
      [base, address("adr_home", "Home", false), address("adr_work", "Work", false)],
      (addresses) => <ShippingAddressPage addresses={addresses} />,
    );
    const [home, work] = screen.getAllByRole("button", { name: "Set default" });
    await waitFor(() => expect(home.matches(":disabled")).toBe(false));
    const save = screen.getByRole("button", { name: "Save address" });
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Typed city" } });

    home.focus();
    fireEvent.click(home);
    fireEvent.click(home);
    await waitFor(() => expect(transport.posts()).toHaveLength(1));
    expect(busy(home)).toEqual({ disabled: false, busy: "true" });
    expect(document.activeElement).toBe(home);
    expect(busy(work)).toEqual({ disabled: false, busy: null });
    expect(busy(save)).toEqual({ disabled: false, busy: null });
    expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe("Typed city");
    expect(transport.posts()[0].body?.get("shippingAddressId")).toBe("adr_home");

    transport.posts()[0].respond(syntheticMutationResult("default", actor, { target: "adr_home" }));
    await waitFor(() => expect(loads).toHaveLength(1));
    expect(busy(home)).toEqual({ disabled: false, busy: "true" });
    loads[0]([{ ...base, is_default: false }, address("adr_home", "Home", true), address("adr_work", "Work", false)]);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Set default" })).toHaveLength(2));
    expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe("Typed city");

    fireEvent.click(work);
    await waitFor(() => expect(transport.posts()).toHaveLength(2));
    expect(transport.posts()[1].body?.get("shippingAddressId")).toBe("adr_work");
    expect(busy(work)).toEqual({ disabled: false, busy: "true" });
    transport.posts()[1].respond({ outcome: "not-recorded", code: "not-recorded" });
    await screen.findByText("No change was recorded. Review and submit again.");
    await waitFor(() => expect(busy(work)).toEqual({ disabled: false, busy: null }));
  });

  it("re-enables after back-to-back inline errors", async () => {
    const transport = stubHeldAccountManagementTransport();
    renderHeldAccountManagementRoute(route, [], (addresses) => <ShippingAddressPage addresses={addresses} />);
    const save = screen.getByRole("button", { name: "Save address" });
    await waitFor(() => expect(save.matches(":disabled")).toBe(false));
    for (const [label, value] of [
      ["Recipient name", "Jane Smith"],
      ["Address line 1", "100 Market Street"],
      ["City", "Chicago"],
      ["State", "IL"],
      ["Postal code", "60601"],
    ])
      fireEvent.change(screen.getByLabelText(label), { target: { value } });

    for (let attempt = 1; attempt <= 2; attempt++) {
      fireEvent.click(save);
      await waitFor(() => expect(transport.posts()).toHaveLength(attempt));
      expect(busy(save)).toEqual({ disabled: false, busy: "true" });
      transport.posts()[attempt - 1].respond({ outcome: "not-recorded", code: "validation-failed" }, 400);
      await screen.findByText("No change was recorded. Review and submit again.");
      await waitFor(() => expect(busy(save)).toEqual({ disabled: false, busy: null }));
      expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe("Chicago");
    }
    fireEvent.click(save);
    await waitFor(() => expect(transport.posts()).toHaveLength(3));
    transport.posts()[2].respond({ outcome: "not-recorded", code: "validation-failed" }, 400);
    await waitFor(() => expect(busy(save)).toEqual({ disabled: false, busy: null }));
  });
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
});
