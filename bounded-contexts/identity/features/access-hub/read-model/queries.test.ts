import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it, vi } from "vitest";
import { getAccessHome, getAccountAccessHub } from "./queries";

const account = {
  account_id: "acc_card_vault",
  name: "Card Vault LLC",
  display_name: "Card Vault",
  account_type: "business",
  status: "active",
  badges: [],
  founder_number: null,
  founders_window_started_at: null,
  founders_window_ends_at: null,
  updated_at: "2026-07-14T12:00:00.000Z",
};

describe("Access hub read model", () => {
  it("composes one account workspace with team, API access, and real Identity audit events", async () => {
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("FROM identity_accounts WHERE account_id")) {
        return { rows: [account] };
      }
      if (sql.includes("FROM identity_api_keys AS api_keys")) {
        return {
          rows: [
            {
              api_key_id: "key_storefront",
              user_id: "usr_alex",
              name: "Storefront",
              key_prefix: "key_store_",
              status: "active",
              last_used_at: null,
              updated_at: "2026-07-14T12:00:00.000Z",
            },
          ],
        };
      }
      if (sql.includes("FROM identity_memberships AS memberships")) {
        return {
          rows: [
            {
              membership_id: "mbr_alex",
              user_id: "usr_alex",
              user_display_name: "Alex Clerk",
              user_primary_email: "alex@example.com",
              account_id: account.account_id,
              account_display_name: account.display_name,
              account_name: account.name,
              role_key: "manager",
              role_permissions: [],
              status: "active",
              updated_at: "2026-07-14T12:00:00.000Z",
            },
          ],
        };
      }
      if (sql.includes("SELECT users.*")) {
        return {
          rows: [
            {
              user_id: "usr_alex",
              display_name: "Alex Clerk",
              given_name: "Alex",
              family_name: "Clerk",
              primary_email: "alex@example.com",
              status: "active",
              contact_methods: [],
              auth_methods: ["password"],
              updated_at: "2026-07-14T12:00:00.000Z",
            },
          ],
        };
      }
      if (sql.includes("FROM identity_invitations AS invitations")) {
        return {
          rows: [
            {
              invitation_id: "ivt_jordan",
              account_id: account.account_id,
              email: "jordan@example.com",
              role_key: "viewer",
              status: "pending",
              expires_at: "2026-07-21T12:00:00.000Z",
              accepted_by_user_id: null,
              updated_at: "2026-07-14T12:00:00.000Z",
            },
          ],
        };
      }
      if (sql.includes("FROM event_store_events")) {
        expect(values?.[0]).toEqual(
          expect.arrayContaining([
            `identity.account-${account.account_id}`,
            "identity.membership-mbr_alex",
            "identity.user-usr_alex",
            "identity.invitation-ivt_jordan",
            "identity.api-key-key_storefront",
          ]),
        );
        return {
          rows: [
            {
              event_id: "evt_membership",
              stream_id: "identity.membership-mbr_alex",
              event_type: "identity.membership.granted",
              performed_by_user_id: "usr_operator",
              recorded_at: "2026-07-14T12:00:00.000Z",
            },
          ],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const db = { query } as unknown as PgQueryable;

    const hub = await getAccountAccessHub(db, account.account_id);

    expect(hub).toMatchObject({
      account,
      users: [{ user_id: "usr_alex" }],
      memberships: [{ membership_id: "mbr_alex" }],
      invitations: [{ invitation_id: "ivt_jordan" }],
      api_keys: [{ api_key_id: "key_storefront" }],
      audit_events: [{ event_id: "evt_membership" }],
    });
  });

  it("builds the four-lane attention queue alongside account search", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT COUNT(*) as count FROM identity_accounts")) {
        return { rows: [{ count: "1" }] };
      }
      if (sql.includes("SELECT * FROM identity_accounts") && sql.includes("ORDER BY display_name")) {
        return { rows: [account] };
      }
      if (sql.includes("invitations.status = 'pending'")) {
        return { rows: [{ invitation_id: "ivt_pending", account_id: account.account_id }] };
      }
      if (sql.includes("status = 'suspended'")) {
        return { rows: [{ ...account, status: "suspended" }] };
      }
      if (sql.includes("memberships.status = 'pending-review'")) {
        return { rows: [{ membership_id: "mbr_review", account_id: account.account_id }] };
      }
      if (sql.includes("WITH last_rotations")) {
        return { rows: [{ api_key_id: "key_rotate", account_id: account.account_id }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const db = { query } as unknown as PgQueryable;

    const home = await getAccessHome(db, { search: "Card", now: new Date("2026-07-14T12:00:00.000Z") });

    expect(home.accounts).toEqual([account]);
    expect(home.account_total).toBe(1);
    expect(home.attention.pending_invitations).toHaveLength(1);
    expect(home.attention.api_keys_needing_rotation).toHaveLength(1);
    expect(home.attention.suspended_accounts).toHaveLength(1);
    expect(home.attention.memberships_awaiting_review).toHaveLength(1);
  });
});
