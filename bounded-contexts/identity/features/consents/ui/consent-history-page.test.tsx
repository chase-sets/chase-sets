// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConsentHistoryPage } from "./consent-history-page";

afterEach(cleanup);

describe("ConsentHistoryPage", () => {
  it("offers confirmed withdrawal only for the current recorded consent", async () => {
    render(
      <ConsentHistoryPage
        consents={[
          {
            consent_id: "cns_current",
            subject_type: "user",
            user_id: "usr_1",
            account_id: "acc_1",
            policy_key: "marketing-email",
            policy_version: "v2",
            status: "recorded",
            recorded_at: "2026-07-03T00:00:00.000Z",
            withdrawn_at: null,
            updated_at: "2026-07-03T00:00:00.000Z",
            is_current: true,
          },
          {
            consent_id: "cns_previous",
            subject_type: "user",
            user_id: "usr_1",
            account_id: "acc_1",
            policy_key: "marketing-email",
            policy_version: "v1",
            status: "withdrawn",
            recorded_at: "2026-07-01T00:00:00.000Z",
            withdrawn_at: "2026-07-02T00:00:00.000Z",
            updated_at: "2026-07-02T00:00:00.000Z",
            is_current: false,
          },
        ]}
      />,
    );

    expect(screen.getAllByText("Withdrawn")).toHaveLength(1);
    expect(document.querySelector('input[name="intent"][value="withdraw"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Withdraw consent" }));

    const dialog = await screen.findByRole("dialog", { name: "Withdraw marketing-email consent?" });
    expect(within(dialog).getByRole("button", { name: "Confirm withdrawal" })).toBeTruthy();
    expect(within(dialog).getByDisplayValue("withdraw")).toBeTruthy();
    expect(within(dialog).getByDisplayValue("cns_current")).toBeTruthy();
  });
});
