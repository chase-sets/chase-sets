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

function statusContaining(text: string) {
  const status = screen.getAllByRole("status").find((candidate) => candidate.textContent?.includes(text));
  expect(status).toBeDefined();
  return status!;
}

describe("issue-7169-c3-upload-recovery: real upload form", () => {
  it.each(["ambiguous", "reauth-required", "different-user"])(
    "restores %s without sending or reading another actor's attempt",
    async (kind) => {
      const id = createInventoryMutationRecovery(authority, "import-create", sessionStorage).begin("draft");
      if (kind === "reauth-required") vi.mocked(inventoryApi.getMutationAttempt).mockRejectedValueOnce({ status: 401 });
      const rendered = view(kind === "different-user" ? { ...authority, actorUserId: "usr_c3_other" } : authority);
      const expectedMessage = kind === "ambiguous" ? "uncertain" : "original account";
      await waitFor(() => expect(statusContaining(expectedMessage).textContent).toContain(expectedMessage));
      const submit = screen.getByRole("button", { name: "Validate import" });
      expect(submit.matches(":disabled")).toBe(true);
      const status = statusContaining(expectedMessage);
      expect(document.activeElement).toBe(status);
      expect(status.getAttribute("aria-live")).toBe("polite");
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
      completedAt: "2026-10-16T00:00:00.000Z",
    } as Awaited<ReturnType<typeof inventoryApi.getMutationAttempt>>);
    const rendered = view();
    await waitFor(() => expect(statusContaining("confirmed").textContent).toContain("confirmed"));
    expect(
      rendered.container.querySelector('a[href="/account/inventory/imports?jobId=job_c3_synthetic"]'),
    ).not.toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect((rendered.container.querySelector('input[type="file"]') as HTMLInputElement).files).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Validate import" }).matches(":disabled")).toBe(false);
    expect(inventoryApi.getMutationAttempt).toHaveBeenCalledExactlyOnceWith(id);
  });

  it("confirms unresolved metadata again after a provider remount instead of remaining confirming", async () => {
    const id = createInventoryMutationRecovery(authority, "import-create", sessionStorage).begin("draft");
    const first = view();
    await waitFor(() => expect(statusContaining("uncertain").textContent).toContain("uncertain"));
    first.unmount();
    view();
    await waitFor(() => expect(statusContaining("uncertain").textContent).toContain("uncertain"));
    expect(inventoryApi.getMutationAttempt).toHaveBeenNthCalledWith(1, id);
    expect(inventoryApi.getMutationAttempt).toHaveBeenNthCalledWith(2, id);
    expect(screen.getByRole("button", { name: "Validate import" }).matches(":disabled")).toBe(true);
  });

  it("refuses before sending when bounded recovery metadata cannot be persisted", async () => {
    const rendered = view();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Validate import" }).matches(":disabled")).toBe(false),
    );
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("synthetic storage refusal");
    });
    const form = rendered.container.querySelector('input[name="intent"][value="create-batch"]')!.closest("form")!;
    expect(fireEvent.submit(form)).toBe(false);
    await waitFor(() => expect(statusContaining("No change was sent").textContent).toContain("No change was sent"));
    expect(inventoryApi.getMutationAttempt).not.toHaveBeenCalled();
  });
});
