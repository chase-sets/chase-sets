// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, HiddenInput } from "@chase-sets/design-system";
import { InventoryMutationForm, InventoryMutationProvider } from "../support/request-support/mutation-form";
import { createInventoryMutationRecovery } from "../support/request-support/mutation-recovery";
import { inventoryApi } from "../client";

vi.mock("../client", () => ({ inventoryApi: { getMutationAttempt: vi.fn(async () => null) } }));
const authority = { accountId: "acc_browser", actorUserId: "usr_browser" };
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function view(actor = authority, submit = vi.fn()) {
  return render(
    <InventoryMutationProvider authority={actor} key={`${actor.accountId}/${actor.actorUserId}`}>
      <InventoryMutationForm family="item-create" targetId="draft" method="post" onSubmit={submit}>
        <HiddenInput name="intent" value="create-item" />
        <Button type="submit">Create item</Button>
      </InventoryMutationForm>
    </InventoryMutationProvider>,
  );
}
describe("issue-7169-c1-boundary-recovery: AC9/10/11/13 real form", () => {
  it("persists only bounded metadata before the real form sends its caller attempt", async () => {
    const submit = vi.fn();
    const rendered = view(authority, submit);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Create item" }) as HTMLButtonElement).disabled).toBe(false),
    );
    const form = rendered.container.querySelector("form")!;
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submit).toHaveBeenCalledTimes(1);
    const attempt = new FormData(form).get("inventoryMutationAttemptId");
    expect(attempt).toMatch(/^[a-f0-9-]{36}$/);
    const encoded = sessionStorage.getItem("inventory-mutation/v1:acc_browser:item-create")!;
    expect(JSON.parse(encoded)).toMatchObject({
      attemptId: attempt,
      ...authority,
      family: "item-create",
      targetId: "draft",
    });
    expect(Object.keys(JSON.parse(encoded))).toHaveLength(7);
  });
  it("restores through the private reader without submitting and disables an ambiguous form", async () => {
    const send = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", send);
    const controller = createInventoryMutationRecovery(authority, "item-create", sessionStorage);
    const id = controller.begin("draft");
    const submit = vi.fn();
    const rendered = view(authority, submit);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("uncertain"));
    expect(inventoryApi.getMutationAttempt).toHaveBeenCalledWith(id);
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create item" }).matches(":disabled")).toBe(true);
    act(() => {
      rendered.container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("status"));
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });
  it("does not read or submit another acting User's saved attempt", async () => {
    createInventoryMutationRecovery(authority, "item-create", sessionStorage).begin("draft");
    view({ ...authority, actorUserId: "usr_other" });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("original account"));
    expect(inventoryApi.getMutationAttempt).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create item" }).matches(":disabled")).toBe(true);
  });
});
