// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryMutationProvider } from "../../../support/request-support/mutation-form";
import { createInventoryMutationRecovery } from "../../../support/request-support/mutation-recovery";
import { inventoryApi } from "../../../client";
import { InventoryImportBatchPage } from "../ui/import-batch-page";

vi.mock("../../../client", () => ({ inventoryApi: { getMutationAttempt: vi.fn(async () => null) } }));
const authority = { accountId: "acc_c3_browser_synthetic", actorUserId: "usr_c3_browser_synthetic" };
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function view(actor = authority) {
  return render(
    <InventoryMutationProvider authority={actor} key={`${actor.accountId}/${actor.actorUserId}`}>
      <InventoryImportBatchPage batches={[]} storageLocations={[]} detail={null} />
    </InventoryMutationProvider>,
  );
}

describe("issue-7169-c3-upload-recovery: real upload form", () => {
  it.each(["ambiguous", "reauth-required", "different-user"])(
    "restores %s without sending or reading another actor's attempt",
    async (kind) => {
      const id = createInventoryMutationRecovery(authority, "import-create", sessionStorage).begin("draft");
      if (kind === "reauth-required") vi.mocked(inventoryApi.getMutationAttempt).mockRejectedValueOnce({ status: 401 });
      const rendered = view(kind === "different-user" ? { ...authority, actorUserId: "usr_c3_other" } : authority);
      await waitFor(() =>
        expect(screen.getByRole("status").textContent).toContain(
          kind === "ambiguous" ? "uncertain" : "original account",
        ),
      );
      const submit = screen.getByRole("button", { name: "Validate import", exact: true });
      expect(submit.matches(":disabled")).toBe(true);
      expect(document.activeElement).toBe(screen.getByRole("status"));
      expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
      if (kind === "different-user") expect(inventoryApi.getMutationAttempt).not.toHaveBeenCalled();
      else expect(inventoryApi.getMutationAttempt).toHaveBeenCalledExactlyOnceWith(id);
      const form = rendered.container.querySelector('input[name="intent"][value="create-batch"]')!.closest("form")!;
      expect(fireEvent.submit(form)).toBe(false);
      expect(sessionStorage.length).toBe(1);
      expect(JSON.stringify(sessionStorage)).not.toMatch(/csvText|sourceFilename|parsedRows/);
    },
  );

  it("restores an accepted job link and never restores file bytes or submits again", async () => {
    const id = createInventoryMutationRecovery(authority, "import-create", sessionStorage).begin("draft");
    vi.mocked(inventoryApi.getMutationAttempt).mockResolvedValueOnce({
      version: 1,
      attemptId: id,
      family: "import-create",
      targetId: "draft",
      result: { jobId: "job_c3_synthetic" },
    } as Awaited<ReturnType<typeof inventoryApi.getMutationAttempt>>);
    const rendered = view();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("confirmed"));
    expect(
      rendered.container.querySelector('a[href="/account/inventory/imports?jobId=job_c3_synthetic"]'),
    ).not.toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect((rendered.container.querySelector('input[type="file"]') as HTMLInputElement).files).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Validate import", exact: true }).matches(":disabled")).toBe(false);
    expect(inventoryApi.getMutationAttempt).toHaveBeenCalledExactlyOnceWith(id);
  });

  it("refuses before sending when bounded recovery metadata cannot be persisted", async () => {
    const rendered = view();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Validate import", exact: true }).matches(":disabled")).toBe(false),
    );
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("synthetic storage refusal");
    });
    const form = rendered.container.querySelector('input[name="intent"][value="create-batch"]')!.closest("form")!;
    expect(fireEvent.submit(form)).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("not sent");
    expect(inventoryApi.getMutationAttempt).not.toHaveBeenCalled();
  });
});
