// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AccountDetailPage } from "../features/accounts/ui/account-detail-page";
import { SecurityPage } from "../features/api-keys/ui/account-security-page";
import { ApiKeyDetailPage } from "../features/api-keys/ui/api-key-detail-page";
import { ConsentHistoryPage } from "../features/consents/ui/consent-history-page";
import { InvitationDetailPage } from "../features/invitations/ui/invitation-detail-page";
import { TeamPage } from "../features/memberships/ui/account-team-page";
import { MembershipDetailPage } from "../features/memberships/ui/membership-detail-page";
import { UserDetailPage } from "../features/users/ui/user-detail-page";

afterEach(cleanup);

describe("Identity destructive action confirmations", () => {
  it.each([
    {
      action: "Suspend",
      dialogName: "Suspend Card Vault?",
      consequence: "People will not be able to act for Card Vault until the account is reactivated.",
      intent: "suspend",
      confirm: "Confirm suspension",
      page: (
        <AccountDetailPage
          data={{
            account_id: "acc_card_vault",
            account_type: "business",
            badges: [],
            founder_number: null,
            display_name: "Card Vault",
            name: "Card Vault LLC",
            status: "active",
            updated_at: "2026-07-14T12:00:00.000Z",
          }}
        />
      ),
    },
    {
      action: "Close",
      dialogName: "Close Card Vault?",
      consequence: "Closing Card Vault ends its active lifecycle and cannot be undone from this workspace.",
      intent: "close",
      confirm: "Confirm closure",
      page: (
        <AccountDetailPage
          data={{
            account_id: "acc_card_vault",
            account_type: "business",
            badges: [],
            founder_number: null,
            display_name: "Card Vault",
            name: "Card Vault LLC",
            status: "active",
            updated_at: "2026-07-14T12:00:00.000Z",
          }}
        />
      ),
    },
    {
      action: "Suspend",
      dialogName: "Suspend Alex Clerk?",
      consequence: "Alex Clerk will not be able to sign in or act for any account until the user is reactivated.",
      intent: "suspend",
      confirm: "Confirm suspension",
      page: (
        <UserDetailPage
          data={{
            user_id: "usr_alex",
            display_name: "Alex Clerk",
            given_name: "Alex",
            family_name: "Clerk",
            primary_email: "alex@example.com",
            status: "active",
            contact_methods: [],
            auth_methods: [],
            updated_at: "2026-07-14T12:00:00.000Z",
          }}
        />
      ),
    },
    {
      action: "Withdraw consent",
      dialogName: "Withdraw Unrecognized consent policy: Marketing Email consent?",
      consequence:
        "This ends your current agreement to Unrecognized consent policy: Marketing Email. The audit history will be retained, and you can agree again later.",
      intent: "withdraw",
      confirm: "Confirm withdrawal",
      page: (
        <ConsentHistoryPage
          consents={[
            {
              consent_id: "cns_marketing",
              subject_type: "user",
              user_id: "usr_alex",
              account_id: "acc_card_vault",
              policy_key: "marketing-email",
              policy_version: "v1",
              status: "recorded",
              recorded_at: "2026-07-14T12:00:00.000Z",
              withdrawn_at: null,
              updated_at: "2026-07-14T12:00:00.000Z",
              is_current: true,
            },
          ]}
        />
      ),
    },
    {
      action: "Revoke",
      dialogName: "Revoke Storefront?",
      consequence: "Storefront will stop authenticating API requests immediately. This action cannot be undone.",
      intent: "revoke-api-key",
      confirm: "Confirm revoke",
      page: (
        <SecurityPage
          user={{
            user_id: "usr_alex",
            display_name: "Alex Clerk",
            given_name: "Alex",
            family_name: "Clerk",
            primary_email: "alex@example.com",
            status: "active",
            contact_methods: [],
            auth_methods: ["password"],
            updated_at: "2026-07-14T12:00:00.000Z",
          }}
          apiKeys={[
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
          ]}
        />
      ),
    },
    {
      action: "Revoke",
      dialogName: "Revoke Ops Console?",
      consequence: "Ops Console will stop authenticating API requests immediately. This action cannot be undone.",
      intent: "revoke",
      confirm: "Confirm revoke",
      page: (
        <ApiKeyDetailPage
          data={{
            api_key_id: "key_ops_console",
            user_id: "usr_alex",
            user_display_name: "Alex Clerk",
            user_primary_email: "alex@example.com",
            name: "Ops Console",
            key_prefix: "key_ops_",
            status: "active",
            last_used_at: null,
            updated_at: "2026-07-14T12:00:00.000Z",
          }}
        />
      ),
    },
    {
      action: "Revoke",
      dialogName: "Revoke Alex Clerk's membership?",
      consequence: "Alex Clerk will lose access to Card Vault and will no longer be able to act for that account.",
      intent: "revoke",
      confirm: "Confirm revoke",
      page: (
        <MembershipDetailPage
          data={{
            membership_id: "membership_alex",
            user_id: "usr_alex",
            user_display_name: "Alex Clerk",
            user_primary_email: "alex@example.com",
            account_id: "acc_card_vault",
            account_display_name: "Card Vault",
            account_name: "Card Vault LLC",
            role_key: "manager",
            status: "active",
            updated_at: "2026-07-14T12:00:00.000Z",
          }}
        />
      ),
    },
    {
      action: "Revoke",
      dialogName: "Revoke Alex Clerk's membership?",
      consequence: "Alex Clerk will lose access to Card Vault and will no longer be able to act for that account.",
      intent: "revoke",
      confirm: "Confirm revoke",
      page: (
        <TeamPage
          memberships={[
            {
              membership_id: "membership_alex",
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
          ]}
          invitations={[]}
        />
      ),
    },
    {
      action: "Cancel",
      dialogName: "Cancel invitation for jordan@example.com?",
      consequence: "The invitation for jordan@example.com to join Card Vault will no longer be accepted.",
      intent: "cancel-invitation",
      confirm: "Confirm cancellation",
      page: (
        <TeamPage
          memberships={[]}
          invitations={[
            {
              invitation_id: "invitation_jordan",
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
          ]}
        />
      ),
    },
    {
      action: "Cancel",
      dialogName: "Cancel invitation for taylor@example.com?",
      consequence: "The invitation for taylor@example.com to join Card Vault will no longer be accepted.",
      intent: "cancel",
      confirm: "Confirm cancellation",
      page: (
        <InvitationDetailPage
          data={{
            invitation_id: "invitation_taylor",
            account_id: "acc_card_vault",
            account_display_name: "Card Vault",
            account_name: "Card Vault LLC",
            email: "taylor@example.com",
            role_key: "viewer",
            status: "pending",
            expires_at: "2026-07-21T12:00:00.000Z",
            accepted_by_user_id: null,
            updated_at: "2026-07-14T12:00:00.000Z",
          }}
        />
      ),
    },
  ])("requires confirmation before exposing the $dialogName form", async (testCase) => {
    render(testCase.page);

    expect(document.querySelector(`input[name="intent"][value="${testCase.intent}"]`)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: testCase.action }));

    const dialog = await screen.findByRole("dialog", { name: testCase.dialogName });
    expect(within(dialog).getByText(testCase.consequence)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: testCase.confirm })).toBeTruthy();
    expect(within(dialog).getByDisplayValue(testCase.intent)).toBeTruthy();
  });
});
