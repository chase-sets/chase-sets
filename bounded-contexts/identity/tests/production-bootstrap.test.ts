import { describe, expect, it, vi } from "vitest";
import type { IdentityServices } from "../support/runtime-support/services";
import { bootstrapPlatformAdminIdentity } from "../support/runtime-support/production-bootstrap";

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
      },
    });
  });
});
