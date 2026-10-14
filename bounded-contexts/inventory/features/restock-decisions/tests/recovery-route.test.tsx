// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLoaderData } from "react-router";
import MarketplaceInventoryRestockDecisionsRoute from "../../../routes/marketplace/account-inventory-restock-decisions";

vi.mock("react-router", async (original) => ({
  ...(await original<typeof import("react-router")>()),
  useLoaderData: vi.fn(),
  useActionData: () => null,
}));
vi.mock("../../../client", () => ({ inventoryApi: { getMutationAttempt: vi.fn(async () => null) } }));

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
});

it("the real restock route mounts authenticated recovery authority before enabling either outcome", async () => {
  const recoveryAuthority = { accountId: "acc_c2_route", actorUserId: "usr_c2_route" };
  vi.mocked(useLoaderData).mockReturnValue({
    recoveryAuthority,
    decisions: {
      items: [{ decision_id: "rstk_c2_route", version: 1, item_title: "Synthetic return", quantity: 2 }],
      total: 1,
    },
  });
  const view = render(<MarketplaceInventoryRestockDecisionsRoute />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Restock" }).matches(":disabled")).toBe(false));
  expect(screen.getByRole("button", { name: "Write off" }).matches(":disabled")).toBe(false);
  act(() => {
    view.container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(JSON.parse(sessionStorage.getItem("inventory-mutation/v1:acc_c2_route:restock-record")!)).toMatchObject({
    ...recoveryAuthority,
    family: "restock-record",
    targetId: "rstk_c2_route",
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Write off" }).matches(":disabled")).toBe(true));
});
