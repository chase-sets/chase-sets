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
import { buildFulfillmentCommandCenter } from "../read-model/command-center";
import { resolveShipmentActionPlan } from "../domain/shipment-action";

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
    // The seller's detail read carries the plan the API resolves for a packing shipment.
    action_plan: resolveShipmentActionPlan({ status: "packing", labelStatus: "not-purchased", conflicts: [] }),
  };
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
});
