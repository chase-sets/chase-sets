import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import {
  createInMemoryConfigurationEpochStore,
  createInMemoryConfigurationConsumer,
} from "@chase-sets/event-core/test-support";
import type { IdentityMutationPersistence } from "../../account-management/api/fences";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import { createIdentityListingActivationAuthority } from "./listing-activation-authority";
import { createPostgresConfigurationEpochStore, type PgQueryable } from "@chase-sets/event-core-postgres";

const context: EventStoreContext = {
  tenantId: "tnt_synthetic" as never,
  audit: { performedByUserId: "usr_synthetic" as never, forAccountId: "acc_synthetic" as never },
};
const input = {
  tenantId: context.tenantId,
  accountId: "acc_synthetic",
  userId: "usr_synthetic",
  membershipId: "mem_synthetic",
  consumer: { storeId: "marketplace", incarnation: "synthetic-consumer" },
};

async function fixture(roleKey = "owner") {
  const { eventStore } = createInMemoryEventStore();
  const source = createInMemoryConfigurationEpochStore("synthetic-identity");
  const consumer = createInMemoryConfigurationConsumer(input.consumer);
  const events = [
    [
      "account",
      input.accountId,
      "created",
      { accountId: input.accountId, accountType: "personal", name: "Test", displayName: "Test" },
    ],
    [
      "user",
      input.userId,
      "created",
      { userId: input.userId, displayName: "Test", givenName: "", familyName: "", primaryEmail: null },
    ],
    [
      "membership",
      input.membershipId,
      "granted",
      { membershipId: input.membershipId, accountId: input.accountId, userId: input.userId, roleKey },
    ],
  ] as const;
  for (const [kind, id, event, payload] of events) {
    await eventStore.appendToStream({
      streamId: `identity.${kind}-${id}`,
      expectedVersion: "no_stream",
      context,
      events: [{ eventType: `identity.${kind}.${event}`, payload }],
    });
    source.open(`${kind}/${id}`);
    source.registerConsumer(`${kind}/${id}`, consumer);
  }
  const poison = vi.fn(() => {
    throw new Error("projection or snapshot was read");
  });
  const read = vi.fn(async (streamId: string): Promise<readonly StoredEvent[]> => eventStore.readStream({ streamId }));
  const query = vi.fn<PgQueryable["query"]>().mockResolvedValue({ rows: [] });
  const persistence: IdentityMutationPersistence = {
    eventStore,
    transaction: async (_scopes, work) =>
      work({
        db: { query },
        read,
        append: poison,
        projectionPredicate: poison,
      }),
  };
  const authority = createIdentityListingActivationAuthority(persistence, {
    source: async () => ({
      captureGrantInTransaction: async (_db, key, target, validUntil) => ({
        ...source.captureGrant(key, target),
        ...(validUntil ? { validUntil } : {}),
      }),
      registerConsumer: async () => {
        throw new Error("unexpected topology mutation");
      },
    }),
  });
  // Unrelated caches are deliberately hostile and never supplied as authority.
  Object.assign(persistence, { snapshotStore: { loadLatest: poison }, getAccount: poison, getMembership: poison });
  return { authority, eventStore, source, poison, read, query, consumer };
}

describe("Listing Activation Authority canonical class-C capture", () => {
  it("captures the exact canonical linked-platform delegation with an expiry-bounded epoch grant", async () => {
    const f = await fixture();
    f.source.open("delegation/synthetic-delegation");
    f.source.registerConsumer("delegation/synthetic-delegation", f.consumer);
    f.query.mockImplementation(async (sql) => ({
      rows: sql.includes("FROM identity_linked_platform_authorizations")
        ? [
            {
              authorization_id: "synthetic-delegation",
              user_id: input.userId,
              account_id: input.accountId,
              client_id: "synthetic-client",
              platform_profile_url: "https://synthetic.invalid",
              scopes: ["listings:write"],
              status: "active",
              access_token_expires_at: "2099-01-01T00:00:00Z",
              absolute_expires_at: "2098-01-01T00:00:00Z",
              refresh_token_expires_at: null,
            },
          ]
        : [],
    }));
    const delegated = { ...input, delegationId: "synthetic-delegation" };
    const result = await f.authority.capture(delegated);
    expect(result.kind).toBe("granted");
    if (result.kind !== "granted") throw new Error("expected delegated grant");
    expect(result.delegation?.state).toMatchObject({ id: delegated.delegationId, scopes: ["listings:write"] });
    expect(result.grants[3]).toMatchObject({
      key: "delegation/synthetic-delegation",
      validUntil: "2098-01-01T00:00:00.000Z",
    });
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining("scopes ? 'listings:write'"), [
      delegated.delegationId,
      input.accountId,
      input.userId,
    ]);
    f.source.beginClosure("delegation/synthetic-delegation");
    expect((await f.authority.capture(delegated)).kind).toBe("denied");
    expect(f.poison).not.toHaveBeenCalled();
  });
  it.each(["synthetic-absent", ""])(
    "refuses absent, foreign, inactive or scope-mismatched canonical delegation %s",
    async (delegationId) => {
      const f = await fixture();
      expect((await f.authority.capture({ ...input, delegationId })).kind).toBe("denied");
    },
  );
  it.each(["owner", "manager"])("grants %s from exactly three canonical aggregates and seals", async (role) => {
    const f = await fixture(role);
    const result = await f.authority.capture(input);
    expect(result.kind).toBe("granted");
    if (result.kind !== "granted") throw new Error("expected grant");
    expect(result.membership.state.roleKey).toBe(role);
    expect(result.account.seal).toEqual({ version: 1, storeIncarnation: "synthetic-identity" });
    expect(result.grants.map((grant) => grant.key)).toEqual([
      "account/acc_synthetic",
      "user/usr_synthetic",
      "membership/mem_synthetic",
    ]);
    expect(f.read).toHaveBeenCalledTimes(3);
    expect(f.poison).not.toHaveBeenCalled();
  });
  it.each(["viewer", "fulfillment", "platform-admin"])(
    "refuses role %s regardless of projected permissions",
    async (role) => {
      expect((await (await fixture(role)).authority.capture(input)).kind).toBe("denied");
    },
  );
  it.each(["account", "user", "membership"])("refuses a pending %s key", async (kind) => {
    const f = await fixture();
    const id = kind === "account" ? input.accountId : kind === "user" ? input.userId : input.membershipId;
    f.source.beginClosure(`${kind}/${id}`);
    expect((await f.authority.capture(input)).kind).toBe("denied");
  });
  it.each([
    { tenantId: "tnt_foreign" },
    { accountId: "acc_foreign" },
    { userId: "usr_foreign" },
    { membershipId: "mem_absent" },
  ])("refuses foreign/absent authority %j", async (change) => {
    expect((await (await fixture()).authority.capture({ ...input, ...change })).kind).toBe("denied");
  });
  it.each(["account", "user", "membership"])("refuses inactive %s", async (kind) => {
    const f = await fixture();
    const id = kind === "account" ? input.accountId : kind === "user" ? input.userId : input.membershipId;
    await f.eventStore.appendToStream({
      streamId: `identity.${kind}-${id}`,
      expectedVersion: 1,
      context,
      events: [{ eventType: `identity.${kind}.${kind === "membership" ? "revoked" : "suspended"}`, payload: {} }],
    });
    expect((await f.authority.capture(input)).kind).toBe("denied");
  });
  it("refuses the wrong exact user-account binding and partial history", async () => {
    const f = await fixture();
    const original = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (streamId) =>
      (await original(streamId)).map((event) =>
        streamId.includes("membership-") ? { ...event, payload: { ...event.payload, userId: "usr_foreign" } } : event,
      ),
    );
    expect((await f.authority.capture(input)).kind).toBe("denied");
    f.read.mockImplementation(async (streamId) =>
      (await original(streamId)).map((event) => ({ ...event, streamVersion: 2 })),
    );
    expect((await f.authority.capture(input)).kind).toBe("denied");
  });
});

describe("Listing Activation Authority resumable PostgreSQL registration", () => {
  function fixture() {
    const journals = new Map<string, { sequence: string; record: unknown; digest: string }[]>();
    const heads = new Map<string, { sequence: string; digest: string }>();
    const query = vi.fn<PgQueryable["query"]>().mockImplementation(async (sql, values = []) => {
      const key = `${values[0] === "consumer" ? "consumer:" : ""}${values[1]}`;
      if (sql.includes("FROM event_configuration_store_identity"))
        return { rows: [{ store_id: input.consumer.storeId, incarnation: input.consumer.incarnation }] };
      if (sql.startsWith("SELECT sequence::text, digest FROM event_configuration_journal_heads"))
        return { rows: heads.has(key) ? [heads.get(key)!] : [] };
      if (sql.startsWith("SELECT sequence::text, record, digest FROM event_configuration_guard_history"))
        return { rows: journals.get(key) ?? [] };
      if (sql.startsWith("INSERT INTO event_configuration_guard_history"))
        journals.set(key, [
          ...(journals.get(key) ?? []),
          {
            sequence: String(values[2]),
            record: JSON.parse(String(values[3])),
            digest: String(values[4]),
          },
        ]);
      if (sql.startsWith("INSERT INTO event_configuration_journal_heads"))
        heads.set(key, { sequence: String(values[2]), digest: String(values[3]) });
      return { rows: [] };
    });
    const pool = { query, connect: async () => ({ query, release() {} }) };
    const source = createPostgresConfigurationEpochStore({
      pool,
      sourceIncarnation: "synthetic-identity",
      consumers: [{ identity: input.consumer, pool }],
      readCanonicalCreation: async () => ({
        kind: "CREATED",
        sourceIncarnation: "synthetic-identity",
        keyCreationEpoch: 0,
      }),
    });
    const authority = createIdentityListingActivationAuthority({} as IdentityMutationPersistence, {
      source: async () => source,
    });
    return { authority, source, journals };
  }

  it("registers a second membership on the same account without another REGISTERED or revision bump", async () => {
    const f = fixture();
    await f.authority.registerConsumer(input);
    const account = structuredClone(f.journals.get(`account/${input.accountId}`));
    const second = { ...input, userId: "usr_second", membershipId: "mem_second" };
    await f.authority.registerConsumer(second);
    await f.authority.registerConsumer(second);
    expect(f.journals.get(`account/${input.accountId}`)).toEqual(account);
    for (const key of [
      `account/${input.accountId}`,
      `user/${input.userId}`,
      `membership/${input.membershipId}`,
      "user/usr_second",
      "membership/mem_second",
    ])
      expect(await f.source.captureGrant(key, input.consumer)).toMatchObject({ topologyRevision: 1 });
    expect([...f.journals.values()].every((records) => records.length === 1)).toBe(true);
  });

  it("resumes after failure on the second key and retains CLOSING and conflicting-incarnation refusal", async () => {
    const f = fixture();
    const membership = `membership/${input.membershipId}`;
    await f.source.beginClosure(membership);
    await expect(f.authority.registerConsumer(input)).rejects.toThrow("registration waits while CLOSING");
    await f.source.installClosure(membership);
    await f.authority.registerConsumer(input);
    const records = structuredClone([...f.journals]);
    await f.authority.registerConsumer(input);
    expect([...f.journals]).toEqual(records);
    for (const key of [`account/${input.accountId}`, `user/${input.userId}`, membership])
      await expect(f.source.captureGrant(key, input.consumer)).resolves.toMatchObject({ consumer: input.consumer });
    await expect(
      f.source.registerConsumer(`account/${input.accountId}`, { ...input.consumer, incarnation: "synthetic-other" }),
    ).rejects.toThrow();
    await f.source.beginClosure(`account/${input.accountId}`);
    await expect(f.authority.registerConsumer(input)).rejects.toThrow("registration waits while CLOSING");
  });
});
