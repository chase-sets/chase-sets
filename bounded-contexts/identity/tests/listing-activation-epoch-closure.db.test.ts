import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPgPool,
  createPostgresEventStore,
  createPostgresProjectionStore,
  initializeConfigurationConsumer,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres/schema";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import { createIdentityMutationPersistence } from "../features/account-management/api/fences";
import { createIdentityOwnerEpochs } from "../features/accounts/api/owner-epochs";
import { createIdentityListingActivationAuthority } from "../features/accounts/api/listing-activation-authority";
import { createAccountRuntime } from "../features/accounts/api/runtime";
import { createUserRuntime } from "../features/users/api/runtime";
import { createMembershipRuntime } from "../features/memberships/api/runtime";

const adminUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !adminUrl) throw new Error("TEST_DATABASE_URL required for Identity epoch closure proof");
const describeDb = adminUrl ? describe : describe.skip;
const consumer = { storeId: "marketplace", incarnation: "synthetic-consumer" };
const context: EventStoreContext = {
  tenantId: "tnt_synthetic" as never,
  audit: { performedByUserId: "usr_synthetic" as never, forAccountId: "acc_synthetic" as never },
};
const authorityInput = {
  tenantId: context.tenantId,
  accountId: "acc_synthetic",
  userId: "usr_synthetic",
  membershipId: "mem_synthetic",
  consumer,
};
const writers = [
  {
    name: "account command handler",
    key: "account/acc_synthetic",
    event: "identity.account.suspended",
    mutant: "REMOVE_ACCOUNT_COMMAND_ENROLLMENT",
  },
  {
    name: "user command handler",
    key: "user/usr_synthetic",
    event: "identity.user.suspended",
    mutant: "REMOVE_USER_COMMAND_ENROLLMENT",
  },
  {
    name: "membership command handler",
    key: "membership/mem_synthetic",
    event: "identity.membership.revoked",
    mutant: "REMOVE_MEMBERSHIP_COMMAND_ENROLLMENT",
  },
  {
    name: "atomic registration/invitation batch",
    key: "membership/mem_synthetic",
    event: "identity.membership.role-changed",
    mutant: "REMOVE_ATOMIC_BATCH_ENROLLMENT",
  },
  {
    name: "account-management transaction append",
    key: "account/acc_synthetic",
    event: "identity.account.suspended",
    mutant: "REMOVE_TRANSACTION_APPEND_ENROLLMENT",
  },
] as const;
type Writer = (typeof writers)[number];
async function end(pool: PgTransactionalPool | undefined) {
  if (pool && "end" in pool && typeof pool.end === "function") await pool.end();
}

describeDb("Identity physical writer epoch closure against a separate consumer store", () => {
  let ownerPool: PgTransactionalPool;
  let consumerPool: PgTransactionalPool;
  const databases: string[] = [];
  beforeAll(async () => {
    const admin = createPgPool(adminUrl!);
    try {
      for (const role of ["owner", "consumer"]) {
        const name = `identity_epoch_${role}_${randomUUID().replaceAll("-", "")}`;
        await admin.query(`CREATE DATABASE ${name}`);
        databases.push(name);
      }
    } finally {
      await end(admin);
    }
    const urls = databases.map((name) => {
      const url = new URL(adminUrl!);
      url.pathname = `/${name}`;
      return url.href;
    });
    ownerPool = createPgPool(urls[0], { max: 6 });
    consumerPool = createPgPool(urls[1], { max: 6 });
    await ownerPool.query(eventCorePostgresSchemaSql);
    await consumerPool.query(eventCorePostgresSchemaSql);
  });
  beforeEach(async () => {
    for (const pool of [ownerPool, consumerPool])
      await pool.query(
        "TRUNCATE event_configuration_guard_history, event_configuration_journal_heads, event_configuration_store_identity, event_store_events, event_store_streams CASCADE",
      );
    await initializeConfigurationConsumer(consumerPool, consumer);
  });
  afterAll(async () => {
    await end(ownerPool);
    await end(consumerPool);
    const admin = createPgPool(adminUrl!);
    try {
      for (const name of databases) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    } finally {
      await end(admin);
    }
  });

  async function fixture() {
    const raw = createPostgresEventStore({ pool: ownerPool });
    const epochs = createIdentityOwnerEpochs(ownerPool, [{ identity: consumer, pool: consumerPool }]);
    const persistence = createIdentityMutationPersistence(ownerPool, raw, () => [], epochs);
    const deps = {
      eventStore: persistence.eventStore,
      checkpointStore: createPostgresProjectionStore({ db: ownerPool }),
      db: ownerPool,
    };
    const accounts = createAccountRuntime(deps),
      users = createUserRuntime(deps),
      memberships = createMembershipRuntime(deps);
    await accounts.commandHandler({
      streamId: "identity.account-acc_synthetic",
      command: { type: "CreateAccount", accountId: "acc_synthetic" as never, name: "Test", accountType: "personal" },
      context,
    });
    await users.commandHandler({
      streamId: "identity.user-usr_synthetic",
      command: {
        type: "CreateUser",
        userId: "usr_synthetic" as never,
        displayName: "Test",
        primaryEmail: "synthetic@example.test",
      },
      context,
    });
    await memberships.commandHandler({
      streamId: "identity.membership-mem_synthetic",
      command: {
        type: "GrantMembership",
        membershipId: "mem_synthetic" as never,
        userId: "usr_synthetic" as never,
        accountId: "acc_synthetic" as never,
        roleKey: "manager",
        assignmentAuthority: { type: "system" },
      },
      context,
    });
    const authority = createIdentityListingActivationAuthority(persistence, epochs);
    await authority.registerConsumer(authorityInput);
    const grant = await authority.capture(authorityInput);
    if (grant.kind !== "granted") throw new Error("fixture authority refused");
    const terminalStore = createPostgresEventStore({ pool: consumerPool });
    const terminal: AppendToStreamInput = {
      streamId: "synthetic.terminal",
      expectedVersion: "no_stream",
      context,
      configurationGrants: grant.grants,
      events: [{ eventType: "synthetic.committed", payload: {} }],
    };
    async function write(writer: Writer) {
      if (writer.name === "account command handler")
        return accounts.commandHandler({
          streamId: "identity.account-acc_synthetic",
          command: {
            type: "SuspendAccount",
            enforcement: {
              version: 1,
              enforcementActionId: `enf_${randomUUID()}` as never,
              reason: "operator-other",
              reference: null,
            },
          },
          context,
        });
      if (writer.name === "user command handler")
        return users.commandHandler({
          streamId: "identity.user-usr_synthetic",
          command: { type: "SuspendUser" },
          context,
        });
      if (writer.name === "membership command handler")
        return memberships.commandHandler({
          streamId: "identity.membership-mem_synthetic",
          command: { type: "RevokeMembership" },
          context,
        });
      const change: AppendToStreamInput = {
        streamId: writer.key.startsWith("account/")
          ? "identity.account-acc_synthetic"
          : "identity.membership-mem_synthetic",
        expectedVersion: 1,
        context,
        events: [
          { eventType: writer.event, payload: writer.event.endsWith("role-changed") ? { roleKey: "viewer" } : {} },
        ],
      };
      const audit: AppendToStreamInput = {
        streamId: "synthetic.audit",
        expectedVersion: "no_stream",
        context,
        events: [{ eventType: "synthetic.audit", payload: {} }],
      };
      if (writer.name === "account-management transaction append")
        return persistence.transaction([], (tx) => tx.append!([change, audit]));
      return persistence.eventStore.appendToStreams!([change, audit]);
    }
    return { raw, epochs, authority, terminalStore, terminal, write };
  }

  it.each(writers)("$name: close-first refuses stale terminal, next epoch succeeds", async (writer) => {
    const f = await fixture();
    await f.write(writer);
    await expect(f.terminalStore.appendToStreams!([f.terminal])).rejects.toMatchObject({
      code: "concurrency_conflict",
    });
    expect(await f.terminalStore.readStream({ streamId: f.terminal.streamId })).toHaveLength(0);
    const source = await f.epochs.source();
    const next = await Promise.all(
      f.terminal.configurationGrants!.map((grant) => source.captureGrant(grant.key, consumer)),
    );
    expect(next.find((grant) => grant.key === writer.key)?.epoch).toBe(1);
    await f.terminalStore.appendToStreams!([{ ...f.terminal, configurationGrants: next }]);
    expect(await f.terminalStore.readStream({ streamId: f.terminal.streamId })).toHaveLength(1);
  });

  it.each(writers)("$name: $mutant makes the stale-terminal refusal oracle fail", async (writer) => {
    const f = await fixture();
    const omit = vi.spyOn(f.epochs, "enroll").mockResolvedValue();
    await f.write(writer);
    omit.mockRestore();
    // Named enrollment omission is a synthetic negative, never an expected production PASS.
    const refused = await f.terminalStore.appendToStreams!([f.terminal]).then(
      () => false,
      () => true,
    );
    expect(refused, writer.mutant).toBe(false);
  });

  it.each(writers)("$name: terminal-first cannot install until consumer COMMIT", async (writer) => {
    const f = await fixture();
    const source = await f.epochs.source();
    const client = await consumerPool.connect();
    let writing: Promise<unknown> | undefined;
    try {
      await client.query("BEGIN");
      await f.terminalStore.appendToStreamsInTransaction(client, [f.terminal]);
      writing = f.write(writer);
      let status = await source.status(writer.key);
      for (let attempt = 0; attempt < 100 && status.status === "OPEN"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = await source.status(writer.key);
      }
      expect(status.status).toBe("PENDING");
      const stream = writer.key.startsWith("account/")
        ? "identity.account-acc_synthetic"
        : writer.key.startsWith("user/")
          ? "identity.user-usr_synthetic"
          : "identity.membership-mem_synthetic";
      expect(await f.raw.readStream({ streamId: stream })).toHaveLength(1);
      await client.query("COMMIT");
      await writing;
      expect((await source.status(writer.key)).epoch).toBe(1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      if (writing) await writing;
    }
  });

  it("uses the canonical creation epoch without synthesizing Guard History", async () => {
    const f = await fixture();
    const history = await ownerPool.query<{ record: { kind: string } }>(
      "SELECT record FROM event_configuration_guard_history WHERE role = 'source'",
    );
    expect(history.rows.every((row) => row.record.kind === "REGISTERED")).toBe(true);
    expect((await f.authority.capture(authorityInput)).kind).toBe("granted");
  });
});
