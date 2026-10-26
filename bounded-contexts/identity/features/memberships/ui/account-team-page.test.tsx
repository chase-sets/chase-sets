// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  renderAccountManagementPage as render,
  renderHeldAccountManagementRoute,
  stubHeldAccountManagementTransport,
} from "../../account-management/ui/test-support";
import { syntheticMutationResult } from "../../account-management/api/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Membership } from "./contracts";
import { TeamPage } from "./account-team-page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const actor = { tenantId: "tnt_test", userId: "usr_test", accountId: "acc_test" };

function membership(id: string, name: string, status = "active"): Membership {
  return {
    membership_id: id,
    user_id: `usr_${id}`,
    user_display_name: name,
    user_primary_email: `${id}@example.test`,
    account_id: actor.accountId,
    account_display_name: "Synthetic Cards",
    account_name: "Synthetic Cards",
    role_key: "viewer",
    status,
    updated_at: "2026-07-15T12:00:00.000Z",
  };
}

function busy(button: HTMLElement) {
  return { disabled: button.matches(":disabled"), busy: button.getAttribute("aria-busy") };
}

describe("TeamPage pending state", () => {
  it("per-row forms sharing one intent stay independent", async () => {
    const transport = stubHeldAccountManagementTransport();
    const rows = [membership("mem_1", "Alex"), membership("mem_2", "Blair"), membership("mem_3", "Casey")];
    const { loads } = renderHeldAccountManagementRoute("/account/team", rows, (memberships) => (
      <TeamPage invitations={[]} memberships={memberships} />
    ));
    const [first, second, third] = screen.getAllByRole("button", { name: "Change Role" });
    await waitFor(() => expect(first.matches(":disabled")).toBe(false));
    const roles = () => screen.getAllByLabelText("Role") as HTMLSelectElement[];
    fireEvent.change(roles()[1], { target: { value: "manager" } });
    fireEvent.change(roles()[2], { target: { value: "fulfillment" } });

    fireEvent.click(second);
    await waitFor(() => expect(transport.posts()).toHaveLength(1));
    expect(transport.posts()[0].body?.get("membershipId")).toBe("mem_2");
    expect(transport.posts()[0].body?.get("roleKey")).toBe("fulfillment");
    expect(busy(second)).toEqual({ disabled: false, busy: "true" });
    for (const sibling of [first, third]) expect(busy(sibling)).toEqual({ disabled: false, busy: null });
    expect(roles()[1].value).toBe("manager");
    expect(roles()[2].value).toBe("fulfillment");

    transport.posts()[0].respond(syntheticMutationResult("change-role", actor, { target: "mem_2" }));
    await waitFor(() => expect(loads).toHaveLength(1));
    expect(busy(second)).toEqual({ disabled: false, busy: "true" });
    loads[0](rows);
    await waitFor(() => expect(busy(second)).toEqual({ disabled: false, busy: null }));
    expect(roles()[1].value).toBe("manager");

    fireEvent.click(third);
    await waitFor(() => expect(transport.posts()).toHaveLength(2));
    expect(transport.posts()[1].body?.get("membershipId")).toBe("mem_3");
    expect(busy(third)).toEqual({ disabled: false, busy: "true" });
    expect(busy(first)).toEqual({ disabled: false, busy: null });
    transport.posts()[1].respond({ outcome: "not-recorded", code: "not-recorded" });
    await waitFor(() => expect(busy(third)).toEqual({ disabled: false, busy: null }));
  });

  it("dialog-hosted forms stay busy until the redirect completes", async () => {
    const transport = stubHeldAccountManagementTransport();
    const { loads, router } = renderHeldAccountManagementRoute(
      "/account/team",
      [membership("mem_1", "Alex"), membership("mem_2", "Blair")],
      (memberships) => <TeamPage invitations={[]} memberships={memberships} />,
    );
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Revoke" })[0].matches(":disabled")).toBe(false));
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]);
    const confirm = await screen.findByRole("button", { name: "Confirm revoke" });
    confirm.focus();
    fireEvent.click(confirm);
    await waitFor(() => expect(transport.posts()).toHaveLength(1));
    expect(busy(confirm)).toEqual({ disabled: false, busy: "true" });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(confirm);

    transport.posts()[0].respond({
      ...syntheticMutationResult("revoke", actor, { target: "mem_1" }),
      destination: "/account/team?afterWrite=synthetic",
    });
    await waitFor(() => expect(loads).toHaveLength(1));
    await screen.findByText("Your change was saved");
    expect(screen.getByRole("button", { name: "Confirm revoke" })).toBe(confirm);
    expect(busy(confirm)).toEqual({ disabled: false, busy: "true" });
    fireEvent.click(confirm);
    expect(transport.posts()).toHaveLength(1);

    loads[0]([membership("mem_1", "Alex", "revoked"), membership("mem_2", "Blair")]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm revoke" })).toBeNull());
    expect(router.state.location.search).toBe("?afterWrite=synthetic");
    const change = screen.getAllByRole("button", { name: "Change Role" })[1];
    expect(busy(change)).toEqual({ disabled: false, busy: null });
    fireEvent.click(change);
    await waitFor(() => expect(transport.posts()).toHaveLength(2));
    expect(transport.posts()[1].body?.get("membershipId")).toBe("mem_2");
    transport.posts()[1].respond({ outcome: "not-recorded", code: "validation-failed" }, 400);
    await screen.findByText("No change was recorded. Review and submit again.");
    await waitFor(() => expect(busy(change)).toEqual({ disabled: false, busy: null }));
    fireEvent.click(change);
    await waitFor(() => expect(transport.posts()).toHaveLength(3));
    transport.posts()[2].respond({ outcome: "not-recorded", code: "not-recorded" });
    await waitFor(() => expect(busy(change)).toEqual({ disabled: false, busy: null }));
  });
});

describe("account team page heading hierarchy", () => {
  it("renders one top-level heading followed by member section headings", () => {
    render(
      <TeamPage
        invitations={[]}
        memberships={[
          {
            membership_id: "mem_1",
            user_id: "usr_1",
            user_display_name: "Alex Seller",
            user_primary_email: "alex@example.test",
            account_id: "acc_1",
            account_display_name: "Alex Cards",
            account_name: "Alex Cards",
            role_key: "owner",
            status: "active",
            updated_at: "2026-07-15T12:00:00.000Z",
          },
        ]}
      />,
    );

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Team" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Alex Seller" })).toBeTruthy();
  });
});
