// @vitest-environment jsdom

import { cleanup, fireEvent, render as renderTesting, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLoaderData } from "react-router";
import { AccountMutationBoundary } from "../../account-management/ui/controller";
import {
  renderAccountManagementPage as render,
  renderHeldAccountManagementRoute,
  settleAccountManagementRoute,
  stubHeldAccountManagementTransport,
} from "../../account-management/ui/test-support";
import { syntheticMutationResult } from "../../account-management/api/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Membership } from "./contracts";
import type { Invitation } from "../../invitations/ui/contracts";
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

function invitation(id: string, email: string, status = "pending"): Invitation {
  return {
    invitation_id: id,
    account_id: actor.accountId,
    account_display_name: "Synthetic Cards",
    account_name: "Synthetic Cards",
    email,
    role_key: "viewer",
    status,
    expires_at: "2026-12-15T12:00:00.000Z",
    accepted_by_user_id: null,
    accepted_by_user_display_name: null,
    accepted_by_user_primary_email: null,
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
    const { loads, router } = renderHeldAccountManagementRoute("/account/team", rows, (memberships) => (
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
    await settleAccountManagementRoute(router, () => busy(second).busy === null);
    expect(busy(second)).toEqual({ disabled: false, busy: null });
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

    let staleUnlocked = false;
    let reclicked = false;
    const observer = new MutationObserver(() => {
      const current = screen.queryByRole("button", { name: "Confirm revoke" });
      const snapshot = { connected: Boolean(current), busy: current?.getAttribute("aria-busy") ?? null };
      if (snapshot.connected && snapshot.busy === null) {
        staleUnlocked = true;
        if (!reclicked) {
          reclicked = true;
          fireEvent.click(current!);
        }
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    loads[0]([membership("mem_1", "Alex", "revoked"), membership("mem_2", "Blair")]);
    await settleAccountManagementRoute(router, () => screen.queryByRole("button", { name: "Confirm revoke" }) === null);
    expect(screen.queryByRole("button", { name: "Confirm revoke" })).toBeNull();
    observer.disconnect();
    expect(staleUnlocked).toBe(false);
    expect(transport.posts()).toHaveLength(1);
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

  it("keeps a dialog-hosted form busy through a batched redirect commit", async () => {
    const transport = stubHeldAccountManagementTransport();
    let loads = 0;
    const initialRows = [membership("mem_1", "Alex"), membership("mem_2", "Blair")];
    function BatchedTeamPage() {
      const rows = useLoaderData() as Membership[];
      return <TeamPage invitations={[]} memberships={rows} />;
    }
    const router = createMemoryRouter(
      [
        {
          id: "page",
          path: "/account/team",
          loader: () => {
            loads += 1;
            return [membership("mem_1", "Alex", "revoked"), membership("mem_2", "Blair")];
          },
          element: (
            <AccountMutationBoundary actor={actor}>
              <BatchedTeamPage />
            </AccountMutationBoundary>
          ),
        },
      ],
      {
        initialEntries: ["/account/team"],
        hydrationData: { loaderData: { page: initialRows } },
      },
    );
    renderTesting(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Revoke" })[0].matches(":disabled")).toBe(false));
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]);
    const confirm = await screen.findByRole("button", { name: "Confirm revoke" });
    fireEvent.click(confirm);
    await waitFor(() => expect(transport.posts()).toHaveLength(1));
    expect(busy(confirm)).toEqual({ disabled: false, busy: "true" });

    transport.posts()[0].respond({
      ...syntheticMutationResult("revoke", actor, { target: "mem_1" }),
      destination: "/account/team?afterWrite=synthetic",
    });
    const snapshots: { connected: boolean; busy: string | null }[] = [];
    let staleUnlocked = false;
    let reclicked = false;
    const observer = new MutationObserver(() => {
      const current = screen.queryByRole("button", { name: "Confirm revoke" });
      const snapshot = { connected: Boolean(current), busy: current?.getAttribute("aria-busy") ?? null };
      snapshots.push(snapshot);
      if (snapshot.connected && snapshot.busy === null) {
        staleUnlocked = true;
        if (!reclicked) {
          reclicked = true;
          fireEvent.click(current!);
        }
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    await waitFor(() => expect(loads).toBe(1));
    await settleAccountManagementRoute(router, () => screen.queryByRole("button", { name: "Confirm revoke" }) === null);
    expect(screen.queryByRole("button", { name: "Confirm revoke" })).toBeNull();
    observer.disconnect();

    expect(staleUnlocked).toBe(false);
    expect(snapshots.some(({ connected, busy: state }) => connected && state === null)).toBe(false);
    expect(transport.posts()).toHaveLength(1);
  });

  it("dialog-hosted invitation forms stay busy until the redirect completes", async () => {
    const transport = stubHeldAccountManagementTransport();
    const { loads, router } = renderHeldAccountManagementRoute(
      "/account/team",
      {
        memberships: [membership("mem_1", "Alex")],
        invitations: [invitation("ivt_1", "invitee@example.test")],
      },
      ({ memberships, invitations }) => <TeamPage invitations={invitations} memberships={memberships} />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" }).matches(":disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const confirm = await screen.findByRole("button", { name: "Confirm cancellation" });
    confirm.focus();
    fireEvent.click(confirm);
    await waitFor(() => expect(transport.posts()).toHaveLength(1));
    expect(busy(confirm)).toEqual({ disabled: false, busy: "true" });
    expect(document.activeElement).toBe(confirm);

    transport.posts()[0].respond({
      ...syntheticMutationResult("cancel-invitation", actor, { target: "ivt_1" }),
      destination: "/account/team?afterWrite=synthetic",
    });
    await waitFor(() => expect(loads).toHaveLength(1));
    await screen.findByText("Your change was saved");
    expect(screen.getByRole("button", { name: "Confirm cancellation" })).toBe(confirm);
    expect(busy(confirm)).toEqual({ disabled: false, busy: "true" });
    fireEvent.click(confirm);
    expect(transport.posts()).toHaveLength(1);

    let staleUnlocked = false;
    let reclicked = false;
    const observer = new MutationObserver(() => {
      const current = screen.queryByRole("button", { name: "Confirm cancellation" });
      const snapshot = { connected: Boolean(current), busy: current?.getAttribute("aria-busy") ?? null };
      if (snapshot.connected && snapshot.busy === null) {
        staleUnlocked = true;
        if (!reclicked) {
          reclicked = true;
          fireEvent.click(current!);
        }
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    loads[0]({
      memberships: [membership("mem_1", "Alex")],
      invitations: [invitation("ivt_1", "invitee@example.test", "cancelled")],
    });
    await settleAccountManagementRoute(
      router,
      () => screen.queryByRole("button", { name: "Confirm cancellation" }) === null,
    );
    expect(screen.queryByRole("button", { name: "Confirm cancellation" })).toBeNull();
    observer.disconnect();
    expect(staleUnlocked).toBe(false);
    expect(transport.posts()).toHaveLength(1);
    const change = screen.getByRole("button", { name: "Change Role" });
    expect(busy(change)).toEqual({ disabled: false, busy: null });
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
