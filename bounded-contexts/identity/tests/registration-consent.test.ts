import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { publicPolicyPublicationRecords } from "@chase-sets/public-docs";
import { createPersonalIdentityForAuth } from "../api";
import type { ConsentPublicationRegistry } from "../features/consents/domain/consent-activation";
import { initialConsentState, type RecordConsentCommand } from "../features/consents/domain/domain";
import type { IdentityServices } from "../support/runtime-support/services";

const context: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_registration" as never,
    forAccountId: "acc_registration" as never,
  },
  trace: {},
};

function commandResult(status: string) {
  return {
    version: 1,
    state: { status },
    newEvents: [],
    storedEvents: [],
  };
}

function activeRegistrationPublications(): ConsentPublicationRegistry {
  return {
    ...publicPolicyPublicationRecords,
    "terms-of-service": {
      ...publicPolicyPublicationRecords["terms-of-service"],
      publicationStatus: "published",
      consentActivatable: true,
    },
    "privacy-policy": {
      ...publicPolicyPublicationRecords["privacy-policy"],
      publicationStatus: "published",
      consentActivatable: true,
    },
  } satisfies ConsentPublicationRegistry;
}

function createServices() {
  const accounts = vi.fn(async () => commandResult("active"));
  const users = vi.fn(async () => commandResult("active"));
  const memberships = vi.fn(async () => commandResult("active"));
  const consents = vi.fn<IdentityServices["consents"]["commandHandler"]>(async ({ command }) => ({
    version: 1,
    state: { ...initialConsentState, status: command.type === "RecordConsent" ? "recorded" : "withdrawn" },
    newEvents: [],
    storedEvents: [],
  }));
  const db = {
    query: vi.fn(async (sql: string) =>
      sql.includes("INSERT INTO identity_account_display_name_reservations")
        ? { rows: [{ display_name_key: "new user" }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    ),
  };
  const policies = {
    resolvePolicy: vi.fn(async (definition: { policyKey: string }) => ({
      policyKey: definition.policyKey,
      value: { version: "v1" },
      source: "policy" as const,
      documentId: `pol_${definition.policyKey}`,
      effectiveFrom: "2026-07-24T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: "2026-07-24T00:00:00.000Z",
    })),
  };
  const services = {
    db,
    accounts: { commandHandler: accounts },
    users: { commandHandler: users },
    memberships: { commandHandler: memberships },
    consents: { commandHandler: consents },
    policies,
  } as unknown as IdentityServices;

  return { services, db, accounts, users, memberships, consents, policies };
}

describe("registration consent affirmation", () => {
  it("rejects a missing required affirmation before any reservation or aggregate command", async () => {
    const harness = createServices();

    await expect(
      createPersonalIdentityForAuth(
        harness.services,
        {
          email: "new.user@chasesets.test",
          displayName: "New User",
          consentAffirmed: false,
          context,
        },
        activeRegistrationPublications(),
      ),
    ).rejects.toThrow(/requires affirmation/);

    expect(harness.db.query).not.toHaveBeenCalled();
    expect(harness.accounts).not.toHaveBeenCalled();
    expect(harness.users).not.toHaveBeenCalled();
    expect(harness.memberships).not.toHaveBeenCalled();
    expect(harness.consents).not.toHaveBeenCalled();
  });

  it("records one user-scoped Consent for each active bundle member after affirmation", async () => {
    const harness = createServices();

    const result = await createPersonalIdentityForAuth(
      harness.services,
      {
        email: "new.user@chasesets.test",
        displayName: "New User",
        consentAffirmed: true,
        context,
      },
      activeRegistrationPublications(),
    );

    expect(result.snapshots.filter((snapshot) => snapshot.aggregate === "consent")).toHaveLength(2);
    expect(harness.consents).toHaveBeenCalledTimes(2);
    expect(
      harness.consents.mock.calls
        .map(([call]) => call.command)
        .filter((command): command is RecordConsentCommand => command.type === "RecordConsent")
        .map((command) => ({
          policyKey: command.policyKey,
          policyVersion: command.policyVersion,
          subjectType: command.subjectType,
          userId: command.userId,
          accountId: command.accountId,
        })),
    ).toEqual([
      {
        policyKey: "terms-of-service",
        policyVersion: "v1",
        subjectType: "user",
        userId: result.userId,
        accountId: result.accountId,
      },
      {
        policyKey: "privacy-policy",
        policyVersion: "v1",
        subjectType: "user",
        userId: result.userId,
        accountId: result.accountId,
      },
    ]);
  });

  it("creates the identity without Consent facts while the registration bundle is inactive", async () => {
    const harness = createServices();

    const result = await createPersonalIdentityForAuth(
      harness.services,
      {
        email: "new.user@chasesets.test",
        displayName: "New User",
        consentAffirmed: false,
        context,
      },
      publicPolicyPublicationRecords,
    );

    expect(result.snapshots.some((snapshot) => snapshot.aggregate === "account")).toBe(true);
    expect(harness.consents).not.toHaveBeenCalled();
    expect(harness.policies.resolvePolicy).not.toHaveBeenCalled();
  });
});
