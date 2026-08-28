// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { InventoryOfflineSaleResult } from "../../../client";
import { OfflineSaleForm, OfflineSaleResult, offlineSaleRequestFromForm } from "./offline-sale-form";

afterEach(() => cleanup());

const partialResult: InventoryOfflineSaleResult = {
  itemId: "inv_1",
  version: 4,
  requestedQuantity: 3,
  appliedQuantity: 2,
  refusedQuantity: 1,
  collision: {
    mode: "protect-orders",
    authorizedByRole: null,
    requestedQuantity: 3,
    appliedQuantity: 2,
    refusedQuantity: 1,
    heldQuantity: 1,
    availableQuantity: 2,
    releasedHoldQuantity: 0,
    affectedOrders: [
      { holdId: "hld_1", orderId: "ord_1", reservationRequestId: "rsv_1", quantity: 1, disposition: "protected" },
    ],
  },
};

describe("OfflineSaleForm", () => {
  it("keeps the landed request vocabulary to quantity, per-unit price, channel, note, collision controls, and token", () => {
    render(<OfflineSaleForm initialIdempotencyKey="sale-token" canHonorOffline={true} />);

    const form = document.querySelector('form[method="post"]');
    expect(form?.querySelector('input[name="intent"][value="record-offline-sale"]')).not.toBeNull();
    expect(form?.querySelector('input[name="idempotencyKey"][value="sale-token"]')).not.toBeNull();
    expect(form?.querySelector('input[name="quantity"]')?.getAttribute("min")).toBe("1");
    expect(form?.querySelector('input[name="salePriceAmount"]')).not.toBeNull();
    expect(form?.querySelector('select[name="channel"]')).not.toBeNull();
    expect(form?.querySelector('textarea[name="note"]')).not.toBeNull();
    expect(form?.querySelector('input[name="soldAt"], input[name="currencyCode"]')).toBeNull();
    expect(form?.querySelector('select[name="collisionMode"]')).not.toBeNull();
  });

  it("shows confirmation only after an honor-offline actor selects that mode", () => {
    render(<OfflineSaleForm initialIdempotencyKey="sale-token" canHonorOffline={true} />);

    expect(document.querySelector('input[name="confirmSellerCannotFulfill"]')).toBeNull();
    fireEvent.change(screen.getByLabelText("Order commitments"), { target: { value: "honor-offline" } });
    expect((screen.getByLabelText(/I understand that affected orders/) as HTMLInputElement).required).toBe(true);
  });

  it("does not expose honor-offline controls to a normal inventory manager", () => {
    render(<OfflineSaleForm initialIdempotencyKey="sale-token" canHonorOffline={false} />);

    expect(document.querySelector('select[name="collisionMode"]')).toBeNull();
    expect(document.querySelector('input[name="collisionMode"][value="protect-orders"]')).not.toBeNull();
    expect(document.querySelector('input[name="confirmSellerCannotFulfill"]')).toBeNull();
  });

  it("keeps the keyboard sequence on sale fields before conditional controls and submit", () => {
    render(<OfflineSaleForm initialIdempotencyKey="sale-token" canHonorOffline={true} />);

    const form = document.querySelector("form")!;
    const namedControls = [...form.querySelectorAll("input[name], select[name], textarea[name], button[type=submit]")]
      .filter((control) => (control as HTMLInputElement).type !== "hidden")
      .map((control) => control.getAttribute("name") ?? control.textContent?.trim());

    expect(namedControls).toEqual(["quantity", "salePriceAmount", "channel", "note", "collisionMode", "Record sale"]);
  });

  it("adapts blank optional values to the landed null shape without inventing fields", () => {
    const formData = new FormData();
    formData.set("quantity", "2");
    formData.set("channel", "card-show");
    formData.set("idempotencyKey", "sale-token");

    expect(offlineSaleRequestFromForm(formData)).toEqual({
      quantity: 2,
      salePriceAmount: null,
      channel: "card-show",
      note: null,
      collisionMode: "protect-orders",
      confirmSellerCannotFulfill: false,
      idempotencyKey: "sale-token",
    });
  });

  it("renders partial and refused outcomes without completed wording and links every affected order", () => {
    const { rerender } = render(<OfflineSaleResult result={partialResult} authoritativeAvailableQuantity={5} />);

    expect(screen.getByRole("alert").textContent).toContain("Recorded 2 units. 1 units were not recorded.");
    expect(screen.getByRole("link", { name: "View affected order ord_1" }).getAttribute("href")).toBe(
      "/account/sales/ord_1",
    );
    expect(screen.queryByText(/Completed:/)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("alert"));

    rerender(<OfflineSaleResult result={{ ...partialResult, appliedQuantity: 0, refusedQuantity: 3 }} />);
    expect(screen.getByRole("alert").textContent).toContain("No units were recorded. 3 units were refused.");
    expect(screen.queryByText(/Completed:/)).toBeNull();
  });
});
