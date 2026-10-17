// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentConsentPage } from "./agent-consent-page";

afterEach(cleanup);
const consent = {
  clientName: "<Synthetic Agent>",
  redirectOrigin: "https://agent.example",
  sessionId: "synthetic-session",
  accountId: "account-one",
  accountName: "Account One",
  scopes: ["account:manage", "payouts:request"],
  memberships: [
    { accountId: "account-one", accountName: "Account One" },
    { accountId: "account-two", accountName: "Account Two" },
  ],
  authorizePath: "/ucp/oauth/authorize?client_id=synthetic-client",
};

describe("AgentConsentPage", () => {
  it("shows the untrusted client name, redirect origin, account and grouped scope labels", () => {
    render(<AgentConsentPage consent={consent} consentToken="synthetic-token" />);
    expect(screen.getByText("<Synthetic Agent>")).toBeTruthy();
    expect(screen.getByText("https://agent.example")).toBeTruthy();
    expect(screen.getByText("Account One")).toBeTruthy();
    expect(screen.getByText("Request payouts", { exact: false })).toBeTruthy();
    expect(screen.getByText("Manage account", { exact: false })).toBeTruthy();
    const approve = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(approve.form?.getAttribute("method")).toBe("post");
    expect(approve.form?.getAttribute("action")).toBe("/ucp/oauth/authorize");
    expect(new FormData(approve.form!).get("decision")).toBe("approve");
    expect(
      new FormData((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).form!).get("decision"),
    ).toBe("deny");
    expect(document.querySelector('input[name="consent_token"]')?.getAttribute("value")).toBe("synthetic-token");
    expect(document.querySelector('input[name="redirect_uri"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Use Account Two" })).toBeTruthy();
  });
  it("renders invalid requests without decision controls", () => {
    render(<AgentConsentPage consent={null} consentToken="" />);
    expect(screen.getByText("Restart the connection from your agent to request consent again.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
  it("disables controls while the native decision submission is pending", () => {
    render(<AgentConsentPage consent={consent} consentToken="synthetic-token" />);
    const approve = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    fireEvent.submit(approve.form!);
    expect(approve.disabled).toBe(true);
    expect(new FormData(approve.form!).get("decision")).toBe("approve");
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("omits account switching for a single membership", () => {
    render(
      <AgentConsentPage
        consent={{ ...consent, memberships: consent.memberships.slice(0, 1) }}
        consentToken="synthetic-token"
      />,
    );
    expect(screen.queryByRole("button", { name: "Use Account Two" })).toBeNull();
  });
});
