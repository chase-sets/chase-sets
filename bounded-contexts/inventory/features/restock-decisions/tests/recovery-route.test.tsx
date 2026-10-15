// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import MarketplaceInventoryRestockDecisionsRoute from "../../../routes/marketplace/account-inventory-restock-decisions";
import { inventoryApi } from "../../../client";

vi.mock("../../../client", () => ({ inventoryApi: { getMutationAttempt: vi.fn(async () => null) } }));

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
});

for (const outcome of ["Restock", "Write off"] as const) {
  it(`the real ${outcome} route uses enhanced submission and locks both outcomes while the action is held`, async () => {
    const recoveryAuthority = { accountId: "acc_c2_route", actorUserId: "usr_c2_route" };
    const data = {
      recoveryAuthority,
      decisions: {
        items: [{ decision_id: "rstk_c2_route", version: 1, item_title: "Synthetic return", quantity: 2 }],
        total: 1,
      },
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const action = vi.fn(async ({ request }: { request: Request }) => {
      const fields = await request.formData();
      await held;
      return Object.fromEntries(fields);
    });
    const router = createMemoryRouter([
      { path: "/", loader: () => data, action, Component: MarketplaceInventoryRestockDecisionsRoute },
    ]);
    const view = render(<RouterProvider router={router} />);
    try {
      await waitFor(() => expect(screen.getByRole("button", { name: "Restock" }).matches(":disabled")).toBe(false));
      expect(screen.getByRole("button", { name: "Write off" }).matches(":disabled")).toBe(false);
      act(() => {
        const button = screen.getByRole("button", { name: outcome });
        expect(
          button
            .closest("form")!
            .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: button })),
        ).toBe(false);
      });
      await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Submitting"));
      expect(screen.getByRole("button", { name: "Restock" }).matches(":disabled")).toBe(true);
      expect(JSON.parse(sessionStorage.getItem("inventory-mutation/v1:acc_c2_route:restock-record")!)).toMatchObject({
        ...recoveryAuthority,
        family: "restock-record",
        targetId: "rstk_c2_route",
      });
      await waitFor(() => expect(screen.getByRole("button", { name: "Write off" }).matches(":disabled")).toBe(true));
      act(() => {
        for (const next of view.container.querySelectorAll("form"))
          expect(next.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }))).toBe(false);
      });
      expect(action).toHaveBeenCalledTimes(1);
      vi.mocked(inventoryApi.getMutationAttempt).mockResolvedValueOnce({
        version: 1,
        family: "restock-record",
        targetId: "rstk_c2_route",
        result: { decisionId: "rstk_c2_route", version: 2 },
        completedAt: "2026-10-14T00:00:00Z",
      });
      await act(async () => {
        release();
      });
      await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
      expect(router.state.actionData?.["0"]).toMatchObject({
        decisionId: "rstk_c2_route",
        expectedVersion: "1",
        intent: outcome === "Restock" ? "restock" : "write-off",
        inventoryMutationAttemptId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      });
      await waitFor(() =>
        expect(screen.getByRole("status").textContent).toContain("original Inventory change is confirmed"),
      );
      expect(screen.getByRole("button", { name: "Restock" }).matches(":disabled")).toBe(false);
      expect(screen.getByRole("button", { name: "Write off" }).matches(":disabled")).toBe(false);
      expect(sessionStorage.length).toBe(0);
      expect(inventoryApi.getMutationAttempt).toHaveBeenCalledExactlyOnceWith(
        router.state.actionData?.["0"].inventoryMutationAttemptId,
      );
    } finally {
      release();
      router.dispose();
    }
  });
}
