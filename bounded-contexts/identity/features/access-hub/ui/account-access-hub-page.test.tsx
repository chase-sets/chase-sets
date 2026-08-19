// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { AccountAccessHub } from "../api/contracts";
import { AccountAccessHubPage } from "./account-access-hub-page";

const actor: ResolvedActor = {
  sessionId: "ses_operator",
  tenantId: "tnt_platform",
  userId: "usr_operator",
  accountId: "acc_platform",
  membershipId: "mbr_operator",
  roleKey: "platform-admin",
  permissions: [
    "accounts.manage",
    "accounts.view",
    "memberships.manage",
    "memberships.view",
    "security.manage",
    "wallet-adjustments.view",
  ],
};

const data: AccountAccessHub = {
  account: {
    account_id: "acc_card_vault",
    account_type: "business",
    badges: ["trusted-seller"],
    founder_number: null,
    display_name: "Card Vault",
    name: "Card Vault LLC",
    status: "active",
    updated_at: "2026-07-14T12:00:00.000Z",
  },
  users: [
    {
      user_id: "usr_alex",
      display_name: "Alex Clerk",
      given_name: "Alex",
      family_name: "Clerk",
      primary_email: "alex@example.com",
      status: "active",
      contact_methods: [
        {
          contactMethodId: "ctm_email",
          type: "email",
          value: "alex@example.com",
          verifiedAt: null,
        },
      ],
      auth_methods: ["password"],
      updated_at: "2026-07-14T12:00:00.000Z",
    },
  ],
  memberships: [
    {
      membership_id: "mbr_alex",
      user_id: "usr_alex",
      user_display_name: "Alex Clerk",
      user_primary_email: "alex@example.com",
      account_id: "acc_card_vault",
      account_display_name: "Card Vault",
      account_name: "Card Vault LLC",
      role_key: "manager",
      status: "active",
      updated_at: "2026-07-14T12:00:00.000Z",
    },
  ],
  invitations: [
    {
      invitation_id: "ivt_jordan",
      account_id: "acc_card_vault",
      account_display_name: "Card Vault",
      account_name: "Card Vault LLC",
      email: "jordan@example.com",
      role_key: "viewer",
      status: "pending",
      expires_at: "2026-07-21T12:00:00.000Z",
      accepted_by_user_id: null,
      updated_at: "2026-07-14T12:00:00.000Z",
    },
  ],
  api_keys: [
    {
      api_key_id: "key_storefront",
      user_id: "usr_alex",
      user_display_name: "Alex Clerk",
      user_primary_email: "alex@example.com",
      name: "Storefront",
      key_prefix: "key_store_",
      status: "active",
      last_used_at: null,
      updated_at: "2026-07-14T12:00:00.000Z",
    },
  ],
  audit_events: [
    {
      event_id: "evt_role",
      stream_id: "identity.membership-mbr_alex",
      event_type: "identity.membership.role-changed",
      performed_by_user_id: "usr_operator",
      recorded_at: "2026-07-14T12:00:00.000Z",
    },
  ],
};

afterEach(cleanup);

function cardRoots(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(".rounded-tokenLg.overflow-hidden")];
}

function elevationCounts(container: HTMLElement) {
  const cards = cardRoots(container);
  return {
    cards,
    elevated: cards.filter((card) => card.classList.contains("shadow-tokenSm")).length,
    tinted: cards.filter((card) => card.classList.contains("bg-surface-2")).length,
  };
}

describe("Account access hub", () => {
  it("preserves the canonical default Tabs layout", () => {
    const { container } = render(<AccountAccessHubPage data={data} actor={actor} initialTab="overview" />);
    const html = container.innerHTML;

    expect(html).toContain(
      "grid w-full min-w-0 max-w-full grid-cols-2 gap-2 rounded-tokenLg border border-muted bg-background p-2 md:inline-flex md:flex-wrap",
    );
    expect(html).not.toContain("data-mobile-layout");
  });

  it("keeps account profile and lifecycle actions in Overview", () => {
    const { container } = render(<AccountAccessHubPage data={data} actor={actor} initialTab="overview" />);
    const html = container.innerHTML;

    expect(html).toContain("Account access hub");
    expect(html).toContain("Card Vault");
    expect(html).toContain("Update Profile");
    expect(html).toContain("Suspend");
    expect(html).toContain("Close");
    expect(html).toContain("Trusted Seller");
    expect(html).toContain(`/commerce/wallet-workbench/${data.account.account_id}`);
  });

  it("keeps invitation, role, membership, and user-security intents in Team", () => {
    const { container } = render(<AccountAccessHubPage data={data} actor={actor} initialTab="team" />);
    const html = container.innerHTML;

    expect(html).toContain("Invite Member");
    expect(html).toContain("Alex Clerk");
    expect(html).toContain("Change Role");
    expect(html).toContain("Revoke");
    expect(html).toContain("jordan@example.com");
    expect(html).toContain("Resend");
    expect(html).toContain("Cancel");
    expect(html).toContain("Decline");
    expect(html).toContain("Add Contact Method");
    expect(html).toContain("Enable Auth Method");
    expect(html).toContain("Disable password");
  });

  it("creates and rotates API keys in context while revealing the transient secret", () => {
    const { container } = render(
      <AccountAccessHubPage
        data={data}
        actor={actor}
        initialTab="api-access"
        oneTimeSecret={{
          apiKeyId: "key_storefront",
          keyPrefix: "key_rotated_",
          secret: "key_rotated_full_secret_value",
          action: "rotated",
        }}
      />,
    );
    const html = container.innerHTML;

    expect(html).toContain("Create API Key");
    expect(html).toContain("Storefront");
    expect(html).toContain("Rotate");
    expect(html).toContain("Revoke");
    expect(html).toContain("API key secret rotated");
    expect(html).toContain("key_rotated_full_secret_value");
    expect(html).toContain("shown only once");
  });

  it("shows the account's Identity event audit trail", () => {
    const { container } = render(<AccountAccessHubPage data={data} actor={actor} initialTab="audit" />);
    const html = container.innerHTML;

    expect(html).toContain("membership · role changed");
    expect(html).toContain("identity.membership-mbr_alex");
    expect(html).toContain("usr_operator");
  });

  it.each([
    ["overview", 3, 0],
    ["team", 2, 1],
    ["api-access", 1, 0],
    ["audit", 0, 0],
  ] as const)("keeps the frozen %s surface hierarchy", (initialTab, tinted, elevated) => {
    const { container } = render(<AccountAccessHubPage data={data} actor={actor} initialTab={initialTab} />);
    const counts = elevationCounts(container);

    expect(counts.tinted).toBe(tinted);
    expect(counts.elevated).toBe(elevated);
    for (const card of counts.cards) {
      expect(card.querySelector(".rounded-tokenLg.overflow-hidden")).toBeNull();
    }
  });
});
