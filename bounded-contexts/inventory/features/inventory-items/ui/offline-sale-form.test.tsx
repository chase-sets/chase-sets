// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useActionData } from "react-router";
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function renderOfflineSaleForm(
  props: Omit<Parameters<typeof OfflineSaleForm>[0], "initialIdempotencyKey" | "canHonorOffline"> & {
    initialIdempotencyKey?: string;
    canHonorOffline?: boolean;
  },
) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <OfflineSaleForm
            initialIdempotencyKey={props.initialIdempotencyKey ?? "sale-token"}
            canHonorOffline={props.canHonorOffline ?? false}
            {...props}
          />
        ),
      },
    ],
    { initialEntries: ["/"] },
  );

  return render(<RouterProvider router={router} />);
}

function OfflineSaleFormActionRoute() {
  const actionData = useActionData() as { error?: string } | undefined;
  return (
    <OfflineSaleForm
      initialIdempotencyKey="sale-token"
      canHonorOffline={false}
      itemId="inv_1"
      errorMessage={actionData?.error ?? null}
    />
  );
}

function renderOfflineSaleActionRoute(action: (formData: FormData) => Promise<unknown>) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <OfflineSaleFormActionRoute />,
        action: async ({ request }) => action(await request.formData()),
      },
    ],
    { initialEntries: ["/"] },
  );

  return render(<RouterProvider router={router} />);
}

describe("OfflineSaleForm", () => {
  it("keeps the landed request vocabulary to quantity, per-unit price, channel, note, collision controls, and token", () => {
    renderOfflineSaleForm({ canHonorOffline: true });

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
    renderOfflineSaleForm({ canHonorOffline: true });

    expect(document.querySelector('input[name="confirmSellerCannotFulfill"]')).toBeNull();
    fireEvent.change(screen.getByLabelText("Order commitments"), { target: { value: "honor-offline" } });
    expect((screen.getByLabelText(/I understand that affected orders/) as HTMLInputElement).required).toBe(true);
  });

  it("does not expose honor-offline controls to a normal inventory manager", () => {
    renderOfflineSaleForm({ canHonorOffline: false });

    expect(document.querySelector('select[name="collisionMode"]')).toBeNull();
    expect(document.querySelector('input[name="collisionMode"][value="protect-orders"]')).not.toBeNull();
    expect(document.querySelector('input[name="confirmSellerCannotFulfill"]')).toBeNull();
  });

  it("keeps the keyboard sequence on sale fields before conditional controls and submit", () => {
    renderOfflineSaleForm({ canHonorOffline: true });

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

  it.each([
    {
      outcome: "full",
      state: "fresh" as const,
      result: { ...partialResult, requestedQuantity: 2, appliedQuantity: 2, refusedQuantity: 0, collision: null },
      expected: "Completed: 2 units recorded as sold. Authoritative available quantity: 5.",
      verification: null,
      role: "status",
    },
    {
      outcome: "full",
      state: "pending" as const,
      result: { ...partialResult, requestedQuantity: 2, appliedQuantity: 2, refusedQuantity: 0, collision: null },
      expected: null,
      verification: "Verifying the recorded sale",
      role: "alert",
    },
    {
      outcome: "full",
      state: "unverified" as const,
      result: { ...partialResult, requestedQuantity: 2, appliedQuantity: 2, refusedQuantity: 0, collision: null },
      expected: null,
      verification: "could not be verified",
      role: "alert",
    },
    {
      outcome: "partial",
      state: "fresh" as const,
      result: partialResult,
      expected: "Recorded 2 units. 1 units were not recorded.",
      verification: null,
      role: "alert",
    },
    {
      outcome: "partial",
      state: "pending" as const,
      result: partialResult,
      expected: "Recorded 2 units. 1 units were not recorded.",
      verification: "Verifying the recorded sale",
      role: "alert",
    },
    {
      outcome: "partial",
      state: "unverified" as const,
      result: partialResult,
      expected: "Recorded 2 units. 1 units were not recorded.",
      verification: "could not be verified",
      role: "alert",
    },
    {
      outcome: "refused",
      state: "fresh" as const,
      result: { ...partialResult, appliedQuantity: 0, refusedQuantity: 3 },
      expected: "No units were recorded. 3 units were refused.",
      verification: null,
      role: "alert",
    },
    {
      outcome: "refused",
      state: "pending" as const,
      result: { ...partialResult, appliedQuantity: 0, refusedQuantity: 3 },
      expected: "No units were recorded. 3 units were refused.",
      verification: "Verifying the recorded sale",
      role: "alert",
    },
    {
      outcome: "refused",
      state: "unverified" as const,
      result: { ...partialResult, appliedQuantity: 0, refusedQuantity: 3 },
      expected: "No units were recorded. 3 units were refused.",
      verification: "could not be verified",
      role: "alert",
    },
  ])("renders $outcome facts with $state freshness ownership", ({ state, result, expected, verification, role }) => {
    render(<OfflineSaleResult result={result} authoritativeAvailableQuantity={5} verificationState={state} />);

    const announcement = screen.getByRole(role);
    if (expected) {
      expect(announcement.textContent).toContain(expected);
    } else {
      expect(announcement.textContent).not.toContain("Completed:");
    }
    if (verification) {
      expect(announcement.textContent).toContain(verification);
    }
    if (state !== "fresh") {
      expect(announcement.textContent).not.toContain("Authoritative available quantity");
    }
    expect(document.activeElement).toBe(announcement);
    expect(screen.queryAllByRole("link", { name: "View affected order ord_1" })).toHaveLength(result.collision ? 1 : 0);
  });

  it("keeps one idempotency token and every submitted value through retryable and changed-field conflicts", async () => {
    const user = userEvent.setup();
    const attempts: Record<string, string>[] = [];
    renderOfflineSaleActionRoute(async (formData) => {
      attempts.push(Object.fromEntries([...formData.entries()].map(([key, value]) => [key, String(value)])));
      return {
        error: attempts.length === 1 ? "Retry this sale." : "This token already records different sale details.",
      };
    });

    await user.type(screen.getByLabelText(/Quantity sold/), "2");
    await user.type(screen.getByLabelText(/Sale price per item/), "12.50");
    await user.selectOptions(screen.getByLabelText(/Sale channel/), "card-show");
    await user.type(screen.getByLabelText(/Note/), "Saturday table");
    await user.click(screen.getByRole("button", { name: "Record sale" }));
    await screen.findByRole("alert");

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      idempotencyKey: "sale-token",
      quantity: "2",
      salePriceAmount: "12.5",
      note: "Saturday table",
    });
    expect((screen.getByLabelText(/Note/) as HTMLTextAreaElement).value).toBe("Saturday table");

    await user.selectOptions(screen.getByLabelText(/Sale channel/), "other");
    await user.click(screen.getByRole("button", { name: "Record sale" }));
    await waitFor(() => expect(attempts).toHaveLength(2));

    expect(attempts[1]).toMatchObject({
      idempotencyKey: "sale-token",
      channel: "other",
      quantity: "2",
      salePriceAmount: "12.5",
    });
    expect(screen.getByText("This token already records different sale details.")).toBeTruthy();
  });

  it("disables a pending route-aware submission so a double submit reaches one logical sale", async () => {
    const user = userEvent.setup();
    const actionResult = deferred<unknown>();
    let calls = 0;
    renderOfflineSaleActionRoute(async () => {
      calls += 1;
      return await actionResult.promise;
    });

    await user.type(screen.getByLabelText(/Quantity sold/), "2");
    await user.selectOptions(screen.getByLabelText(/Sale channel/), "card-show");
    const form = document.querySelector("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(calls).toBe(1));
    expect((screen.getByRole("button", { name: "Record sale" }) as HTMLButtonElement).disabled).toBe(true);
    actionResult.resolve({ error: "Retry this sale." });
    await screen.findByRole("alert");
  });
});
