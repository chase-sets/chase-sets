import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  authIdentityProjectionSchemaSql,
  buildAuthIdentityUserProjectionHandlers,
  getActiveAuthMembershipForUserAccount,
} from "./identity-projection";

const activeMembershipRow = Object.freeze({
  membership_id: "mem_platform_admin",
  user_id: "usr_platform_admin",
  account_id: "acc_platform_admin",
  role_key: "platform-admin",
  role_permissions: ["waitlist.manage"],
  status: "active",
  updated_at: "2026-05-25T00:00:00.000Z",
});

function buildIdentityUserEvent(
  type: string,
  data: TransportEvent["data"],
  recordedAt = "2026-06-12T12:00:00.000Z",
): TransportEvent {
  return buildTransportEvent(type, data, {
    id: "evt_contact_methods",
    streamId: "identity.user-usr_contact",
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_actor", forAccountId: "acc_actor" },
    timing: { occurredAt: recordedAt, recordedAt },
  });
}

describe("auth identity membership reads", () => {
  it("resolves account membership from the user membership mirror used during sign-in", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [activeMembershipRow] }));
    const db = { query } as unknown as PgQueryable;

    await expect(
      getActiveAuthMembershipForUserAccount(db, "usr_platform_admin", "acc_platform_admin"),
    ).resolves.toEqual(activeMembershipRow);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("FROM auth_identity_user_memberships");
    expect(query.mock.calls[0]?.[1]).toEqual(["usr_platform_admin", "acc_platform_admin"]);
  });

  it("falls back to the membership mirror for deployments that have not rebuilt user membership rows", async () => {
    const query = vi
      .fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] as (typeof activeMembershipRow)[] }))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [activeMembershipRow] });
    const db = { query } as unknown as PgQueryable;

    await expect(
      getActiveAuthMembershipForUserAccount(db, "usr_platform_admin", "acc_platform_admin"),
    ).resolves.toEqual(activeMembershipRow);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("FROM auth_identity_user_memberships");
    expect(query.mock.calls[1]?.[0]).toContain("FROM auth_identity_memberships");
  });

  it("keeps request-time membership lookups indexed", () => {
    expect(authIdentityProjectionSchemaSql).toContain("auth_identity_user_memberships_user_status_idx");
    expect(authIdentityProjectionSchemaSql).toContain("auth_identity_user_memberships_user_account_status_idx");
    expect(authIdentityProjectionSchemaSql).toContain("auth_identity_memberships_user_account_status_idx");
  });
});

describe("auth identity user projection contact methods", () => {
  it("batches lookup inserts for identities with multiple contact methods", async () => {
    const recordedAt = "2026-06-12T12:00:00.000Z";
    const contactMethods = [
      {
        contactMethodId: "cm_email_primary",
        type: "email",
        value: " Primary@Example.COM ",
        verifiedAt: "2026-06-11T12:00:00.000Z",
      },
      {
        contactMethodId: "cm_email_backup",
        type: "email",
        value: " backup@example.com ",
        verifiedAt: null,
      },
      {
        contactMethodId: "cm_phone_primary",
        type: "phone",
        value: "(555) 111-2222",
        verifiedAt: "2026-06-11T12:00:00.000Z",
      },
      {
        contactMethodId: "cm_phone_backup",
        type: "phone",
        value: "555.333.4444",
        verifiedAt: null,
      },
    ];
    const verifiedContactMethods = contactMethods.map((method) =>
      method.contactMethodId === "cm_phone_backup" ? { ...method, verifiedAt: "2026-06-12T11:00:00.000Z" } : method,
    );
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      if (sql.includes("RETURNING contact_methods")) {
        return { rows: [{ contact_methods: verifiedContactMethods }] };
      }

      return { rows: [] };
    });
    const db = { query } as unknown as PgQueryable;
    const handlers = buildAuthIdentityUserProjectionHandlers(db);

    await handlers["identity.user.contact-method-verified"](
      buildIdentityUserEvent(
        "identity.user.contact-method-verified",
        {
          contactMethodId: "cm_phone_backup",
          verifiedAt: "2026-06-12T11:00:00.000Z",
        },
        recordedAt,
      ),
    );

    const emailInsertCalls = query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO auth_identity_user_emails"),
    );
    const phoneInsertCalls = query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO auth_identity_user_phones"),
    );

    expect(emailInsertCalls).toHaveLength(1);
    expect(emailInsertCalls[0]?.[0]).toContain("VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)");
    expect(emailInsertCalls[0]?.[0]).toContain("ON CONFLICT (email) DO UPDATE");
    expect(emailInsertCalls[0]?.[1]).toEqual([
      "primary@example.com",
      "usr_contact",
      "cm_email_primary",
      true,
      recordedAt,
      "backup@example.com",
      "usr_contact",
      "cm_email_backup",
      false,
      recordedAt,
    ]);

    expect(phoneInsertCalls).toHaveLength(1);
    expect(phoneInsertCalls[0]?.[0]).toContain("VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)");
    expect(phoneInsertCalls[0]?.[0]).toContain("ON CONFLICT (phone) DO UPDATE");
    expect(phoneInsertCalls[0]?.[1]).toEqual([
      "+15551112222",
      "usr_contact",
      "cm_phone_primary",
      true,
      recordedAt,
      "+15553334444",
      "usr_contact",
      "cm_phone_backup",
      true,
      recordedAt,
    ]);
  });
});
