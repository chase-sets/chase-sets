// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Button, HiddenInput, TextInput } from "@chase-sets/design-system";
import { AccountMutationForm } from "./controller";
import { renderAccountManagementPage } from "./test-support";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("issue-7168-ac9-transport-state", () => {
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
