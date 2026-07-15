// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConsentHistoryPage } from "./consent-history-page";

afterEach(cleanup);

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
            policy_key: "marketplace-terms",
            policy_version: "2026-07",
            recorded_at: "2026-07-15T12:00:00.000Z",
            updated_at: "2026-07-15T12:00:00.000Z",
          },
        ]}
      />,
    );

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Consent History" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: /marketplace-terms/ })).toBeTruthy();
  });
});
