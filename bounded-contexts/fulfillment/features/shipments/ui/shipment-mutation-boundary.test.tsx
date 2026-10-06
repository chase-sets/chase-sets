// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import { renderToString } from "react-dom/server";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShipmentMutationBoundary } from "./shipment-mutation-boundary";
import * as recovery from "./mutation-recovery";
import type { ShipmentMutationRecoveryDescriptor } from "./mutation-recovery";
import type { FulfillmentShipmentDetail } from "./contracts";
import ShipmentsRoute from "../../../routes/marketplace/account-sale-shipments";
import ShipmentRoute from "../../../routes/marketplace/account-sale-shipment";
import PackingRoute from "../../../routes/marketplace/account-sale-shipment-packing";
import { buildFulfillmentCommandCenter } from "./command-center-route-adapter";

const submit = vi.hoisted(() => vi.fn<(data: FormData, options: unknown) => Promise<void>>(async () => undefined));
const loaderData = vi.hoisted(() => vi.fn());
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useSubmit: () => submit,
  useLoaderData: loaderData,
  useActionData: () => undefined,
}));
vi.mock("./mutation-recovery", () => ({
  listShipmentMutationDescriptors: vi.fn(),
  persistShipmentMutationDescriptor: vi.fn(),
  updateShipmentMutationDescriptor: vi.fn(),
  completeShipmentMutationDescriptor: vi.fn(),
  hashShipmentMutationIntent: vi.fn(async () => "intent-hash"),
}));

const descriptor: ShipmentMutationRecoveryDescriptor = {
  schemaVersion: 1,
  tenantId: "tnt_test",
  sellerAccountId: "acc_seller",
  shipmentId: "shp_test",
  command: "dispatch-shipment",
  target: null,
  intentHash: "intent-hash",
  mutationAttemptId: "018f47d2-9d2a-4d68-8f33-6fb718c3f001",
  createdAt: "2026-10-06T00:00:00.000Z",
  lastObservedAt: "2026-10-06T00:00:00.000Z",
  state: "confirming",
  sentAt: "2026-10-06T00:00:00.000Z",
  automaticRecoveryReadAt: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function page() {
  return (
    <ShipmentMutationBoundary tenantId="tnt_test" sellerAccountId="acc_seller" defaultShipmentId="shp_test">
      <a href="/account/sales">Sales</a>
      <form method="post">
        <button type="submit" name="intent" value="dispatch-shipment">
          Dispatch
        </button>
      </form>
    </ShipmentMutationBoundary>
  );
}

function retainDescriptorUpdates(initial: ShipmentMutationRecoveryDescriptor[] = []) {
  let stored = initial;
  vi.mocked(recovery.listShipmentMutationDescriptors).mockImplementation(async () => stored);
  vi.mocked(recovery.updateShipmentMutationDescriptor).mockImplementation(async (value, patch) => {
    const updated = { ...value, ...patch };
    stored = [...stored.filter((entry) => entry.mutationAttemptId !== value.mutationAttemptId), updated];
    return updated;
  });
}

function shipment(): FulfillmentShipmentDetail {
  return {
    shipment_id: "shp_test",
    order_id: "ord_test",
    display_reference: "SHP-TEST",
    buyer_account_id: "acc_buyer",
    buyer_display_name: "Buyer",
    seller_account_id: "acc_seller",
    seller_display_name: "Seller",
    shipping_option: "standard",
    shipping_plan_snapshot: null,
    shipping_destination_snapshot: {
      name: "Buyer",
      company: null,
      line1: "2 Market St",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: null,
      email: null,
    },
    shipping_origin_snapshot: null,
    shipping_method: null,
    carrier_name: null,
    label_reference: null,
    label_document_url: null,
    tracking_identifier: null,
    postage_provider_name: null,
    postage_provider_mode: null,
    postage_provider_shipment_id: null,
    postage_provider_label_id: null,
    postage_rate_id: null,
    postage_service_level: null,
    postage_amount_cents: null,
    postage_currency: null,
    label_status: "not-purchased",
    label_error_code: null,
    label_error_message: null,
    label_refund_status: null,
    label_refund_reference: null,
    status: "packing",
    package_status: "packing",
    package_count: null,
    current_exception_type: null,
    current_exception_notes: null,
    created_at: "2026-10-06T00:00:00.000Z",
    updated_at: "2026-10-06T00:00:00.000Z",
    packing_started_at: "2026-10-06T00:00:00.000Z",
    package_prepared_at: null,
    label_attached_at: null,
    label_voided_at: null,
    cancelled_at: null,
    dispatched_at: null,
    delivered_at: null,
    returned_at: null,
    exception_raised_at: null,
    line_count: 1,
    total_quantity: 2,
    lines: [
      {
        line_id: "spl_test",
        order_line_id: "oli_test",
        catalog_catalog_item_id: "cat_test",
        product_id: "cat_test::",
        item_title: "Charizard",
        item_subtitle: null,
        product_summary: null,
        quantity: 2,
        packing_confirmed_quantity: 2,
        packing_confirmed_at: "2026-10-06T00:00:00.000Z",
      },
    ],
    conflicts: [],
    exceptions: [],
    address_override_audits: [],
    postage_label_operations: [],
    postage_provider_events: [],
  };
}

function routePage(Route: typeof ShipmentsRoute | typeof ShipmentRoute | typeof PackingRoute) {
  const value = shipment();
  loaderData.mockReturnValue({
    shipment: value,
    recoveryScope: { tenantId: "tnt_test", sellerAccountId: "acc_seller" },
    commandCenter: buildFulfillmentCommandCenter([{ ...value, status: "awaiting-label" }]),
  });
  return <Route />;
}

function assertFenced(container: HTMLElement) {
  const controls = [...container.querySelectorAll("button, input, select, textarea")];
  expect(controls.length).toBeGreaterThan(0);
  expect(controls.every((control) => control.matches(":disabled"))).toBe(true);
  const links = [...container.querySelectorAll("a[href]")];
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(link.closest("[inert], [aria-disabled=true]")).toBeNull();
    expect(link.getAttribute("tabindex")).not.toBe("-1");
  }
  for (const link of container.querySelectorAll<HTMLAnchorElement>('a[target="_blank"][href*="packing-slips"]')) {
    const url = new URL(link.href);
    expect(url.pathname).toBe("/account/sales/shipments/packing-slips");
    expect(url.searchParams.getAll("shipmentIds")).toEqual(["shp_test"]);
    expect(url.searchParams.getAll("format")).toEqual(["letter"]);
  }
}

describe("ShipmentMutationBoundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("crypto", webcrypto);
    vi.mocked(recovery.listShipmentMutationDescriptors).mockResolvedValue([]);
    vi.mocked(recovery.persistShipmentMutationDescriptor).mockResolvedValue(descriptor);
    vi.mocked(recovery.updateShipmentMutationDescriptor).mockImplementation(async (value, patch) => ({
      ...value,
      ...patch,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "succeeded" }))),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("server-renders neutral preparation, disabled mutations and usable read links", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(page());
    expect(container.textContent).toContain("Preparing shipment actions");
    expect(container.textContent).not.toContain("Secure recovery");
    expect(container.querySelector("button")?.matches(":disabled")).toBe(true);
    expect(container.querySelector("fieldset")?.classList.contains("min-w-0")).toBe(true);
    expect(container.querySelector("a")?.closest("[inert], [aria-disabled=true]")).toBeNull();
  });

  it("keeps mutations fenced while asynchronous recovery discovery is pending", async () => {
    const discovery = deferred<ShipmentMutationRecoveryDescriptor[]>();
    vi.mocked(recovery.listShipmentMutationDescriptors).mockReturnValue(discovery.promise);
    render(page());
    const button = screen.getByRole("button", { name: "Dispatch" });
    expect(button.matches(":disabled")).toBe(true);
    await userEvent.click(button);
    expect(recovery.persistShipmentMutationDescriptor).not.toHaveBeenCalled();
    await act(async () => discovery.resolve([]));
    expect(button.matches(":disabled")).toBe(false);
    expect(screen.queryByText("Preparing shipment actions")).toBeNull();
  });

  it.each(["ambiguous", "partial", "reauthentication-required", "confirming", "provider-pending"] as const)(
    "enables retained read-once %s without a notice or read and permits explicit same-attempt retry",
    async (state) => {
      const retained = { ...descriptor, state, automaticRecoveryReadAt: descriptor.sentAt };
      vi.mocked(recovery.listShipmentMutationDescriptors).mockResolvedValue([retained]);
      vi.mocked(recovery.persistShipmentMutationDescriptor).mockResolvedValue(retained);
      render(page());
      await waitFor(() => expect(screen.queryByText("Preparing shipment actions")).toBeNull());
      const button = screen.getByRole("button", { name: "Dispatch" });
      expect(button.matches(":disabled")).toBe(false);
      expect(screen.queryByText("Shipment action recovery")).toBeNull();
      const link = screen.getByRole("link", { name: "Sales" });
      expect(link.closest("[inert], [aria-disabled=true]")).toBeNull();
      expect(link.getAttribute("tabindex")).not.toBe("-1");
      expect(link.getAttribute("href")).toBe("/account/sales");
      expect(fetch).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      await userEvent.click(button);
      await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
      expect(submit.mock.calls[0]![0].get("mutationAttemptId")).toBe(retained.mutationAttemptId);
    },
  );

  it("enables a never-sent descriptor without a recovery read or notice", async () => {
    vi.mocked(recovery.listShipmentMutationDescriptors).mockResolvedValue([
      { ...descriptor, state: "submitting", sentAt: null },
    ]);
    render(page());
    await waitFor(() => expect(screen.queryByText("Preparing shipment actions")).toBeNull());
    expect(screen.getByRole("button", { name: "Dispatch" }).matches(":disabled")).toBe(false);
    expect(screen.queryByText("Shipment action recovery")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    ["provider-pending", true],
    ["unchanged", false],
  ] as const)(
    "handles post-submit %s in-session and enables its read-once descriptor on reload",
    async (state, fenced) => {
      retainDescriptorUpdates();
      vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ status: state })));
      const first = render(page());
      const button = screen.getByRole("button", { name: "Dispatch" });
      await waitFor(() => expect(button.matches(":disabled")).toBe(false));
      await userEvent.click(button);
      await waitFor(() => expect(screen.getByText(new RegExp(state))).toBeTruthy());
      expect(button.matches(":disabled")).toBe(fenced);
      expect(
        screen.getByText("Shipment action recovery").parentElement?.parentElement?.classList.contains("bg-info-soft"),
      ).toBe(true);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(recovery.completeShipmentMutationDescriptor).not.toHaveBeenCalled();
      expect(recovery.updateShipmentMutationDescriptor).toHaveBeenLastCalledWith(
        expect.objectContaining({ automaticRecoveryReadAt: expect.any(String) }),
        { state },
      );
      first.unmount();
      submit.mockClear();
      render(page());
      await waitFor(() => expect(screen.queryByText("Preparing shipment actions")).toBeNull());
      expect(screen.getByRole("button", { name: "Dispatch" }).matches(":disabled")).toBe(false);
      expect(screen.queryByText("Shipment action recovery")).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
      expect(recovery.completeShipmentMutationDescriptor).not.toHaveBeenCalled();
    },
  );

  it("fences a live sent-unread ambiguous discovery with warning, then enables on reload without replay", async () => {
    retainDescriptorUpdates([{ ...descriptor, state: "submitting" }]);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ status: "ambiguous" })));
    const first = render(page());
    await waitFor(() => expect(screen.getByText(/ambiguous/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Dispatch" }).matches(":disabled")).toBe(true);
    expect(
      screen.getByText("Shipment action recovery").parentElement?.parentElement?.classList.contains("bg-warning-soft"),
    ).toBe(true);
    first.unmount();
    render(page());
    await waitFor(() => expect(screen.queryByText("Preparing shipment actions")).toBeNull());
    expect(screen.getByRole("button", { name: "Dispatch" }).matches(":disabled")).toBe(false);
    expect(screen.queryByText("Shipment action recovery")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(["discovery", "post-submit"] as const)("fences a null live %s read as confirming", async (path) => {
    if (path === "discovery") {
      vi.mocked(recovery.listShipmentMutationDescriptors).mockResolvedValue([{ ...descriptor, state: "submitting" }]);
    }
    vi.mocked(fetch).mockRejectedValue(new Error("transport unavailable"));
    render(page());
    if (path === "post-submit") {
      await waitFor(() => expect(screen.getByRole("button", { name: "Dispatch" }).matches(":disabled")).toBe(false));
      await userEvent.click(screen.getByRole("button", { name: "Dispatch" }));
    }
    await waitFor(() => expect(screen.getByText(/Recovery state: confirming/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Dispatch" }).matches(":disabled")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(path === "discovery" ? 0 : 1);
  });

  describe.each([
    ["shipment list", ShipmentsRoute],
    ["shipment detail", ShipmentRoute],
    ["packing", PackingRoute],
  ] as const)("mounted %s caller", (_name, Route) => {
    it("server-renders and mounts a fenced preparation state with active links", async () => {
      const discovery = deferred<ShipmentMutationRecoveryDescriptor[]>();
      vi.mocked(recovery.listShipmentMutationDescriptors).mockReturnValue(discovery.promise);
      const container = document.createElement("div");
      container.innerHTML = renderToString(routePage(Route));
      assertFenced(container);
      expect(container.textContent).toContain("Preparing shipment actions");
      expect(container.textContent).not.toContain("Secure recovery storage");
      const mounted = render(routePage(Route));
      assertFenced(mounted.container);
      for (const button of mounted.container.querySelectorAll<HTMLButtonElement>("button")) button.click();
      expect(submit).not.toHaveBeenCalled();
      expect(recovery.persistShipmentMutationDescriptor).not.toHaveBeenCalled();
      await act(async () => discovery.resolve([]));
      expect(mounted.container.querySelector("fieldset[disabled]")).toBeNull();
    });

    it.each([
      ["ambiguous", "warning"],
      ["partial", "warning"],
      ["reauthentication-required", "info"],
      ["provider-pending", "info"],
      ["confirming", "info"],
    ] as const)("fences %s discovered asynchronously, preserves %s, and does not replay", async (state, tone) => {
      const response = deferred<Response>();
      vi.mocked(recovery.listShipmentMutationDescriptors).mockResolvedValue([descriptor]);
      vi.mocked(fetch).mockReturnValue(response.promise);
      const { container } = render(routePage(Route));
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      assertFenced(container);
      await act(async () =>
        response.resolve(
          new Response(JSON.stringify({ status: state }), {
            status: state === "reauthentication-required" ? 401 : 200,
          }),
        ),
      );
      await waitFor(() => expect(screen.getByText(new RegExp(state))).toBeTruthy());
      assertFenced(container);
      const notice = screen.getByText("Shipment action recovery").parentElement?.parentElement;
      expect(notice?.classList.contains(`bg-${tone}-soft`)).toBe(true);
      for (const button of container.querySelectorAll<HTMLButtonElement>("button")) button.click();
      expect(submit).not.toHaveBeenCalled();
      expect(recovery.persistShipmentMutationDescriptor).not.toHaveBeenCalled();
      expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    });

    it("keeps storage rejection dangerous and fenced, then restores editing on a clean reload", async () => {
      vi.mocked(recovery.listShipmentMutationDescriptors).mockRejectedValueOnce(new Error("storage unavailable"));
      const first = render(routePage(Route));
      await waitFor(() => expect(screen.getByText("Secure shipment recovery required")).toBeTruthy());
      assertFenced(first.container);
      expect(
        screen
          .getByText("Secure shipment recovery required")
          .parentElement?.parentElement?.classList.contains("bg-danger-soft"),
      ).toBe(true);
      first.unmount();
      const second = render(routePage(Route));
      await waitFor(() => expect(screen.queryByText("Preparing shipment actions")).toBeNull());
      expect(second.container.querySelector("fieldset[disabled]")).toBeNull();
      expect(submit).not.toHaveBeenCalled();
    });
  });

  it.each(["succeeded", "failed-safe", "conflict"] as const)(
    "restores steady editing after %s without replay",
    async (state) => {
      vi.mocked(recovery.listShipmentMutationDescriptors).mockResolvedValue([descriptor]);
      vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ status: state })));
      render(page());
      await waitFor(() => expect(screen.getByRole("button", { name: "Dispatch" }).matches(":disabled")).toBe(false));
      expect(recovery.completeShipmentMutationDescriptor).toHaveBeenCalledWith(
        expect.objectContaining({ mutationAttemptId: descriptor.mutationAttemptId }),
        state,
      );
      expect(submit).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Dispatch" }));
      await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    },
  );

  it("does not let a resolved sibling erase an outstanding recovery fence", async () => {
    vi.mocked(recovery.listShipmentMutationDescriptors).mockResolvedValue([
      { ...descriptor, state: "submitting", automaticRecoveryReadAt: null },
      { ...descriptor, shipmentId: "shp_second", state: "succeeded" },
    ]);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ status: "ambiguous" })));
    render(page());
    await waitFor(() => expect(screen.getByText(/ambiguous/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Dispatch" }).matches(":disabled")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects a wrong-shipment anchor with every fence and other URL field unchanged", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(routePage(PackingRoute));
    assertFenced(container);
    const link = container.querySelector<HTMLAnchorElement>('a[href*="packing-slips"]')!;
    const wrongTarget = new URL(link.href);
    wrongTarget.searchParams.set("shipmentIds", "shp_wrong");
    link.href = wrongTarget.href;
    expect(() => assertFenced(container)).toThrow();
  });

  it("rejects a bypassed native fence with the caller and discovery state unchanged", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(routePage(PackingRoute));
    assertFenced(container);
    container.querySelector<HTMLFieldSetElement>("fieldset[disabled]")!.disabled = false;
    expect(() => assertFenced(container)).toThrow();
  });

  it("stores the descriptor and sent marker before submitting an enabled form", async () => {
    const persisted = deferred<ShipmentMutationRecoveryDescriptor>();
    const marked = deferred<ShipmentMutationRecoveryDescriptor>();
    vi.mocked(recovery.persistShipmentMutationDescriptor).mockReturnValue(persisted.promise);
    vi.mocked(recovery.updateShipmentMutationDescriptor).mockReturnValueOnce(marked.promise);
    render(page());
    await waitFor(() => expect(screen.getByRole("button", { name: "Dispatch" }).matches(":disabled")).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: "Dispatch" }));
    await waitFor(() => expect(recovery.persistShipmentMutationDescriptor).toHaveBeenCalledTimes(1));
    expect(submit).not.toHaveBeenCalled();
    await act(async () => persisted.resolve(descriptor));
    expect(submit).not.toHaveBeenCalled();
    await act(async () => marked.resolve(descriptor));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[0]).toBeInstanceOf(FormData);
  });

  it("never submits when descriptor persistence rejects while the form was enabled", async () => {
    vi.mocked(recovery.persistShipmentMutationDescriptor).mockRejectedValue(new Error("storage unavailable"));
    render(page());
    await waitFor(() => expect(screen.getByRole("button", { name: "Dispatch" }).matches(":disabled")).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: "Dispatch" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Dispatch" }).matches(":disabled")).toBe(true));
    expect(recovery.persistShipmentMutationDescriptor).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it("includes the enabled form-associated packing footer fields only after persistence", async () => {
    const persisted = deferred<ShipmentMutationRecoveryDescriptor>();
    vi.mocked(recovery.persistShipmentMutationDescriptor).mockReturnValue(persisted.promise);
    render(routePage(PackingRoute));
    const finish = screen.getByRole("button", { name: "Finish packing" });
    await waitFor(() => expect(finish.matches(":disabled")).toBe(false));
    expect(finish.closest("form")).toBeNull();
    expect(finish.getAttribute("form")).toBe("complete-packing-form");
    await userEvent.click(finish);
    await waitFor(() => expect(recovery.persistShipmentMutationDescriptor).toHaveBeenCalledTimes(1));
    expect(submit).not.toHaveBeenCalled();
    await act(async () => persisted.resolve(descriptor));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const data = submit.mock.calls[0]![0];
    expect(data.get("packageCount")).toBe("1");
    expect(data.get("intent")).toBe("complete-packing");
    expect(data.get("mutationAttemptId")).toBe(descriptor.mutationAttemptId);
  });

  it("fences direct quantity and scanner actions until ready, then permits explicit editing", async () => {
    const discovery = deferred<ShipmentMutationRecoveryDescriptor[]>();
    vi.mocked(recovery.listShipmentMutationDescriptors).mockReturnValue(discovery.promise);
    routePage(PackingRoute);
    const data = loaderData();
    data.shipment.lines[0].packing_confirmed_quantity = 0;
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const body = options?.body as FormData;
      return new Response(
        JSON.stringify({ lineId: "spl_test", confirmedQuantity: Number(body.get("confirmedQuantity")) }),
      );
    });
    render(<PackingRoute />);
    const increase = screen.getByRole("button", { name: "Increase packed quantity for Charizard" });
    const scan = screen.getByRole("searchbox", { name: "Scan or search" });
    await userEvent.click(increase);
    await userEvent.type(scan, "spl_test{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(recovery.persistShipmentMutationDescriptor).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => discovery.resolve([]));
    await userEvent.click(increase);
    await waitFor(() => expect(screen.getByText("1 of 2 packed")).toBeTruthy());
    await waitFor(() => expect(increase.matches(":disabled")).toBe(false));
    await userEvent.type(screen.getByRole("searchbox", { name: "Scan or search" }), "spl_test");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByText("2 of 2 packed")).toBeTruthy());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(recovery.completeShipmentMutationDescriptor).toHaveBeenCalledTimes(2);
  });
});
