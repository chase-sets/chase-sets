// @vitest-environment jsdom

import { renderAccountManagementPage as render } from "../../account-management/ui/test-support";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render as renderDom, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as routerApi from "react-router";
import { ShippingAddressPage } from "./shipping-address-page";
import ShippingAddressRoute, { action, loader } from "../../../routes/marketplace/account-shipping-addresses";
import type { ShippingAddress } from "./contracts";
import { SHIPPING_ADDRESS_REQUIRED_MESSAGES } from "../domain/errors";
import { t } from "@chase-sets/localization";
import { syntheticMutationResult } from "../../account-management/api/test-support";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const actor = {
  sessionId: "ses_identity",
  tenantId: "tnt_identity",
  userId: "usr_identity",
  accountId: "acc_identity",
  membershipId: "mbr_identity",
  roleKey: "owner",
  permissions: ["accounts.view", "accounts.manage"],
};
const ids = ["adr_01ARZ3NDEKTSV4RRFFQ69G5FAV", "adr_01ARZ3NDEKTSV4RRFFQ69G5FAW", "adr_01ARZ3NDEKTSV4RRFFQ69G5FAX"];
const cityMessage = t(SHIPPING_ADDRESS_REQUIRED_MESSAGES.city);
const marker = "SYNTHETIC_PRIVATE_BODY_MARKER_9910";

function address(id: string, index: number): ShippingAddress {
  return {
    shipping_address_id: id,
    account_id: actor.accountId,
    label: `Synthetic ${index}`,
    recipient_name: "Synthetic recipient",
    company: null,
    line1: "1 Test St",
    line2: null,
    city: "Chicago",
    state: "IL",
    postal_code: "60601",
    country: "US",
    phone: null,
    email: null,
    verification: null,
    is_default: false,
    is_archived: false,
    created_at: "2026-05-13T10:00:00.000Z",
    updated_at: "2026-05-13T10:00:00.000Z",
  };
}

async function realShippingRoute() {
  vi.stubGlobal("crypto", webcrypto);
  let activeActor = { ...actor };
  let rows = ids.map(address);
  let rejection: unknown = {
    error: {
      code: "validation_failed",
      message: marker,
      details: [{ field: "city", code: "required", message: marker }],
    },
  };
  let status = 400;
  let release: (() => void) | undefined;
  let held: Promise<void> | undefined;
  const posts: Request[] = [];
  // Bridge only the wire encoding. The actual boundary, transport validation,
  // route action, API error adapter and loader all run unchanged.
  vi.spyOn(routerApi, "UNSAFE_decodeViaTurboStream").mockImplementation(
    async (stream) =>
      ({
        value: { data: await new Response(stream).json() },
      }) as never,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url, "https://chasesets.test").pathname === "/account/shipping-addresses.data") {
        const form = init!.body as FormData;
        const actionRequest = new Request("https://chasesets.test/account/shipping-addresses", {
          method: "POST",
          headers: {
            ...Object.fromEntries(new Headers(init!.headers)),
            "Content-Type": "application/x-www-form-urlencoded",
            cookie: "session=identity",
          },
          body: new URLSearchParams([...form.entries()].map(([key, value]) => [key, String(value)])),
        });
        posts.push(actionRequest.clone());
        const result = await action({ request: actionRequest, params: {}, context: undefined });
        await held;
        if (result instanceof Response) return result;
        const payload = result as { data: unknown; init?: ResponseInit };
        return Response.json(payload.data, payload.init);
      }
      const request = input instanceof Request ? input : new Request(new URL(url, "https://chasesets.test"), init);
      if (url.includes("/api/auth/session")) return Response.json({ actor: activeActor });
      if (url.includes("/api/identity/current-actor-display"))
        return Response.json({
          account: { account_id: actor.accountId },
          membership: { membership_id: actor.membershipId },
          user: { user_id: actor.userId },
        });
      if (url.includes(`/api/identity/accounts/${actor.accountId}/shipping-addresses`)) {
        if (request.method === "GET" && new URL(url).pathname.endsWith("shipping-addresses"))
          return Response.json({ items: rows, total: rows.length, count: rows.length });
        return Response.json(rejection, { status });
      }
      return Response.json(rejection, { status });
    }),
  );
  const router = routerApi.createMemoryRouter(
    [{ path: "/account/shipping-addresses", loader, action, Component: ShippingAddressRoute }],
    { initialEntries: ["/account/shipping-addresses"] },
  );
  renderDom(<routerApi.RouterProvider router={router} />);
  await screen.findByRole("button", { name: "Save address" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save address" }).matches(":disabled")).toBe(false));
  return {
    router,
    posts,
    reject(value: unknown, code = 400) {
      rejection = value;
      status = code;
    },
    changeActor() {
      activeActor = { ...actor, userId: "usr_other" };
    },
    hold() {
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      release?.();
      held = undefined;
    },
    async revalidate(remove?: string) {
      if (remove) rows = rows.filter((row) => row.shipping_address_id !== remove);
      await act(async () => {
        await router.revalidate();
      });
      await waitFor(() => expect(router.state.revalidation).toBe("idle"));
    },
  };
}

function submit(form: HTMLFormElement) {
  form.querySelector<HTMLButtonElement>('button[type="submit"]')!.focus();
  fireEvent.submit(form);
}
function createForm() {
  return document.querySelector<HTMLFormElement>('form:has(input[name="intent"][value="create"])')!;
}
async function openUpdate(index = 1) {
  fireEvent.click(screen.getAllByRole("button", { name: "Update address", exact: true })[index]);
  const dialog = await screen.findByRole("dialog");
  return { dialog, form: dialog.querySelector("form")! };
}

describe("Shipping address real data-router occurrences", () => {
  it("shipping field errors use the real keyed action, local ids and canonical inline wiring", async () => {
    const route = await realShippingRoute();
    const form = createForm();
    const originalId = form.querySelector<HTMLInputElement>('input[name="city"]')!.id;
    submit(form);
    const summary = await screen.findByRole("alert");
    const city = form.querySelector<HTMLInputElement>('input[name="city"]')!;
    expect(city.id).toBe(originalId);
    expect(city.getAttribute("aria-invalid")).toBe("true");
    const description = document.getElementById(city.getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe(cityMessage);
    expect(description?.hasAttribute("role")).toBe(false);
    expect(description?.hasAttribute("aria-live")).toBe(false);
    const link = within(summary).getByRole("link");
    expect(link.getAttribute("href")).toBe(`#${city.id}`);
    fireEvent.click(link);
    expect(document.activeElement).toBe(city);
    fireEvent.keyDown(link, { key: "Enter" });
    expect(document.activeElement).toBe(city);
    expect(new Set([...document.querySelectorAll("[id]")].map((node) => node.id)).size).toBe(
      document.querySelectorAll("[id]").length,
    );
    expect(route.posts).toHaveLength(1);
    expect(route.posts[0].headers.get("Idempotency-Key")).toMatch(/^[a-f0-9-]{36}$/i);
    expect(document.body.textContent).not.toContain(marker);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("");
  });

  it("row fallback isolates three rows, keeps null errors in-sheet and hands a revalidated removed row to the controller", async () => {
    const route = await realShippingRoute();
    const { form, dialog } = await openUpdate();
    submit(form);
    const summary = await screen.findByRole("alert");
    expect(dialog.contains(summary)).toBe(true);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(form.querySelector('input[name="shippingAddressId"]')?.getAttribute("value")).toBe(ids[1]);
    expect(createForm().querySelector('[aria-invalid="true"]')).toBeNull();
    route.reject({ outcome: "not-recorded", code: "validation-failed" });
    submit(form);
    await waitFor(() => expect(screen.getByRole("alert").querySelectorAll("a")).toHaveLength(0));
    expect(dialog.contains(screen.getByRole("alert"))).toBe(true);
    route.hold();
    submit(form);
    await waitFor(() => expect(route.posts).toHaveLength(3));
    await route.revalidate(ids[1]);
    expect(document.querySelector(`input[name="shippingAddressId"][value="${ids[1]}"]`)).toBeNull();
    await act(async () => route.release());
    await waitFor(() => expect(screen.getByRole("status").textContent).not.toBe(""));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelectorAll('a[href*="shipping-address-"]')).toHaveLength(0);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "No change was recorded. Review and submit again.",
    );
  });

  it("focus lifecycle commits one assertive summary before focus, repeats once, and clears on accepted, closure and navigation", async () => {
    const route = await realShippingRoute();
    const observations: boolean[] = [];
    const focus = (event: FocusEvent) => {
      const summary = event.target;
      if (!(summary instanceof HTMLElement) || summary.getAttribute("role") !== "alert") return;
      const city = summary.closest("form")?.querySelector('input[name="city"]');
      observations.push(
        city?.getAttribute("aria-invalid") === "true" &&
          Boolean(document.getElementById(city.getAttribute("aria-describedby")!)) &&
          document.querySelectorAll('[role="alert"]').length === 1,
      );
    };
    document.addEventListener("focusin", focus);
    try {
      for (let occurrence = 1; occurrence <= 2; occurrence++) {
        submit(createForm());
        await waitFor(() => expect(observations).toHaveLength(occurrence));
        expect(observations.every(Boolean)).toBe(true);
        await route.revalidate();
        expect(observations).toHaveLength(occurrence);
      }
      route.hold();
      submit(createForm());
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(observations).toHaveLength(2);
      await act(async () => route.release());
      await waitFor(() => expect(observations).toHaveLength(3));
      const { form, dialog } = await openUpdate();
      submit(form);
      await waitFor(() => expect(observations).toHaveLength(4));
      fireEvent.click(within(dialog).getByRole("button", { name: "Close", exact: true }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const reopened = await openUpdate();
      expect(within(reopened.dialog).queryByRole("alert")).toBeNull();
      fireEvent.click(within(reopened.dialog).getByRole("button", { name: "Close", exact: true }));
      await act(async () => {
        await route.router.navigate("/account/shipping-addresses?changed=1");
      });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(observations).toHaveLength(4);
    } finally {
      document.removeEventListener("focusin", focus);
    }
  });

  it.each(["default", "archive"])("mutation parity keeps %s failures controller-owned", async (intent) => {
    const route = await realShippingRoute();
    route.reject({ outcome: "not-recorded", code: "validation-failed" });
    if (intent === "archive") fireEvent.click(screen.getAllByRole("button", { name: "Archive", exact: true })[0]);
    const form = document.querySelector<HTMLFormElement>(`form:has(input[name="intent"][value="${intent}"])`)!;
    submit(form);
    await waitFor(() => expect(screen.getByRole("status").textContent).not.toBe(""));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(route.posts).toHaveLength(1);
    expect(document.body.textContent).not.toContain(marker);
  });

  it.each(["create", "update", "default", "archive"] as const)(
    "mutation parity preserves %s success and destination",
    async (intent) => {
      const route = await realShippingRoute();
      route.reject(
        syntheticMutationResult(
          intent,
          { tenantId: actor.tenantId, userId: actor.userId, accountId: actor.accountId },
          { target: intent === "create" ? null : ids[0] },
        ),
        200,
      );
      if (intent === "update") await openUpdate(0);
      if (intent === "archive") fireEvent.click(screen.getAllByRole("button", { name: "Archive", exact: true })[0]);
      const form = document.querySelector<HTMLFormElement>(`form:has(input[name="intent"][value="${intent}"])`)!;
      submit(form);
      await screen.findByText("Your change was saved");
      expect(document.querySelectorAll('section[role="alert"]')).toHaveLength(0);
      expect(route.router.state.location.pathname).toBe("/account/shipping-addresses");
      expect(route.posts).toHaveLength(1);
      expect(document.body.textContent).not.toContain(marker);
    },
  );

  it("focus lifecycle clears state when the route remounts its actor boundary", async () => {
    const route = await realShippingRoute();
    submit(createForm());
    await screen.findByRole("alert");
    route.changeActor();
    await route.revalidate();
    expect(document.querySelectorAll('section[role="alert"]')).toHaveLength(0);
    expect(createForm().querySelector('[aria-invalid="true"]')).toBeNull();
  });

  it("shipping field errors with unknown provider fields produce no dead summary links or raw markers", async () => {
    const logs = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    const route = await realShippingRoute();
    route.reject({
      error: {
        code: "validation_failed",
        message: marker,
        details: [{ field: marker, code: "required", message: marker }],
      },
    });
    submit(createForm());
    const summary = await screen.findByRole("alert");
    expect(summary.querySelectorAll("a")).toHaveLength(0);
    expect(document.body.textContent).not.toContain(marker);
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
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
