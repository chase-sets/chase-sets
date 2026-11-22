// @vitest-environment jsdom
import {
  renderAccountManagementPage,
  renderAccountManagementPageToString as renderToString,
  stubHeldAccountManagementTransport,
} from "../../account-management/ui/test-support";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountProfilePage } from "./account-profile-page";

const account = {
  account_id: "acc_card_vault",
  account_type: "business",
  display_name: "Card Vault",
  name: "Card Vault LLC",
  status: "active",
  badges: ["founding-account"],
  updated_at: "2026-05-13T12:00:00.000Z",
};

const actorDisplay = {
  account: {
    account_id: "acc_card_vault",
    display_name: "Card Vault",
    name: "Card Vault LLC",
    badges: ["founding-account"],
  },
  membership: {
    membership_id: "mbr_card_vault_alex",
    role_key: "fulfillment_manager",
  },
  user: {
    user_id: "usr_alex",
    display_name: "Alex Clerk",
    primary_email: "alex@example.com",
  },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AccountProfilePage", () => {
  it("focuses the shared recovery notice after a lost submission is confirmed not recorded", async () => {
    const transport = stubHeldAccountManagementTransport();
    const fetch = vi.fn<typeof transport.fetch>((input, init) =>
      init?.method === "POST"
        ? Promise.reject(new TypeError("synthetic connection loss"))
        : transport.fetch(input, init),
    );
    vi.stubGlobal("fetch", fetch);
    renderAccountManagementPage(<AccountProfilePage account={account} />);
    const submit = screen.getByRole<HTMLButtonElement>("button", { name: "Update Profile" });
    await waitFor(() => expect(submit.disabled).toBe(false));
    const name = screen.getByRole<HTMLInputElement>("textbox", { name: /Marketplace name/i });
    fireEvent.change(name, { target: { value: "Updated Card Vault" } });
    fireEvent.submit(submit.closest("form")!);
    await waitFor(() => expect(transport.requests).toHaveLength(1));
    await act(async () => transport.requests[0].respond({ outcome: "not-recorded", code: "not-recorded" }));

    const notice = await screen.findByText("No change was recorded. Review and submit again.");
    const status = document.querySelector('[role="status"][tabindex="-1"]');
    expect(status?.contains(notice)).toBe(true);
    expect(document.activeElement).toBe(status);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Update Profile" }).disabled).toBe(false);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: /Marketplace name/i }).value).toBe(
      "Updated Card Vault",
    );
    expect(screen.queryByText("Your change was saved")).toBeNull();
  });

  it("account-profile-marker-scan: guides recovery without reflecting rejected text outside the retained draft", async () => {
    const transport = stubHeldAccountManagementTransport();
    renderAccountManagementPage(<AccountProfilePage account={account} />);
    const submit = screen.getByRole("button", { name: "Update Profile" });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    const draft = "account-profile-marker-scan http://test.example";
    fireEvent.change(screen.getByRole("textbox", { name: /Marketplace name/i }), { target: { value: draft } });
    fireEvent.submit(submit.closest("form")!);
    await waitFor(() => expect(transport.posts()).toHaveLength(1));
    expect(transport.posts()[0].body?.get("displayName")).toBe(draft);
    await act(async () =>
      transport.posts()[0].respond(
        {
          failure: {
            kind: "validation",
            status: 400,
            code: "text_unsafe_link",
            intent: "update-profile",
            message: draft,
          },
        },
        400,
      ),
    );
    expect(await screen.findByText("Your draft is still here. Edit it and try again.")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Remove unsafe links or use links that start with https:\/\// }),
    ).toBeTruthy();
    expect((screen.getByRole("textbox", { name: /Marketplace name/i }) as HTMLInputElement).value).toBe(draft);
    expect(document.body.textContent).not.toContain("account-profile-marker-scan");
    expect(screen.getByRole("link", { name: "Community Guidelines" }).getAttribute("href")).toBe(
      "/help/buying/community-guidelines-and-enforcement",
    );
    expect(screen.getByRole("link", { name: "Contact support" }).getAttribute("href")).toBe("/contact");
  });

  it("shows the signed-in user and selected account before account details", () => {
    const html = renderToString(<AccountProfilePage account={account} actorDisplay={actorDisplay} />);

    expect(html).toContain("Signed-In Identity");
    expect(html).toContain("Card Vault");
    expect(html).toContain("Alex Clerk");
    expect(html).toContain("alex@example.com");
    expect(html).toContain("Unrecognized Membership role");
    expect(html).not.toContain("fulfillment_manager");
    expect(html).toContain("Founding Account");
    expect(html.indexOf("Signed-In Identity")).toBeLessThan(html.indexOf("Marketplace Readiness"));
  });

  it("keeps buyer shipping addresses separate from seller ship-from setup", () => {
    const html = renderToString(<AccountProfilePage account={account} actorDisplay={actorDisplay} />);

    expect(html).toContain('href="/account/shipping-addresses"');
    expect(html).toContain("Manage shipping addresses");
    expect(html).toContain('href="/account/inventory/locations"');
    expect(html).toContain("Manage ship-from locations");
  });
});
