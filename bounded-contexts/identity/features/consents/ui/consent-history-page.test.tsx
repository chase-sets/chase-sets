// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConsentHistoryPage } from "./consent-history-page";

afterEach(cleanup);

describe("ConsentHistoryPage", () => {
  it("renders policy history labels while preserving the consent command value", async () => {
    render(
      <ConsentHistoryPage
        consents={[
          {
            consent_id: "cns_current",
            subject_type: "user",
            user_id: "usr_1",
            account_id: "acc_1",
            policy_key: "terms-of-service",
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
            policy_key: "privacy-policy",
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
    expect(screen.getByRole("heading", { level: 2, name: "Terms of Service · Version v2" })).toBeTruthy();
    expect(screen.getByText("Recorded Jul 3, 2026, 12:00 AM UTC")).toBeTruthy();
    expect(document.querySelector('input[name="intent"][value="withdraw"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Withdraw consent" }));

    const dialog = await screen.findByRole("dialog", { name: "Withdraw Terms of Service consent?" });
    expect(within(dialog).getByRole("button", { name: "Confirm withdrawal" })).toBeTruthy();
    expect(within(dialog).getByDisplayValue("withdraw")).toBeTruthy();
    expect(within(dialog).getByDisplayValue("cns_current")).toBeTruthy();
  });
});

describe("consent history page heading hierarchy", () => {
  it("renders one top-level heading followed by consent section headings", () => {
    render(
      <ConsentHistoryPage
        consents={[
          {
            consent_id: "con_1",
            account_id: "acc_1",
            user_id: "usr_1",
            subject_type: "account",
            policy_key: "terms-of-service",
            policy_version: "2026-07",
            status: "recorded",
            recorded_at: "2026-07-15T12:00:00.000Z",
            withdrawn_at: null,
            updated_at: "2026-07-15T12:00:00.000Z",
            is_current: true,
          },
        ]}
      />,
    );

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Consent History" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Terms of Service · Version 2026-07" })).toBeTruthy();
  });
});
