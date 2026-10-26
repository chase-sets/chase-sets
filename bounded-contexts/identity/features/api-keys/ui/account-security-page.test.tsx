// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  renderHeldAccountManagementRoute,
  stubHeldAccountManagementTransport,
} from "../../account-management/ui/test-support";
import { syntheticMutationResult } from "../../account-management/api/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "../../users/ui/contracts";
import { SecurityPage } from "./account-security-page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const actor = { tenantId: "tnt_test", userId: "usr_test", accountId: "acc_test" };
const user: User = {
  user_id: actor.userId,
  display_name: "Synthetic User",
  given_name: "Synthetic",
  family_name: "User",
  primary_email: "synthetic@example.test",
  status: "active",
  contact_methods: [],
  auth_methods: ["password"],
  updated_at: "2026-07-15T12:00:00.000Z",
};

function busy(button: HTMLElement) {
  return { disabled: button.matches(":disabled"), busy: button.getAttribute("aria-busy") };
}

describe("SecurityPage pending state", () => {
  it("sibling security forms sharing one action stay independent", async () => {
    const transport = stubHeldAccountManagementTransport();
    const { loads } = renderHeldAccountManagementRoute("/account/security", user, (current) => (
      <SecurityPage user={current} apiKeys={[]} />
    ));
    const profile = screen.getByRole("button", { name: "Update Profile" });
    const create = screen.getByRole("button", { name: "Create API Key" });
    await waitFor(() => expect(profile.matches(":disabled")).toBe(false));
    fireEvent.change(screen.getByLabelText("Display Name"), { target: { value: "Renamed User" } });
    fireEvent.change(screen.getByLabelText("API Key Name"), { target: { value: "Synthetic key" } });

    fireEvent.click(profile);
    await waitFor(() => expect(transport.posts()).toHaveLength(1));
    expect(transport.posts()[0].body?.get("intent")).toBe("update-user");
    expect(busy(profile)).toEqual({ disabled: false, busy: "true" });
    expect(busy(create)).toEqual({ disabled: false, busy: null });
    expect((screen.getByLabelText("API Key Name") as HTMLInputElement).value).toBe("Synthetic key");

    transport.posts()[0].respond(syntheticMutationResult("update-user", actor));
    await waitFor(() => expect(loads).toHaveLength(1));
    expect(busy(profile)).toEqual({ disabled: false, busy: "true" });
    loads[0]({ ...user, display_name: "Renamed User" });
    await waitFor(() => expect(busy(profile)).toEqual({ disabled: false, busy: null }));
    expect((screen.getByLabelText("API Key Name") as HTMLInputElement).value).toBe("Synthetic key");

    fireEvent.click(create);
    await waitFor(() => expect(transport.posts()).toHaveLength(2));
    expect(transport.posts()[1].body?.get("intent")).toBe("create-api-key");
    expect(busy(create)).toEqual({ disabled: false, busy: "true" });
    expect(busy(profile)).toEqual({ disabled: false, busy: null });
    transport.posts()[1].respond({ outcome: "not-recorded", code: "not-recorded" });
    await screen.findByText("No change was recorded. Review and submit again.");
    await waitFor(() => expect(busy(create)).toEqual({ disabled: false, busy: null }));
  });
});
