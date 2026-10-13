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
  vi.useRealTimers();
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
  it("keeps a native POST submitting without reading, offering discard or moving focus before navigation", async () => {
    const submit = vi.fn();
    const rendered = view(authority, submit);
    const button = screen.getByRole("button", { name: "Create item" });
    await waitFor(() => expect(button.matches(":disabled")).toBe(false));
    button.focus();
    const form = rendered.container.querySelector("form")!;
    vi.useFakeTimers();
    act(() => {
      expect(form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))).toBe(true);
    });
    expect(new FormData(form).get("inventoryMutationAttemptId")).toMatch(/^[a-f0-9-]{36}$/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(screen.getByRole("status").textContent).toContain("Submitting");
    expect(screen.queryByRole("button", { name: /discard/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Create item" }).matches(":disabled")).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByRole("status"));
    expect(inventoryApi.getMutationAttempt).not.toHaveBeenCalled();
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submit).toHaveBeenCalledTimes(1);
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
  it("confirms a submitted attempt only on persisted pageshow and keeps a missing result uncertain", async () => {
    let resolveRead!: (receipt: null) => void;
    vi.mocked(inventoryApi.getMutationAttempt).mockImplementationOnce(
      () => new Promise<null>((resolve) => (resolveRead = resolve)),
    );
    const submit = vi.fn();
    const rendered = view(authority, submit);
    const button = screen.getByRole("button", { name: "Create item" });
    await waitFor(() => expect(button.matches(":disabled")).toBe(false));
    const form = rendered.container.querySelector("form")!;
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    const attempt = new FormData(form).get("inventoryMutationAttemptId");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Submitting"));
    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    });
    expect(inventoryApi.getMutationAttempt).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    expect(inventoryApi.getMutationAttempt).toHaveBeenCalledExactlyOnceWith(attempt);
    expect(screen.getByRole("status").textContent).toContain("Confirming");
    expect(screen.getByRole("button", { name: "Create item" }).matches(":disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: /discard/i })).toBeNull();
    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    expect(inventoryApi.getMutationAttempt).toHaveBeenCalledTimes(1);
    await act(async () => resolveRead(null));
    expect(screen.getByRole("status").textContent).toContain("uncertain");
    expect(screen.getByRole("button", { name: /discard/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create item" }).matches(":disabled")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("status"));
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("recovers the committed result on persisted pageshow without a second submit", async () => {
    vi.mocked(inventoryApi.getMutationAttempt).mockResolvedValueOnce({
      version: 1,
      family: "item-create",
      targetId: "draft",
      result: { itemId: "inv_synthetic", version: 1 },
      completedAt: "2026-10-13T00:00:00Z",
    });
    const submit = vi.fn();
    const rendered = view(authority, submit);
    await waitFor(() => expect(screen.getByRole("button", { name: "Create item" }).matches(":disabled")).toBe(false));
    const form = rendered.container.querySelector("form")!;
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    const attempt = new FormData(form).get("inventoryMutationAttemptId");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Submitting"));
    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("confirmed"));
    expect(inventoryApi.getMutationAttempt).toHaveBeenCalledExactlyOnceWith(attempt);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("inventory-mutation/v1:acc_browser:item-create")).toBeNull();
    expect(screen.getByRole("button", { name: "Create item" }).matches(":disabled")).toBe(false);
    expect(screen.queryByRole("button", { name: /discard/i })).toBeNull();
  });
  it("removes persisted-page recovery when the provider unmounts", async () => {
    const rendered = view();
    await waitFor(() => expect(screen.getByRole("button", { name: "Create item" }).matches(":disabled")).toBe(false));
    act(() => {
      rendered.container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Submitting"));
    rendered.unmount();
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(inventoryApi.getMutationAttempt).not.toHaveBeenCalled();
  });
  it("does not read or submit another acting User's saved attempt", async () => {
    createInventoryMutationRecovery(authority, "item-create", sessionStorage).begin("draft");
    view({ ...authority, actorUserId: "usr_other" });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("original account"));
    expect(inventoryApi.getMutationAttempt).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create item" }).matches(":disabled")).toBe(true);
  });
});
