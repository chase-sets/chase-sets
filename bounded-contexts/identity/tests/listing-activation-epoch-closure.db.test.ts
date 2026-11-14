import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  initializeConfigurationConsumer,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres/schema";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import { createIdentityMutationPersistence } from "../features/account-management/api/fences";
import { createIdentityOwnerEpochs } from "../features/accounts/api/owner-epochs";
import { createIdentityListingActivationAuthority } from "../features/accounts/api/listing-activation-authority";
import { createAccountRuntime } from "../features/accounts/api/runtime";
import { createUserRuntime } from "../features/users/api/runtime";
import { createMembershipRuntime } from "../features/memberships/api/runtime";
import {
  createLinkedPlatformAuthorizationStore,
  identityLinkedPlatformAuthorizationSchemaSql,
} from "../support/ucp-support/linked-platform-authorizations";
import { createAgentGrantRevocations, type RevocationState } from "../features/agent-grants/api/revocation";

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

describeDb("Identity physical writer epoch closure against a separate consumer store", () => {
  let pools: Readonly<Record<"identity" | "marketplace", PgTransactionalPool>>;
  let ownerPool: PgTransactionalPool;
  let consumerPool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminUrl!, ["identity", "marketplace"], "identity_epoch_10406");
    await ensureMultiContextTestDatabases(adminUrl!, urls);
    pools = createMultiContextTestPools(urls);
    ownerPool = pools.identity;
    consumerPool = pools.marketplace;
    await ownerPool.query(eventCorePostgresSchemaSql);
    await ownerPool.query(identityLinkedPlatformAuthorizationSchemaSql);
    await consumerPool.query(eventCorePostgresSchemaSql);
  });
  beforeEach(async () => {
    for (const pool of [ownerPool, consumerPool])
      await pool.query(
        "TRUNCATE event_configuration_guard_history, event_configuration_journal_heads, event_configuration_store_identity, event_store_events, event_store_streams CASCADE",
      );
    await initializeConfigurationConsumer(consumerPool, consumer);
    await ownerPool.query("TRUNCATE identity_linked_platform_authorizations");
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
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
              enforcementActionId: createId("enf"),
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
    return { raw, epochs, authority, terminalStore, terminal, write, persistence, users, memberships };
  }

  it("registers a second membership sharing an account and resumes a partially committed registration", async () => {
    const f = await fixture();
    const second = { ...authorityInput, userId: "usr_second", membershipId: "mem_second" };
    await f.users.commandHandler({
      streamId: "identity.user-usr_second",
      command: {
        type: "CreateUser",
        userId: "usr_second" as never,
        displayName: "Second",
        primaryEmail: "second@example.test",
      },
      context,
    });
    await f.memberships.commandHandler({
      streamId: "identity.membership-mem_second",
      command: {
        type: "GrantMembership",
        membershipId: "mem_second" as never,
        userId: "usr_second" as never,
        accountId: authorityInput.accountId as never,
        roleKey: "manager",
        assignmentAuthority: { type: "system" },
      },
      context,
    });
    const source = await f.epochs.source();
    await source.beginClosure("membership/mem_second");
    await expect(f.authority.registerConsumer(second)).rejects.toThrow("CLOSING");
    await source.installClosure("membership/mem_second");
    await f.authority.registerConsumer(second);
    const before = await ownerPool.query(
      "SELECT key, sequence, digest FROM event_configuration_journal_heads ORDER BY key",
    );
    await Promise.all([f.authority.registerConsumer(second), f.authority.registerConsumer(authorityInput)]);
    expect(
      (await ownerPool.query("SELECT key, sequence, digest FROM event_configuration_journal_heads ORDER BY key")).rows,
    ).toEqual(before.rows);
    expect((await f.authority.capture(authorityInput)).kind).toBe("granted");
    expect((await f.authority.capture(second)).kind).toBe("granted");
  });

  const delegationWriters = [
    { name: "grant", mutant: "REMOVE_DELEGATION_GRANT_ENROLLMENT" },
    { name: "rotateRefreshToken", mutant: "REMOVE_DELEGATION_ROTATION_ENROLLMENT" },
    { name: "revokeToken", mutant: "REMOVE_DELEGATION_TOKEN_REVOCATION_ENROLLMENT" },
    { name: "revokeAuthorization", mutant: "REMOVE_DELEGATION_AUTHORIZATION_REVOCATION_ENROLLMENT" },
    { name: "advance", mutant: "REMOVE_DELEGATION_ADVANCE_ENROLLMENT" },
  ] as const;
  type DelegationWriter = (typeof delegationWriters)[number];
  const delegationKey = "delegation/synthetic-delegation";
  async function delegationFixture() {
    const f = await fixture();
    const grant = {
      authorizationId: "synthetic-delegation",
      platformProfileUrl: "https://synthetic.invalid",
      clientId: "synthetic-client",
      userId: authorityInput.userId,
      accountId: authorityInput.accountId,
      scopes: ["listings:write"],
      accessTokenHash: "synthetic-access",
      refreshTokenHash: "synthetic-refresh",
      accessTokenExpiresAt: "2099-01-01T00:00:00Z",
      refreshTokenExpiresAt: "2099-02-01T00:00:00Z",
      grantedAt: "2026-11-01T00:00:00Z",
    };
    const linked = createLinkedPlatformAuthorizationStore(ownerPool, f.epochs);
    await linked.grant(grant);
    const delegatedInput = { ...authorityInput, delegationId: grant.authorizationId };
    await f.authority.registerConsumer(delegatedInput);
    const captured = await f.authority.capture(delegatedInput);
    if (captured.kind !== "granted") throw new Error("delegation capture refused");
    const terminal = { ...f.terminal, configurationGrants: captured.grants };
    const owner = {
      operationId: "eea0342d-079b-460e-9dfe-06c42a0a8a70",
      accountId: grant.accountId,
      grantId: grant.authorizationId,
      revokedAt: "2026-11-14T00:00:00.000Z",
      reason: "account_consent_revoked",
      provenance: "session" as const,
    };
    await f.raw.appendToStream({
      streamId: `identity.agent-grant-revocation-${createHash("sha256")
        .update(JSON.stringify([owner.accountId, owner.grantId]))
        .digest("hex")}`,
      expectedVersion: "no_stream",
      context,
      events: [{ eventType: "identity.agent-grant-revocation.admitted", payload: owner }],
    });
    const state: RevocationState = { ...owner, phase: "admitted", version: 1, effectContext: context };
    async function write(writer: DelegationWriter, epochs = f.epochs) {
      const store = createLinkedPlatformAuthorizationStore(ownerPool, epochs);
      if (writer.name === "grant") {
        return store.grant(grant);
      }
      if (writer.name === "rotateRefreshToken")
        return store.rotateRefreshToken({
          refreshTokenHash: grant.refreshTokenHash,
          newAccessTokenHash: "synthetic-next-access",
          newRefreshTokenHash: "synthetic-next-refresh",
          accessTokenExpiresAt: grant.accessTokenExpiresAt,
          refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
          refreshedAt: "2026-11-14T00:00:00Z",
        });
      if (writer.name === "revokeToken") return store.revokeToken(grant.accessTokenHash, owner.revokedAt);
      if (writer.name === "revokeAuthorization")
        return store.revokeAuthorization({
          authorizationId: grant.authorizationId,
          accountId: grant.accountId,
          revokedAt: owner.revokedAt,
        });
      return createAgentGrantRevocations(ownerPool, f.raw, undefined, epochs).advance(state, context);
    }
    const row = async () =>
      (
        await ownerPool.query(
          "SELECT status, access_token_hash FROM identity_linked_platform_authorizations WHERE authorization_id = $1",
          [grant.authorizationId],
        )
      ).rows[0];
    async function complete(writer: DelegationWriter) {
      if (writer.name === "grant") await expect(write(writer)).rejects.toMatchObject({ code: "23505" });
      else await write(writer);
    }
    return { ...f, terminal, write, complete, row, delegatedInput };
  }

  it.each(delegationWriters)(
    "delegation $name: close-first invalidates the old grant before installation",
    async (writer) => {
      const f = await delegationFixture();
      await f.complete(writer);
      await expect(f.terminalStore.appendToStreams!([f.terminal])).rejects.toMatchObject({
        code: "concurrency_conflict",
      });
      expect(await f.terminalStore.readStream({ streamId: f.terminal.streamId })).toHaveLength(0);
      const source = await f.epochs.source();
      if (writer.name === "grant") {
        expect(await source.status(delegationKey)).toMatchObject({ status: "PENDING", epoch: 0, pendingConsumers: [] });
        return;
      }
      const next = await Promise.all(
        f.terminal.configurationGrants!.map((grant) => source.captureGrant(grant.key, consumer)),
      );
      expect(next.find((grant) => grant.key === delegationKey)?.epoch).toBe(1);
      await f.terminalStore.appendToStreams!([{ ...f.terminal, configurationGrants: next }]);
      expect((await f.authority.capture(f.delegatedInput)).kind).toBe(
        writer.name === "rotateRefreshToken" ? "granted" : "denied",
      );
    },
  );

  it.each(delegationWriters)("delegation $name: $mutant defeats the stale-terminal oracle", async (writer) => {
    const f = await delegationFixture();
    const omit = vi.spyOn(f.epochs, "enrollDelegation").mockResolvedValue();
    try {
      await f.complete(writer);
    } finally {
      omit.mockRestore();
    }
    await f.terminalStore.appendToStreams!([f.terminal]);
    expect(await f.terminalStore.readStream({ streamId: f.terminal.streamId }), writer.mutant).toHaveLength(1);
  });

  it.each([
    ["foreign User", "UPDATE identity_linked_platform_authorizations SET user_id = 'usr_foreign'"],
    ["foreign Account", "UPDATE identity_linked_platform_authorizations SET account_id = 'acc_foreign'"],
    ["missing write scope", "UPDATE identity_linked_platform_authorizations SET scopes = '[\"catalog:read\"]'::jsonb"],
    ["revoked", "UPDATE identity_linked_platform_authorizations SET status = 'revoked'"],
    [
      "expired access token",
      "UPDATE identity_linked_platform_authorizations SET access_token_expires_at = '2020-01-01'",
    ],
    [
      "expired absolute lifetime",
      "UPDATE identity_linked_platform_authorizations SET absolute_expires_at = '2020-01-01'",
    ],
    ["absent", "DELETE FROM identity_linked_platform_authorizations"],
  ])("canonical delegated capture refuses %s", async (_name, sql) => {
    const f = await delegationFixture();
    await ownerPool.query(sql);
    expect((await f.authority.capture(f.delegatedInput)).kind).toBe("denied");
  });

  it.each(delegationWriters)("delegation $name: terminal-first waits for consumer COMMIT", async (writer) => {
    const f = await delegationFixture();
    const client = await consumerPool.connect();
    let writing: Promise<unknown> | undefined;
    try {
      await client.query("BEGIN");
      await f.terminalStore.appendToStreamsInTransaction(client, [f.terminal]);
      writing = f.complete(writer);
      const source = await f.epochs.source();
      let status = await source.status(delegationKey);
      for (let attempt = 0; attempt < 100 && status.status === "OPEN"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = await source.status(delegationKey);
      }
      expect(status.status).toBe("PENDING");
      expect(await f.row()).toMatchObject({ status: "active", access_token_hash: "synthetic-access" });
      await client.query("COMMIT");
      await writing;
      expect((await source.status(delegationKey)).epoch).toBe(writer.name === "grant" ? 0 : 1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      if (writing) await writing;
    }
  });

  it.each(delegationWriters)(
    "delegation $name: blocked route retries without premature business effects",
    async (writer) => {
      const f = await delegationFixture();
      await expect(f.write(writer, createIdentityOwnerEpochs(ownerPool))).rejects.toMatchObject({
        code: "concurrency_conflict",
      });
      expect(await f.row()).toMatchObject({ status: "active", access_token_hash: "synthetic-access" });
      expect((await (await f.epochs.source()).status(delegationKey)).status).toBe("BLOCKED");
      await f.complete(writer);
      await expect(f.terminalStore.appendToStreams!([f.terminal])).rejects.toMatchObject({
        code: "concurrency_conflict",
      });
    },
  );

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

  it("reports a blocked writer with zero owner/audit events and resumes after route recovery", async () => {
    const f = await fixture();
    const unavailable = createIdentityOwnerEpochs(ownerPool);
    const persistence = createIdentityMutationPersistence(ownerPool, f.raw, () => [], unavailable);
    const write = () =>
      persistence.transaction([], (tx) =>
        tx.append!([
          {
            streamId: "identity.user-usr_synthetic",
            expectedVersion: 1,
            context,
            events: [{ eventType: "identity.user.suspended", payload: {} }],
          },
          {
            streamId: "synthetic.blocked-audit",
            expectedVersion: "no_stream",
            context,
            events: [{ eventType: "synthetic.audit", payload: {} }],
          },
        ]),
      );
    await expect(write()).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect((await (await unavailable.source()).status("user/usr_synthetic")).status).toBe("BLOCKED");
    expect(await f.raw.readStream({ streamId: "identity.user-usr_synthetic" })).toHaveLength(1);
    expect(await f.raw.readStream({ streamId: "synthetic.blocked-audit" })).toHaveLength(0);
    expect((await f.authority.capture(authorityInput)).kind).toBe("denied");
    await f.write(writers[1]);
    expect(await (await f.epochs.source()).status("user/usr_synthetic")).toMatchObject({ status: "OPEN", epoch: 1 });
  });

  it("rolls APPLIED back with a failed business append, preserving acknowledged CLOSING for retry", async () => {
    const f = await fixture();
    const fault = vi
      .spyOn(f.raw, "appendToStreamsInTransaction")
      .mockRejectedValueOnce(new Error("synthetic append failure"));
    await expect(f.write(writers[4])).rejects.toThrow("synthetic append failure");
    fault.mockRestore();
    expect(await f.raw.readStream({ streamId: "identity.account-acc_synthetic" })).toHaveLength(1);
    expect(await f.raw.readStream({ streamId: "synthetic.audit" })).toHaveLength(0);
    expect(await (await f.epochs.source()).status("account/acc_synthetic")).toMatchObject({
      status: "PENDING",
      epoch: 0,
      pendingConsumers: [],
    });
    await f.write(writers[4]);
    expect(await f.raw.readStream({ streamId: "synthetic.audit" })).toHaveLength(1);
    expect(await (await f.epochs.source()).status("account/acc_synthetic")).toMatchObject({ status: "OPEN", epoch: 1 });
  });
});
