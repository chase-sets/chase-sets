// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createBrowserRouter, createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@chase-sets/localization";
import ShippingAddressRoute, { action, loader } from "../../../routes/marketplace/account-shipping-addresses";
import { SHIPPING_ADDRESS_REQUIRED_MESSAGES } from "../domain/errors";
import type { ShippingAddress } from "./contracts";
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

  it("renders the post-write loader notice without a live validation summary", () => {
    const message = t("identity.routes.marketplace.accountShippingAddresses.addresses.updating");
    const { container } = render(<ShippingAddressPage addresses={[]} errorMessage={message} />);

    expect(screen.getByText(message)).toBeTruthy();
    expect(container.querySelectorAll('[role="alert"], [aria-live]')).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Check the form" })).toBeNull();
    expect(container.querySelector('a[href^="#"]')).toBeNull();
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

const path = "/account/shipping-addresses";
const marker = "synthetic-private-address-marker";
const actor = {
  sessionId: "ses_identity",
  tenantId: "tnt_identity",
  userId: "usr_identity",
  accountId: "acc_identity",
  membershipId: "mbr_identity",
  roleKey: "owner",
  permissions: ["accounts.manage", "accounts.view"],
};
const rows: ShippingAddress[] = ["V", "W", "X"].map((suffix, index) => ({
  shipping_address_id: `adr_01ARZ3NDEKTSV4RRFFQ69G5FA${suffix}`,
  account_id: actor.accountId,
  label: `Address ${index + 1}`,
  recipient_name: "Synthetic Recipient",
  company: null,
  line1: "100 Example Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postal_code: "60601",
  country: "US",
  phone: null,
  email: null,
  verification: null,
  is_default: index === 0,
  is_archived: false,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
}));
const routers: ReturnType<typeof createMemoryRouter>[] = [];
afterEach(() => {
  cleanup();
  routers.splice(0).forEach((router) => router.dispose());
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function rejection(field: unknown = "name", extra = {}) {
  return {
    error: {
      code: "validation_failed",
      message: marker,
      details: [{ field, code: "required", message: marker, ...extra }],
    },
  };
}

async function routed(browserHistory = false) {
  let addresses = [...rows];
  let body: unknown = rejection();
  let status = 400;
  let reads = 0;
  const writes: Request[] = [];
  const logs = ["error", "warn", "log", "info", "debug"].map((method) =>
    vi.spyOn(console, method as "error").mockImplementation(() => {}),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes("/api/auth/session")) return Response.json({ actor });
      if (request.method === "GET") {
        reads++;
        return Response.json({ items: addresses, count: addresses.length, total: addresses.length });
      }
      writes.push(request);
      return Response.json(body, { status });
    }),
  );
  const routes = [
    { path, Component: ShippingAddressRoute, action, loader, HydrateFallback: () => null },
    { path: "/elsewhere", element: <p>Elsewhere</p> },
  ];
  if (browserHistory) window.history.replaceState(null, "", path);
  const router = browserHistory ? createBrowserRouter(routes) : createMemoryRouter(routes, { initialEntries: [path] });
  routers.push(router);
  render(<RouterProvider router={router} />);
  await screen.findByText("Address 3");
  return {
    router,
    writes,
    logs,
    reads: () => reads,
    remove: (id: string) => {
      addresses = addresses.filter((row) => row.shipping_address_id !== id);
    },
    restoreRows: () => {
      addresses = [...rows];
    },
    fail: (next: unknown, nextStatus = 400) => {
      body = next;
      status = nextStatus;
    },
    submit: async (intent: string, shippingAddressId?: string) => {
      await act(async () => {
        await router.navigate(path, {
          formMethod: "post",
          body: new URLSearchParams({
            intent,
            ...(shippingAddressId ? { shippingAddressId } : {}),
            name: "",
            line1: "",
            city: "",
            state: "",
            postalCode: "",
            country: "US",
          }),
        });
      });
      await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
    },
    revalidate: async () => {
      await act(async () => {
        await router.revalidate();
      });
      await waitFor(() => expect(router.state.revalidation).toBe("idle"));
    },
  };
}

function expectLinkedField(field: string) {
  const summary = screen.getByRole("alert");
  const link = within(summary).getByRole("link");
  const input = document.getElementById(link.getAttribute("href")!.slice(1)) as HTMLInputElement;
  expect(input.name).toBe(field);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  const description = input.getAttribute("aria-describedby")!;
  expect(document.getElementById(description)?.textContent).toBe(link.textContent);
  expect(document.getElementById(description)?.getAttribute("role")).toBeNull();
  expect(document.getElementById(description)?.getAttribute("aria-live")).toBeNull();
  expect(summary.getAttribute("aria-live")).toBe("assertive");
  expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(1);
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
  return { summary, link, input };
}

describe("Shipping Address routed presentation", () => {
  it.each(["create", "update"])(
    "browser-history summary click retains the %s failure without refocusing or replacing its alert",
    async (intent) => {
      const app = await routed(true);
      const focusEvents: EventTarget[] = [];
      const onFocus = (event: FocusEvent) => {
        if ((event.target as HTMLElement).getAttribute("role") === "alert") focusEvents.push(event.target!);
      };
      document.addEventListener("focusin", onFocus);
      try {
        await app.submit(intent, intent === "update" ? rows[1].shipping_address_id : undefined);
        const { summary, link, input } = expectLinkedField("name");
        const key = app.router.state.location.key;
        expect(focusEvents).toEqual([summary]);
        await act(async () => {
          link.click();
          await waitFor(() => expect(app.router.state.location.hash).toBe(link.getAttribute("href")));
        });
        expect(app.router.state.historyAction).toBe("POP");
        expect(app.router.state.location.key).not.toBe(key);
        expect(app.router.state.actionData).toBeNull();
        expect(document.activeElement).toBe(input);
        expect(expectLinkedField("name").summary).toBe(summary);
        expect(focusEvents).toEqual([summary]);
        await app.revalidate();
        expect(expectLinkedField("name").summary).toBe(summary);
        expect(document.activeElement).toBe(input);
        expect(focusEvents).toEqual([summary]);
        expect(app.writes).toHaveLength(1);
        fireEvent.submit(input.closest("form")!);
        expect(screen.queryByRole("alert")).toBeNull();
        await act(async () => {
          await app.router.navigate(`${path}#another-field`);
        });
        expect(screen.queryByRole("alert")).toBeNull();
        await app.submit(intent, intent === "update" ? rows[1].shipping_address_id : undefined);
        const nextSummary = expectLinkedField("name").summary;
        expect(focusEvents).toEqual([summary, nextSummary]);
        await act(async () => {
          await app.router.navigate(`${path}?view=1`);
        });
        expect(screen.queryByRole("alert")).toBeNull();
        expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
        expect(document.querySelector('a[href^="#"]')).toBeNull();
        await app.submit("create");
        expectLinkedField("name");
        await act(async () => {
          await app.router.navigate("/elsewhere");
        });
        expect(screen.queryByRole("alert")).toBeNull();
      } finally {
        document.removeEventListener("focusin", onFocus);
      }
    },
  );

  it.each(
    Object.keys(SHIPPING_ADDRESS_REQUIRED_MESSAGES).flatMap((field) => [
      { field, intent: "create" },
      { field, intent: "update" },
    ]),
  )("source-authored $intent $field error binds only its mounted form", async ({ field, intent }) => {
    const app = await routed();
    app.fail(rejection(field));
    await app.submit(intent, intent === "update" ? rows[1].shipping_address_id : undefined);
    const { link, input } = expectLinkedField(field);
    expect(input.closest("form")?.querySelector<HTMLInputElement>('[name="intent"]')?.value).toBe(intent);
    if (intent === "update") {
      expect(input.closest("form")?.querySelector<HTMLInputElement>('[name="shippingAddressId"]')?.value).toBe(
        rows[1].shipping_address_id,
      );
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
    }
    const ids = Array.from(document.querySelectorAll("input[id], select[id]")).map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    fireEvent.click(link);
    expect(document.activeElement).toBe(input);
    link.focus();
    fireEvent.keyDown(link, { key: "Enter" });
    expect(document.activeElement).toBe(input);
    const id = input.id;
    await app.revalidate();
    expect(document.getElementById(id)).toBe(input);
    expect(app.writes).toHaveLength(1);
    expect(document.body.textContent).not.toContain(marker);
    expect(app.logs.flatMap((log) => log.mock.calls)).toEqual([]);
  });

  it("row fallback: removed submitted row settles through the actual loader without a dead link", async () => {
    const app = await routed();
    app.remove(rows[1].shipping_address_id);
    await app.submit("update", rows[1].shipping_address_id);
    await app.revalidate();
    expect(app.reads()).toBeGreaterThan(1);
    expect(screen.queryByText("Address 2")).toBeNull();
    expect(screen.getByRole("alert").querySelector("a")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(t(SHIPPING_ADDRESS_REQUIRED_MESSAGES.name));
  });

  it("row fallback: later revalidation removes the active row and never revives its links", async () => {
    const app = await routed();
    await app.submit("update", rows[1].shipping_address_id);
    const { input } = expectLinkedField("name");
    input.focus();
    const focusEvents: EventTarget[] = [];
    const onFocus = (event: FocusEvent) => {
      if ((event.target as HTMLElement).getAttribute("role") === "alert") focusEvents.push(event.target!);
    };
    document.addEventListener("focusin", onFocus);
    try {
      app.remove(rows[1].shipping_address_id);
      await app.revalidate();
      expect(screen.getByRole("alert").querySelector("a")).toBeNull();
      expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      app.restoreRows();
      await app.revalidate();
      expect(screen.getByRole("alert").querySelector("a")).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(focusEvents).toHaveLength(0);
    } finally {
      document.removeEventListener("focusin", onFocus);
    }
  });

  it.each([marker, "adr_invalid", "adr_01ARZ3NDEKTSV4RRFFQ69G5FAY"])(
    "row fallback: malformed or unknown identity %s cannot select a sibling",
    async (id) => {
      const app = await routed();
      await app.submit("update", id);
      expect(screen.getByRole("alert").querySelector("a")).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
      expect(document.body.textContent).not.toContain(marker);
    },
  );

  it.each([
    { field: "makeDefault", extra: {} },
    { field: "shippingAddressId", extra: {} },
    { field: { nested: marker }, extra: {} },
    { field: "name", extra: { nested: { credentials: marker } } },
  ])("row fallback: hidden/unknown/nested field $field stays form-only", async ({ field, extra }) => {
    const app = await routed();
    app.fail(rejection(field, extra));
    await app.submit("update", rows[1].shipping_address_id);
    expect(screen.getByRole("alert").querySelector("a")).toBeNull();
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(document.body.textContent).not.toContain(marker);
  });

  it.each(["default", "archive", "unknown"])("row fallback: $intent never gains editable fields", async (intent) => {
    const app = await routed();
    await app.submit(intent, rows[1].shipping_address_id);
    expect(screen.getByRole("alert").querySelector("a")).toBeNull();
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("row fallback: every mounted non-required or hidden control remains form-only", async () => {
    const app = await routed();
    fireEvent.click(screen.getAllByRole("button", { name: "Update address" })[1]);
    const form = screen.getByRole("dialog").querySelector("form")!;
    const names = Array.from(form.elements)
      .flatMap((control) =>
        control instanceof HTMLInputElement || control instanceof HTMLSelectElement ? [control.name] : [],
      )
      .filter((field) => !Object.hasOwn(SHIPPING_ADDRESS_REQUIRED_MESSAGES, field));
    expect(names).toContain("shippingAddressId");
    expect(names).toContain("makeDefault");
    for (const field of names) {
      app.fail(rejection(field));
      await app.submit("update", rows[1].shipping_address_id);
      expect(screen.getByRole("alert").querySelector("a")).toBeNull();
      expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    }
  });

  it.each([
    { code: "shipping_address_undeliverable", status: 400 },
    { code: "address_standardization_suggested", status: 409 },
    { code: "conflict", status: 409 },
    { code: "not_found", status: 404 },
    { code: "validation_error", status: 422 },
  ])("row fallback: $code stays form-only without raw prose", async ({ code, status }) => {
    const app = await routed();
    app.fail({ error: { code, message: marker } }, status);
    await app.submit("update", rows[1].shipping_address_id);
    expect(screen.getByRole("alert").querySelector("a")).toBeNull();
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(marker);
    expect(app.logs.flatMap((log) => log.mock.calls)).toEqual([]);
  });

  it("focus lifecycle: committed ARIA, one focus per identical result, no revalidation refocus, clear on accepted submit/success/navigation", async () => {
    const app = await routed();
    const observations: string[] = [];
    const focus = (event: FocusEvent) => {
      if ((event.target as HTMLElement).getAttribute("role") !== "alert") return;
      observations.push(expectLinkedField("name").input.getAttribute("aria-invalid")!);
    };
    document.addEventListener("focusin", focus);
    try {
      await app.submit("create");
      expect(observations).toEqual(["true"]);
      expect(document.activeElement).toBe(screen.getByRole("alert"));
      const { input } = expectLinkedField("name");
      input.focus();
      await app.revalidate();
      expect(document.activeElement).toBe(input);
      expect(observations).toHaveLength(1);
      const button = screen.getByRole("button", { name: "Save address" });
      button.focus();
      fireEvent.submit(button.closest("form")!);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(document.activeElement).toBe(button);
      await app.submit("create");
      expect(observations).toEqual(["true", "true"]);
      app.fail({ id: rows[0].shipping_address_id, version: 1, status: "accepted" }, 200);
      await app.submit("create");
      expect(screen.queryByRole("alert")).toBeNull();
      app.fail(rejection());
      await app.submit("create");
      await act(async () => {
        await app.router.navigate("/elsewhere");
      });
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      document.removeEventListener("focusin", focus);
    }
  });

  it("focus lifecycle: update reopens only the submitted sheet and closure/method switch clears old errors", async () => {
    const app = await routed();
    await app.submit("update", rows[1].shipping_address_id);
    const { summary } = expectLinkedField("name");
    expect(document.activeElement).toBe(summary);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await app.revalidate();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Update address" })[0]);
    expect(screen.queryByRole("alert")).toBeNull();
    await app.submit("create");
    expectLinkedField("name");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["create", "update", "default", "archive"])(
    "mutation parity: %s retains its redirect and one write",
    async (intent) => {
      const app = await routed();
      app.fail({ id: rows[0].shipping_address_id, version: 1, status: "accepted" }, 200);
      await app.submit(intent, intent === "create" ? undefined : rows[1].shipping_address_id);
      expect(app.router.state.location.pathname).toBe(path);
      expect(app.writes).toHaveLength(1);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(app.logs.flatMap((log) => log.mock.calls)).toEqual([]);
    },
  );
});
