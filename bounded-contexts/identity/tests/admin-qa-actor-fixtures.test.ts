import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_PRESETS, ROLE_PERMISSIONS } from "@chase-sets/auth-context";
import { ROLE_KEYS } from "../support/runtime-support/common";
import type { IdentityServices } from "../support/runtime-support/services";
import {
  ADMIN_QA_ACTOR_FIXTURES,
  provisionAdminQaActorFixtures,
  type AdminQaActorFixtureContacts,
} from "../support/runtime-support/admin-qa-actor-fixtures";

// A forced Consent admission would read the activation authority; the spy
// makes that read observable instead of letting it silently resolve.
const activationAuthorityReads = vi.hoisted(() => vi.fn());
vi.mock("@chase-sets/platform-policy/consent-activation-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/platform-policy/consent-activation-authority")>()),
  readConsentActivationAuthority: activationAuthorityReads,
}));

const CONTACTS: AdminQaActorFixtureContacts = {
  ADMIN_QA_PLATFORM_ADMIN_EMAIL: "admin-qa-platform-admin@chasesets.test",
  ADMIN_QA_OWNER_EMAIL: "admin-qa-owner@chasesets.test",
  ADMIN_QA_MANAGER_EMAIL: "admin-qa-manager@chasesets.test",
  ADMIN_QA_FULFILLMENT_EMAIL: "admin-qa-fulfillment@chasesets.test",
  ADMIN_QA_VIEWER_EMAIL: "admin-qa-viewer@chasesets.test",
  ADMIN_QA_CATALOG_ADMIN_EMAIL: "admin-qa-catalog-admin@chasesets.test",
};

type CommandEnvelope = Readonly<{
  streamId?: unknown;
  command?: unknown;
}>;

function createCommandRecorder(existingIds: Set<string>, idKey: "accountId" | "userId" | "membershipId") {
  const records: CommandEnvelope[] = [];
  const handler = vi.fn(async (envelope: unknown) => {
    records.push(envelope as CommandEnvelope);
    const id = ((envelope as CommandEnvelope).command as Record<string, unknown> | undefined)?.[idKey];
    if (typeof id === "string") existingIds.add(id);
    return { version: 1, state: {} };
  });

  return { handler, records };
}

/**
 * The fake exposes no Consent service at all, so a restored Consent write
 * throws instead of being recorded. Committed commands land in `existingIds`,
 * which stands in for the retained projection the fixture's existence checks
 * read, so a later run over the same set observes the earlier run's state.
 */
function createServices(existingIds: Set<string> = new Set()) {
  const accounts = createCommandRecorder(existingIds, "accountId");
  const users = createCommandRecorder(existingIds, "userId");
  const memberships = createCommandRecorder(existingIds, "membershipId");
  const queriedTables: string[] = [];

  return {
    services: {
      accounts: { commandHandler: accounts.handler },
      users: { commandHandler: users.handler },
      memberships: { commandHandler: memberships.handler },
      db: {
        query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
          queriedTables.push(/FROM (\w+)/.exec(sql)?.[1] ?? sql);
          const value = String(params?.[0] ?? "");
          return { rows: existingIds.has(value) ? [{ exists: true }] : [] };
        }),
      },
    } as unknown as IdentityServices,
    queriedTables,
    records: {
      accounts: accounts.records,
      users: users.records,
      memberships: memberships.records,
    },
  };
}

function createdFlags(results: Awaited<ReturnType<typeof provisionAdminQaActorFixtures>>) {
  return results.map(({ actorAlias, createdAccount, createdUser, createdMembership }) => [
    actorAlias,
    createdAccount,
    createdUser,
    createdMembership,
  ]);
}

afterEach(() => {
  activationAuthorityReads.mockClear();
});

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

    const results = await provisionAdminQaActorFixtures(services, CONTACTS);

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
      new Set(["acc_admin_qa_platform_admin", "usr_admin_qa_platform_admin", "mbr_admin_qa_platform_admin"]),
    );

    const results = await provisionAdminQaActorFixtures(services, CONTACTS);

    const platformAdminResult = results.find((result) => result.actorAlias === "admin-qa-platform-admin");
    expect(platformAdminResult).toMatchObject({
      createdAccount: false,
      createdUser: false,
      createdMembership: false,
    });
    expect(records.accounts).toHaveLength(5);
    expect(records.memberships).toHaveLength(5);
  });

  it("keeps evidence support-safe by returning only alias, role, host, and boolean flags", async () => {
    const { services } = createServices();

    const results = await provisionAdminQaActorFixtures(services, CONTACTS);

    for (const result of results) {
      expect(Object.keys(result).sort()).toEqual(
        [
          "actorAlias",
          "capabilities",
          "createdAccount",
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

  it.each(Object.keys(CONTACTS) as (keyof AdminQaActorFixtureContacts)[])(
    "refuses a withheld %s before any Identity command",
    async (key) => {
      const { services, records } = createServices();

      await expect(provisionAdminQaActorFixtures(services, { ...CONTACTS, [key]: " " })).rejects.toThrow(
        `Missing ${key}.`,
      );
      expect([records.accounts, records.users, records.memberships].flat()).toEqual([]);
    },
  );

  it("records no Consent and reads no activation authority across clean, repeated, retained and interrupted runs", async () => {
    const retained = new Set<string>();
    const boot = createServices(retained);
    const allCreated = ADMIN_QA_ACTOR_FIXTURES.map(({ actorAlias }) => [actorAlias, true, true, true]);
    const noneCreated = ADMIN_QA_ACTOR_FIXTURES.map(({ actorAlias }) => [actorAlias, false, false, false]);

    // Clean boot, then a repeat inside the same boot.
    expect(createdFlags(await provisionAdminQaActorFixtures(boot.services, CONTACTS))).toEqual(allCreated);
    expect(createdFlags(await provisionAdminQaActorFixtures(boot.services, CONTACTS))).toEqual(noneCreated);
    expect([boot.records.accounts, boot.records.users, boot.records.memberships].map((list) => list.length)).toEqual([
      6, 12, 6,
    ]);

    // A fresh boot over the retained state authors nothing.
    const rerun = createServices(retained);
    expect(createdFlags(await provisionAdminQaActorFixtures(rerun.services, CONTACTS))).toEqual(noneCreated);
    expect([rerun.records.accounts, rerun.records.users, rerun.records.memberships].flat()).toEqual([]);

    // A run interrupted after one Account resumes only that actor's User and Membership.
    const interrupted = createServices(new Set(["acc_admin_qa_owner"]));
    const resumed = createdFlags(await provisionAdminQaActorFixtures(interrupted.services, CONTACTS));
    expect(resumed.find(([actorAlias]) => actorAlias === "admin-qa-owner")).toEqual([
      "admin-qa-owner",
      false,
      true,
      true,
    ]);
    expect(interrupted.records.accounts).toHaveLength(5);
    expect(interrupted.records.memberships).toHaveLength(6);

    for (const run of [boot, rerun, interrupted]) {
      expect(new Set(run.queriedTables)).toEqual(
        new Set(["identity_accounts", "identity_users", "identity_memberships"]),
      );
      expect(JSON.stringify(run.records)).not.toMatch(/consent/i);
    }
    expect(activationAuthorityReads).not.toHaveBeenCalled();
  });

  it("would observe a restored Consent write and a forced activation-authority read", async () => {
    const { services } = createServices();
    // A restored write reaches for a Consent service the fake does not provide.
    expect(() => (services as unknown as { consents: { commandHandler: unknown } }).consents.commandHandler).toThrow(
      TypeError,
    );

    // A forced read through the real import specifier lands on the spy, so the
    // zero-read assertion above is backed by a live observer.
    const { readConsentActivationAuthority } = await import("@chase-sets/platform-policy/consent-activation-authority");
    await readConsentActivationAuthority(undefined as never, "identity.terms-of-service-active-version" as never);
    expect(activationAuthorityReads).toHaveBeenCalledTimes(1);
  });

  it("authors no Capability Grant and no role or preset holds the any-case key or its administration", async () => {
    const capabilityLike = /support\.evidence|any-case|capabilit/i;
    expect(ROLE_KEYS.filter((roleKey) => capabilityLike.test(roleKey))).toEqual([]);
    expect(
      Object.values(ROLE_PERMISSIONS)
        .flat()
        .filter((permission) => capabilityLike.test(permission)),
    ).toEqual([]);
    expect(
      Object.values(PERMISSION_PRESETS)
        .flat()
        .filter((permission) => capabilityLike.test(permission)),
    ).toEqual([]);
    expect(ADMIN_QA_ACTOR_FIXTURES.flatMap(({ capabilities }) => capabilities)).not.toContain(
      "support.evidence.any-case",
    );

    // A live observer: a restored fixture grant would reach these spies.
    const { services, records } = createServices();
    const accountCapabilities = {
      grantAccountCapability: vi.fn(),
      revokeAccountCapability: vi.fn(),
    };
    Object.assign(services, { accountCapabilities });
    await provisionAdminQaActorFixtures(services, CONTACTS);
    await provisionAdminQaActorFixtures(services, CONTACTS);

    expect(accountCapabilities.grantAccountCapability).not.toHaveBeenCalled();
    expect(accountCapabilities.revokeAccountCapability).not.toHaveBeenCalled();
    expect(JSON.stringify(records)).not.toMatch(/capabilit/i);
  });

  it("inventories every production assignment source: only the Identity runtime defines grant and revoke", () => {
    const repositoryRoot = path.join(import.meta.dirname, "..", "..", "..");
    const callers = ["bounded-contexts", "contracts", "deployables", "infrastructure", "packages", "scripts"].flatMap(
      (root) =>
        listProductionSources(path.join(repositoryRoot, root))
          .filter((file) =>
            /(grant|revoke)AccountCapability|"(Grant|Revoke)AccountCapability"/.test(readFileSync(file, "utf8")),
          )
          .map((file) => path.relative(repositoryRoot, file).split(path.sep).join("/")),
    );

    // Seed, production bootstrap, Admin QA fixtures, routes and hosts are absent until #9385 adds the admission path.
    expect(callers.sort()).toEqual([
      "bounded-contexts/identity/features/account-capabilities/api/runtime.ts",
      "bounded-contexts/identity/features/account-capabilities/domain/domain.ts",
    ]);
  });
});

function listProductionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ["node_modules", "dist", "build", ".turbo"].includes(entry.name) ? [] : listProductionSources(entryPath);
    }
    return /\.(ts|tsx|mts|mjs|js)$/.test(entry.name) && !/\.test\.|test-support|\.d\.ts$/.test(entry.name)
      ? [entryPath]
      : [];
  });
}
