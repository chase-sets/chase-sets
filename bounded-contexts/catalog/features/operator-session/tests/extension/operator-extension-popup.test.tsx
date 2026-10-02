// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system/theme";
import { OperatorExtensionPopup } from "../../ui/extension-popup/popup";
import type { OperatorStatus } from "../../domain/extension/protocol";
import { syntheticGrant } from "./fixture";
afterEach(cleanup);
const status: OperatorStatus = {
  paired: false,
  state: "unpaired",
  lastOutcome: null,
  lastPushedAt: null,
  serverRevision: 0,
  cookiePresent: false,
  browserExpiresAt: null,
};
describe("operator-extension localized popup", () => {
  it("has accessible canonical controls and clears transient input before submission", async () => {
    const request = vi.fn(async () => status);
    render(
      <ChaseRoot>
        <OperatorExtensionPopup request={request} />
      </ChaseRoot>,
    );
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Not paired"));
    const input = screen.getByLabelText("Pairing grant");
    expect(input.getAttribute("type")).toBe("password");
    fireEvent.change(input, { target: { value: syntheticGrant } });
    fireEvent.click(screen.getByRole("button", { name: "Pair", exact: true }));
    expect(input.getAttribute("value")).toBe("");
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith({ action: "pair", environment: "staging", grant: syntheticGrant }),
    );
    expect(screen.getByRole("status").textContent).not.toContain(syntheticGrant);
  });
  it.each(["idle", "pushing", "retrying", "error", "re-pair-required", "upgrade-required"] as const)(
    "announces %s without returned secrets",
    async (state) => {
      render(
        <ChaseRoot>
          <OperatorExtensionPopup request={async () => ({ ...status, state, paired: state === "idle" })} />
        </ChaseRoot>,
      );
      await waitFor(() => expect(screen.getByRole("status").textContent).not.toBe("Loading status"));
      expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
      if (state === "upgrade-required")
        expect(screen.getByLabelText("Pairing grant").hasAttribute("disabled")).toBe(true);
    },
  );
});
