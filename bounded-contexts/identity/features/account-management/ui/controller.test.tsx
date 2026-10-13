// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, render } from "@testing-library/react";
import { Button, HiddenInput, TextInput } from "@chase-sets/design-system";
import { AccountMutationBoundary, AccountMutationForm } from "./controller";
import { createMemoryRouter, RouterProvider } from "react-router";
import * as routerApi from "react-router";
import { renderAccountManagementPage } from "./test-support";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("issue-7168-ac9-transport-state", () => {
  it("holds only the ambiguous action/target while an unrelated team form still submits", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const observe = vi.fn();
    vi.spyOn(routerApi, "UNSAFE_decodeViaTurboStream").mockResolvedValue({
      value: { data: { outcome: "not-recorded", code: "validation-failed" } },
    } as never);
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("synthetic lost response"))
      .mockResolvedValueOnce(Response.json({ outcome: "indeterminate", code: "INDETERMINATE" }))
      .mockResolvedValueOnce(Response.json({ outcome: "not-recorded", code: "validation-failed" }, { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    function DuplicateRevoke() {
      const [mounted, setMounted] = useState(true);
      return (
        <>
          <Button type="button" onClick={() => setMounted((value) => !value)}>
            Toggle duplicate
          </Button>
          {mounted ? (
            <AccountMutationForm method="post">
              <HiddenInput name="intent" value="revoke" />
              <HiddenInput name="membershipId" value="mbr_test" />
              <Button type="submit">Duplicate revoke</Button>
            </AccountMutationForm>
          ) : null}
        </>
      );
    }
    const router = createMemoryRouter(
      [
        {
          path: "/account/team",
          element: (
            <AccountMutationBoundary
              actor={{ tenantId: "tnt_test", userId: "usr_test", accountId: "acc_test" }}
              onRecoveryDescriptor={observe}
            >
              <AccountMutationForm method="post">
                <HiddenInput name="intent" value="revoke" />
                <HiddenInput name="membershipId" value="mbr_test" />
                <Button type="submit">Revoke</Button>
              </AccountMutationForm>
              <DuplicateRevoke />
              <AccountMutationForm method="post">
                <HiddenInput name="intent" value="create-invitation" />
                <TextInput name="email" label="Email" defaultValue="synthetic@example.test" />
                <Button type="submit">Invite</Button>
              </AccountMutationForm>
            </AccountMutationBoundary>
          ),
        },
      ],
      { initialEntries: ["/account/team"] },
    );
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Revoke$/ }).matches(":disabled")).toBe(false));
    fireEvent.submit(screen.getByRole("button", { name: /^Revoke$/ }).closest("form")!);
    await screen.findByText("We could not confirm the result. Do not repeat this action yet.");
    const retained = observe.mock.calls.at(-1)?.[0];
    expect(retained).toMatchObject({ action: "revoke", target: "mbr_test" });
    expect(screen.getByRole("button", { name: /^Revoke$/ }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Invite" }).matches(":disabled")).toBe(false);
    fireEvent.submit(screen.getByRole("button", { name: "Invite" }).closest("form")!);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(["POST", "GET", "POST"]);
    expect(screen.getByRole("button", { name: "Duplicate revoke" }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /^Revoke$/ }).matches(":disabled")).toBe(true);
    await waitFor(() => expect(observe.mock.calls.at(-1)?.[0]).toEqual(retained));
    fireEvent.click(screen.getByRole("button", { name: "Toggle duplicate" }));
    expect(screen.queryByRole("button", { name: "Duplicate revoke" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle duplicate" }));
    expect(screen.getByRole("button", { name: "Duplicate revoke" }).matches(":disabled")).toBe(true);
  });
  it("preserves entered fields across submitting/confirming/failed-safe and performs no second write", async () => {
    vi.stubGlobal("crypto", webcrypto);
    let loseResponse!: () => void;
    const pending = new Promise<Response>((_resolve, reject) => {
      loseResponse = () => reject(new TypeError("synthetic lost response"));
    });
    const fetch = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(Response.json({ outcome: "not-recorded", code: "not-recorded" }));
    vi.stubGlobal("fetch", fetch);
    renderAccountManagementPage(
      <AccountMutationForm method="post">
        <HiddenInput name="intent" value="update-profile" />
        <TextInput name="name" label="Name" defaultValue="Old" />
        <Button type="submit">Save</Button>
      </AccountMutationForm>,
    );
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "User work" } });
    fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form")!);
    try {
      await screen.findByText("Saving your change");
      expect(screen.getByRole("button", { name: "Save" }).matches(":disabled")).toBe(true);
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("User work");
      fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form")!);
      expect(fetch).toHaveBeenCalledTimes(1);
      loseResponse();
      await screen.findByText("No change was recorded. Review and submit again.");
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("User work");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(["POST", "GET"]);
    } finally {
      loseResponse();
    }
  });
});
