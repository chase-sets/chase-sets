// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InventoryRestockDecision } from "../api/contracts";
import { RestockDecisionQueuePage } from "./restock-decision-queue-page";
import { InventoryMutationProvider } from "../../../support/request-support/mutation-form";
import { createInventoryMutationRecovery } from "../../../support/request-support/mutation-recovery";
import { inventoryApi } from "../../../client";

vi.mock("../../../client", () => ({ inventoryApi: { getMutationAttempt: vi.fn(async () => null) } }));
const authority = { accountId: "acc_c2_browser", actorUserId: "usr_c2_browser" };
const decision: InventoryRestockDecision = {
  decision_id: "rstk_c2_browser",
  version: 1,
  account_id: authority.accountId,
  order_id: "ord_c2_browser",
  item_id: "inv_c2_browser",
  item_title: "Synthetic returned stock",
  item_subtitle: null,
  product_summary: null,
  quantity: 2,
  source: "shipment-returned",
  source_ref: { orderId: "ord_c2_browser", reservationRequestId: "rsv_c2_browser" },
  shipment_id: null,
  return_reason: null,
  status: "pending",
  outcome: null,
  damage_note: null,
  pending_at: "2026-10-14T00:00:00Z",
  decided_at: null,
  updated_at: "2026-10-14T00:00:00Z",
};
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function view(actor = authority) {
  return render(
    <InventoryMutationProvider authority={actor}>
      <RestockDecisionQueuePage decisions={[decision]} />
    </InventoryMutationProvider>,
  );
}

describe("issue-7169-c2-route-isolation: AC9/10/11/13 restock form restore", () => {
  it("captures the decision version and persists one opaque attempt before native submission", async () => {
    const rendered = view();
    await waitFor(() => expect(screen.getByRole("button", { name: "Restock" }).matches(":disabled")).toBe(false));
    const form = rendered.container.querySelector("form")!;
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    const fields = new FormData(form);
    expect(fields.get("expectedVersion")).toBe("1");
    expect(fields.get("decisionId")).toBe(decision.decision_id);
    expect(fields.get("inventoryMutationAttemptId")).toMatch(/^[a-f0-9-]{36}$/);
    const metadata = sessionStorage.getItem(`inventory-mutation/v1:${authority.accountId}:restock-record`)!;
    expect(JSON.parse(metadata)).toMatchObject({
      ...authority,
      family: "restock-record",
      targetId: decision.decision_id,
      attemptId: fields.get("inventoryMutationAttemptId"),
    });
    expect(Object.keys(JSON.parse(metadata))).toHaveLength(7);
    expect(metadata).not.toContain(decision.item_title);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Submitting"));
    expect(screen.getByRole("button", { name: "Restock" }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Write off" }).matches(":disabled")).toBe(true);
    expect(inventoryApi.getMutationAttempt).not.toHaveBeenCalled();
  });

  it("restores an ambiguous decision by private read only and locks both outcomes with accessible focus", async () => {
    const send = vi.fn();
    vi.stubGlobal("fetch", send);
    const id = createInventoryMutationRecovery(authority, "restock-record", sessionStorage).begin(decision.decision_id);
    const rendered = view();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("uncertain"));
    expect(inventoryApi.getMutationAttempt).toHaveBeenCalledWith(id);
    for (const form of rendered.container.querySelectorAll("form")) {
      act(() => {
        expect(form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))).toBe(false);
      });
    }
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restock" }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Write off" }).matches(":disabled")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("status"));
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });

  it("confirms the exact retained first result, cleans local metadata and remains inert on repeated pageshow", async () => {
    const id = createInventoryMutationRecovery(authority, "restock-record", sessionStorage).begin(decision.decision_id);
    vi.mocked(inventoryApi.getMutationAttempt).mockResolvedValueOnce({
      version: 1,
      family: "restock-record",
      targetId: decision.decision_id,
      result: { decisionId: decision.decision_id, version: 2 },
      completedAt: "2026-10-14T00:00:01Z",
    });
    view();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("confirmed"));
    expect(inventoryApi.getMutationAttempt).toHaveBeenCalledWith(id);
    expect(sessionStorage.length).toBe(0);
    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    expect(inventoryApi.getMutationAttempt).toHaveBeenCalledTimes(1);
  });

  it("requires reauthentication for a changed acting User without reading or submitting", async () => {
    createInventoryMutationRecovery(authority, "restock-record", sessionStorage).begin(decision.decision_id);
    view({ ...authority, actorUserId: "usr_foreign_browser" });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Sign in"));
    expect(inventoryApi.getMutationAttempt).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restock" }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Write off" }).matches(":disabled")).toBe(true);
  });
});
