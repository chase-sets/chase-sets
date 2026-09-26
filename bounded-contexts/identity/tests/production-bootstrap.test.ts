import { describe, expect, it, vi } from "vitest";
import type { IdentityServices } from "../support/runtime-support/services";
import { bootstrapPlatformAdminIdentity } from "../support/runtime-support/production-bootstrap";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildMembershipProjectionHandlers } from "../features/memberships/read-model/projection";

type CommandEnvelope = Readonly<{
  streamId?: unknown;
  command?: unknown;
}>;

function createCommandRecorder() {
  const records: CommandEnvelope[] = [];
  const handler = vi.fn(async (envelope: unknown) => {
    records.push(envelope as CommandEnvelope);
    return { version: 1, state: {} };
  });

  return { handler, records };
}

function createServices(existing: boolean, existingRoleKey = "platform-admin") {
  const accounts = createCommandRecorder();
  const users = createCommandRecorder();
  const memberships = createCommandRecorder();

  return {
    services: {
      accounts: {
        getAccount: vi.fn(async () => (existing ? { account_id: "acc_platform_admin" } : null)),
        commandHandler: accounts.handler,
      },
      users: {
        getUser: vi.fn(async () => (existing ? { user_id: "usr_platform_admin" } : null)),
        commandHandler: users.handler,
      },
      memberships: {
        commandHandler: memberships.handler,
      },
      db: {
        query: vi.fn(async () => ({
          rows: existing ? [{ membership_id: "mbr_platform_admin", role_key: existingRoleKey }] : [],
        })),
      },
      projectors: [
        {
          runOnce: vi.fn(async () => ({ processed: 0 })),
        },
      ],
    } as unknown as IdentityServices,
    records: {
      accounts: accounts.records,
      users: users.records,
      memberships: memberships.records,
    },
  };
}

describe("platform admin production bootstrap", () => {
  it.each(["create", "repair", "idempotent"])(
    "keeps pricing absent through bootstrap and projection: %s",
    async (mode) => {
      const { services, records } = createServices(mode !== "create", mode === "repair" ? "viewer" : "platform-admin");
      await bootstrapPlatformAdminIdentity(services, {
        email: "synthetic-ops@example.test",
        displayName: "Synthetic Ops",
        accountName: "Synthetic Platform",
      });
      const command = records.memberships[0]?.command as { roleKey: string } | undefined;
      const roleKey =
        command?.roleKey ??
        (await services.db.query<{ role_key: string }>("SELECT role_key FROM identity_memberships")).rows[0]!.role_key;
      expect(roleKey).toBe("platform-admin");
      const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
      const handlers = buildMembershipProjectionHandlers({ query } as PgQueryable);
      const type = mode === "repair" ? "identity.membership.role-changed" : "identity.membership.granted";
      await handlers[type]!(
        buildTransportEvent(
          type,
          {
            membershipId: "mbr_synthetic_bootstrap",
            userId: "usr_synthetic_bootstrap",
            accountId: "acc_synthetic_bootstrap",
            roleKey,
          },
          { streamId: "identity.membership-mbr_synthetic_bootstrap" },
        ),
      );
      const write = query.mock.calls.find(([sql]) => sql.includes("role_permissions"));
      const permissions = JSON.parse(String(write![1]![mode === "repair" ? 2 : 4]));
      expect(permissions).not.toContain("pricing.view");
      expect(permissions).not.toContain("pricing.manage");
    },
  );
  it("is idempotent when the configured admin already exists", async () => {
    const { services, records } = createServices(true);

    const result = await bootstrapPlatformAdminIdentity(services, {
      email: "ops@chasesets.com",
      displayName: "Ops Admin",
      accountName: "Chase Sets Platform",
    });

    expect(result).toMatchObject({
      createdAccount: false,
      createdUser: false,
      createdMembership: false,
      repairedMembershipRole: false,
    });
    expect(records.accounts).toHaveLength(0);
    expect(records.users).toHaveLength(0);
    expect(records.memberships).toHaveLength(0);
  });

  it("creates only the configured platform admin identity records", async () => {
    const { services, records } = createServices(false);

    const result = await bootstrapPlatformAdminIdentity(services, {
      email: "ops@chasesets.com",
      displayName: "Ops Admin",
      accountName: "Chase Sets Platform",
    });

    const serializedCommands = JSON.stringify([...records.accounts, ...records.users, ...records.memberships]);

    expect(result).toMatchObject({
      userId: "usr_platform_admin",
      accountId: "acc_platform_admin",
      membershipId: "mbr_platform_admin",
      credentialId: "crd_platform_admin_password",
      createdAccount: true,
      createdUser: true,
      createdMembership: true,
      repairedMembershipRole: false,
    });
    expect(serializedCommands).toContain("ops@chasesets.com");
    expect(serializedCommands).toContain("platform-admin");
    expect(serializedCommands).not.toMatch(/demo|sample|feedback|session/i);
  });

  it("repairs an existing configured admin membership back to platform-admin", async () => {
    const { services, records } = createServices(true, "catalog-admin");

    const result = await bootstrapPlatformAdminIdentity(services, {
      email: "ops@chasesets.com",
      displayName: "Ops Admin",
      accountName: "Chase Sets Platform",
    });

    expect(result).toMatchObject({
      createdAccount: false,
      createdUser: false,
      createdMembership: false,
      repairedMembershipRole: true,
    });
    expect(records.accounts).toHaveLength(0);
    expect(records.users).toHaveLength(0);
    expect(records.memberships).toHaveLength(1);
    expect(records.memberships[0]).toMatchObject({
      streamId: "identity.membership-mbr_platform_admin",
      command: {
        type: "ChangeMembershipRole",
        roleKey: "platform-admin",
        assignmentAuthority: { type: "platform-bootstrap" },
      },
    });
  });
});
