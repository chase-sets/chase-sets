import { describe, expect, it, vi } from "vitest";
import type { IdentityServices } from "../support/runtime-support/services";
import {
  ADMIN_QA_ACTOR_FIXTURES,
  provisionAdminQaActorFixtures,
} from "../support/runtime-support/admin-qa-actor-fixtures";

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

function createServices(existingIds: ReadonlySet<string> = new Set()) {
  const accounts = createCommandRecorder();
  const users = createCommandRecorder();
  const memberships = createCommandRecorder();
  const consents = createCommandRecorder();

  return {
    services: {
      accounts: { commandHandler: accounts.handler },
      users: { commandHandler: users.handler },
      memberships: { commandHandler: memberships.handler },
      consents: { commandHandler: consents.handler },
      db: {
        query: vi.fn(async (_sql: string, params?: readonly unknown[]) => {
          const value = String(params?.[0] ?? "");
          return { rows: existingIds.has(value) ? [{ exists: true }] : [] };
        }),
      },
    } as unknown as IdentityServices,
    records: {
      accounts: accounts.records,
      users: users.records,
      memberships: memberships.records,
      consents: consents.records,
    },
  };
}

describe("admin-qa actor fixtures", () => {
  it("defines exactly the actor aliases and sign-in hosts the staging QA actor matrix requires", () => {
    expect(
      ADMIN_QA_ACTOR_FIXTURES.map((fixture) => [
        fixture.actorAlias,
        fixture.roleKey,
        fixture.signInHost,
        fixture.capabilities,
      ]),
    ).toEqual([
      [
        "admin-qa-platform-admin",
        "platform-admin",
        "/access/sign-in",
        ["customer-submit", "staff-view", "staff-manage", "staff-export"],
      ],
      ["admin-qa-owner", "owner", "/access/sign-in", ["customer-submit"]],
      ["admin-qa-manager", "manager", "/access/sign-in", ["customer-submit"]],
      ["admin-qa-fulfillment", "fulfillment", "/access/sign-in", ["customer-submit"]],
      ["admin-qa-viewer", "viewer", "/access/sign-in", ["customer-submit"]],
      ["admin-qa-catalog-admin", "manager", "/catalog/sign-in", ["customer-submit"]],
    ]);
  });

  it("does not give ordinary account roles staff feedback capabilities", () => {
    expect(
      ADMIN_QA_ACTOR_FIXTURES.filter((fixture) => fixture.roleKey !== "platform-admin").every(
        (fixture) => fixture.capabilities.length === 1 && fixture.capabilities[0] === "customer-submit",
      ),
    ).toBe(true);
  });

  it("creates every fixture when none exist yet, using magic-link auth and platform-bootstrap authority for platform-admin", async () => {
    const { services, records } = createServices();

    const results = await provisionAdminQaActorFixtures(services);

    expect(results).toHaveLength(6);
    expect(results.every((result) => result.createdAccount && result.createdUser && result.createdMembership)).toBe(
      true,
    );
    expect(records.accounts).toHaveLength(6);
    expect(records.users.filter((record) => (record.command as { type: string }).type === "CreateUser")).toHaveLength(
      6,
    );
    expect(
      records.users.filter((record) => (record.command as { type: string }).type === "EnableAuthMethod"),
    ).toHaveLength(6);
    expect(
      records.users.every((record) => {
        const command = record.command as { type: string; authMethod?: string };
        return command.type !== "EnableAuthMethod" || command.authMethod === "magic-link";
      }),
    ).toBe(true);

    const platformAdminGrant = records.memberships.find(
      (record) => record.streamId === "identity.membership-mbr_admin_qa_platform_admin",
    );
    expect(platformAdminGrant?.command).toMatchObject({
      type: "GrantMembership",
      roleKey: "platform-admin",
      assignmentAuthority: { type: "platform-bootstrap" },
    });

    const ownerGrant = records.memberships.find(
      (record) => record.streamId === "identity.membership-mbr_admin_qa_owner",
    );
    expect(ownerGrant?.command).toMatchObject({
      type: "GrantMembership",
      roleKey: "owner",
      assignmentAuthority: { type: "system" },
    });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("password");
  });

  it("is idempotent: skips already-provisioned fixtures", async () => {
    const { services, records } = createServices(
      new Set([
        "acc_admin_qa_platform_admin",
        "usr_admin_qa_platform_admin",
        "mbr_admin_qa_platform_admin",
        "cns_admin_qa_platform_admin",
      ]),
    );

    const results = await provisionAdminQaActorFixtures(services);

    const platformAdminResult = results.find((result) => result.actorAlias === "admin-qa-platform-admin");
    expect(platformAdminResult).toMatchObject({
      createdAccount: false,
      createdUser: false,
      createdMembership: false,
      createdConsent: false,
    });
    expect(records.accounts).toHaveLength(5);
    expect(records.memberships).toHaveLength(5);
  });

  it("keeps evidence support-safe by returning only alias, role, host, and boolean flags", async () => {
    const { services } = createServices();

    const results = await provisionAdminQaActorFixtures(services);

    for (const result of results) {
      expect(Object.keys(result).sort()).toEqual(
        [
          "actorAlias",
          "capabilities",
          "createdAccount",
          "createdConsent",
          "createdMembership",
          "createdUser",
          "roleKey",
          "signInHost",
        ].sort(),
      );
    }
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain("@chasesets.test");
    expect(serialized).not.toContain("acc_admin_qa");
    expect(serialized).not.toContain("usr_admin_qa");
  });
});
