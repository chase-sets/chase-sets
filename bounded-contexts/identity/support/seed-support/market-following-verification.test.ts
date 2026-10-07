import { getEventCommitMetadata } from "@chase-sets/event-core/consistency";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { describe, expect, it, vi } from "vitest";
import { createUserRuntime } from "../../features/users/api/runtime";
import type { IdentityRuntimeDeps } from "../runtime-support";
import {
  assertOwnedSandboxIdentityDatabaseUrl,
  requireIdentityCommitSource,
  verifyMarketFollowingBuyerContact,
} from "./market-following-verification";

const SYNTHETIC_USER_ID = "usr_synthetic_market_following_buyer";
const SYNTHETIC_EMAIL = "synthetic-market-following-buyer@chasesets.test";
const SYNTHETIC_CONTACT_METHOD_ID = `${SYNTHETIC_USER_ID}-primary-email`;

const syntheticContext: EventStoreContext = {
  tenantId: "tnt_synthetic_market_following" as never,
  audit: {
    performedByUserId: "usr_synthetic_market_following_operator" as never,
    forAccountId: "acc_synthetic_market_following" as never,
  },
  trace: {},
};

function createHarness() {
  const memory = createInMemoryEventStore();
  const deps: IdentityRuntimeDeps = {
    eventStore: memory.eventStore,
    checkpointStore: {
      loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
      saveCheckpoint: async () => undefined,
    },
    db: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never,
  };
  const users = createUserRuntime(deps);
  return { memory, deps, users };
}

async function seedSyntheticBuyer(users: ReturnType<typeof createUserRuntime>, email = SYNTHETIC_EMAIL) {
  await users.commandHandler({
    streamId: `identity.user-${SYNTHETIC_USER_ID}`,
    command: {
      type: "CreateUser",
      userId: SYNTHETIC_USER_ID as never,
      displayName: "Synthetic Market Following Buyer",
      primaryEmail: email,
      givenName: "Synthetic",
      familyName: "Buyer",
    },
    context: syntheticContext,
  });
}

function verifiedEvents(memory: ReturnType<typeof createInMemoryEventStore>) {
  return memory.readAllEvents().filter((event) => event.eventType === "identity.user.contact-method-verified");
}

describe("market-following buyer verification fixture", () => {
  it("verifies the stored primary email contact of an unverified user through the existing command", async () => {
    const { memory, deps, users } = createHarness();
    await seedSyntheticBuyer(users);
    const before = await users.getUserState(SYNTHETIC_USER_ID);
    expect(before?.contactMethods).toEqual([
      { contactMethodId: SYNTHETIC_CONTACT_METHOD_ID, type: "email", value: SYNTHETIC_EMAIL, verifiedAt: null },
    ]);

    const commit = await verifyMarketFollowingBuyerContact(deps, {
      userId: SYNTHETIC_USER_ID,
      primaryEmail: SYNTHETIC_EMAIL,
      verifiedAt: "2026-09-28T15:00:00.000Z",
      context: syntheticContext,
    });

    const events = verifiedEvents(memory);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      contactMethodId: SYNTHETIC_CONTACT_METHOD_ID,
      verifiedAt: "2026-09-28T15:00:00.000Z",
    });
    expect(commit).toEqual({
      userId: SYNTHETIC_USER_ID,
      contactMethodId: SYNTHETIC_CONTACT_METHOD_ID,
      verifiedAt: "2026-09-28T15:00:00.000Z",
      previouslyVerifiedAt: null,
      sources: [
        {
          sourceContextName: "identity",
          eventIds: [String(events[0]?.eventId)],
          maxGlobalPosition: String(events[0]?.globalPosition),
        },
      ],
    });
    const after = await users.getUserState(SYNTHETIC_USER_ID);
    expect(after?.contactMethods[0]?.verifiedAt).toBe("2026-09-28T15:00:00.000Z");
  });

  it("commits a fresh verification event on every invocation, including an already-verified contact", async () => {
    const { memory, deps, users } = createHarness();
    await seedSyntheticBuyer(users);
    const first = await verifyMarketFollowingBuyerContact(deps, {
      userId: SYNTHETIC_USER_ID,
      primaryEmail: SYNTHETIC_EMAIL,
      verifiedAt: "2026-09-28T15:00:00.000Z",
      context: syntheticContext,
    });
    const second = await verifyMarketFollowingBuyerContact(deps, {
      userId: SYNTHETIC_USER_ID,
      primaryEmail: SYNTHETIC_EMAIL,
      verifiedAt: "2026-09-28T15:00:01.000Z",
      context: syntheticContext,
    });

    expect(second.previouslyVerifiedAt).toBe("2026-09-28T15:00:00.000Z");
    expect(second.contactMethodId).toBe(first.contactMethodId);
    const events = verifiedEvents(memory);
    expect(events).toHaveLength(2);
    const firstSource = requireIdentityCommitSource(first.sources);
    const secondSource = requireIdentityCommitSource(second.sources);
    expect(firstSource.eventIds).toEqual([String(events[0]?.eventId)]);
    expect(secondSource.eventIds).toEqual([String(events[1]?.eventId)]);
    expect(secondSource.eventIds).not.toEqual(firstSource.eventIds);
    expect(BigInt(secondSource.maxGlobalPosition)).toBeGreaterThan(BigInt(firstSource.maxGlobalPosition));
    expect(secondSource.maxGlobalPosition).toBe(String(events[1]?.globalPosition));
  });

  it("returns only the metadata captured inside the command scope and leaks nothing outside it", async () => {
    const { memory, deps, users } = createHarness();
    await seedSyntheticBuyer(users);
    const commit = await verifyMarketFollowingBuyerContact(deps, {
      userId: SYNTHETIC_USER_ID,
      primaryEmail: SYNTHETIC_EMAIL,
      context: syntheticContext,
    });

    const committed = verifiedEvents(memory);
    expect(commit.sources).toHaveLength(1);
    expect(commit.sources[0]).toEqual({
      sourceContextName: "identity",
      eventIds: committed.map((event) => String(event.eventId)),
      maxGlobalPosition: String(committed.at(-1)?.globalPosition),
    });
    expect(Object.keys(commit).sort()).toEqual(
      ["contactMethodId", "previouslyVerifiedAt", "sources", "userId", "verifiedAt"].sort(),
    );
    expect(getEventCommitMetadata()).toEqual({ eventIds: [], sources: [], committedEvents: [] });
  });

  it("accepts the primary email case-insensitively and reports the stored contact id", async () => {
    const { deps, users } = createHarness();
    await seedSyntheticBuyer(users);
    const commit = await verifyMarketFollowingBuyerContact(deps, {
      userId: SYNTHETIC_USER_ID,
      primaryEmail: "  Synthetic-Market-Following-Buyer@ChaseSets.test ",
      context: syntheticContext,
    });
    expect(commit.contactMethodId).toBe(SYNTHETIC_CONTACT_METHOD_ID);
  });

  it("refuses users that do not exist or do not own the expected primary email", async () => {
    const { memory, deps, users } = createHarness();
    await expect(
      verifyMarketFollowingBuyerContact(deps, {
        userId: SYNTHETIC_USER_ID,
        primaryEmail: SYNTHETIC_EMAIL,
        context: syntheticContext,
      }),
    ).rejects.toThrow(/does not exist/);

    await seedSyntheticBuyer(users);
    await expect(
      verifyMarketFollowingBuyerContact(deps, {
        userId: SYNTHETIC_USER_ID,
        primaryEmail: "someone-else@chasesets.test",
        context: syntheticContext,
      }),
    ).rejects.toThrow(/does not own the expected primary email/);
    expect(verifiedEvents(memory)).toHaveLength(0);
  });

  it("rejects absent, empty, wrong-source and eventless commit receipts", () => {
    expect(() => requireIdentityCommitSource(undefined)).toThrow(/no commit receipt/);
    expect(() => requireIdentityCommitSource([])).toThrow(/no commit receipt/);
    expect(() =>
      requireIdentityCommitSource([{ sourceContextName: "pricing", eventIds: ["evt_1"], maxGlobalPosition: "1" }]),
    ).toThrow(/names pricing instead of identity/);
    expect(() =>
      requireIdentityCommitSource([{ sourceContextName: "identity", eventIds: [], maxGlobalPosition: "1" }]),
    ).toThrow(/carries no committed events/);
    expect(
      requireIdentityCommitSource([
        { sourceContextName: "auth", eventIds: ["evt_9"], maxGlobalPosition: "9" },
        { sourceContextName: "identity", eventIds: ["evt_2"], maxGlobalPosition: "2" },
      ]),
    ).toEqual({ sourceContextName: "identity", eventIds: ["evt_2"], maxGlobalPosition: "2" });
  });

  describe("owned sandbox Identity database guard", () => {
    const companionDatabaseUrl = "postgres://cs_sandbox:secret-companion@127.0.0.1:10520/cs_sandbox_e2e_catalog";

    it("accepts the loopback Identity database of the same owned sandbox family", () => {
      const url = assertOwnedSandboxIdentityDatabaseUrl({
        identityDatabaseUrl: "postgres://cs_sandbox:secret-identity@127.0.0.1:10520/cs_sandbox_e2e_identity",
        companionDatabaseUrl,
      });
      expect(url.pathname).toBe("/cs_sandbox_e2e_identity");
    });

    it.each([
      [
        "a non-loopback host",
        "postgres://cs_sandbox:secret-identity@db.example.test:10520/cs_sandbox_e2e_identity",
        /loopback/,
      ],
      [
        "a different sandbox host or port",
        "postgres://cs_sandbox:secret-identity@127.0.0.1:10521/cs_sandbox_e2e_identity",
        /owned sandbox host/,
      ],
      [
        "a different database family",
        "postgres://cs_sandbox:secret-identity@127.0.0.1:10520/cs_other_e2e_identity",
        /owned sandbox Identity database/,
      ],
      [
        "a non-Identity suffix",
        "postgres://cs_sandbox:secret-identity@127.0.0.1:10520/cs_sandbox_e2e_auth",
        /owned sandbox Identity database/,
      ],
      ["an unparseable URL", "not a url", /unparseable Identity database URL/],
      ["an empty URL", "", /requires the owned sandbox Identity database URL/],
    ])("rejects %s without echoing credentials", (_label, identityDatabaseUrl, expected) => {
      let caught: unknown;
      try {
        assertOwnedSandboxIdentityDatabaseUrl({ identityDatabaseUrl, companionDatabaseUrl });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(expected);
      expect((caught as Error).message).not.toContain("secret-identity");
      expect((caught as Error).message).not.toContain("secret-companion");
    });

    it("rejects a companion database outside the owned Catalog family", () => {
      expect(() =>
        assertOwnedSandboxIdentityDatabaseUrl({
          identityDatabaseUrl: "postgres://cs_sandbox:secret-identity@127.0.0.1:10520/cs_sandbox_e2e_identity",
          companionDatabaseUrl: "postgres://cs_sandbox:secret-companion@127.0.0.1:10520/cs_sandbox_e2e_pricing",
        }),
      ).toThrow(/owned sandbox Catalog database family/);
    });
  });
});
