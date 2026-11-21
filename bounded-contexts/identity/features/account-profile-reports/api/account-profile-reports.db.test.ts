import { randomUUID } from "node:crypto";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createPostgresEventStore,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createId, type AccountId } from "@chase-sets/primitives/typed-ids";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIdentityMutationPersistence } from "../../account-management/api/fences";
import { identitySchemaSql } from "../../../support/runtime-support/schema";
import { buildProfileRedactionReactionHandlers } from "../integrations/moderation/profile-redaction-reaction";
import { createAccountProfileReportRuntime } from "./runtime";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("Account Profile Report DB tests require TEST_DATABASE_URL.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const context: EventStoreContext = {
  tenantId: createId("tnt"),
  audit: { performedByUserId: createId("usr"), forAccountId: createId("acc") },
};
const older = "2026-11-20T01:00:00.000Z";
const actionAt = "2026-11-20T02:00:00.000Z";
const newer = "2026-11-20T03:00:00.000Z";
const actionType = "platform-operations.reported-content.action-recorded";

describeDb("Account Profile Report and redaction transactions", () => {
  let pools: { identity: PgTransactionalPool };
  let store: PostgresEventStore;
  let persistence: ReturnType<typeof createIdentityMutationPersistence>;
  let clock: string;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["identity"], "identity_profile_reports");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.identity.query(identitySchemaSql);
    clock = older;
    store = createPostgresEventStore({ pool: pools.identity, now: () => parseIsoUtcTimestamp(clock) });
    persistence = createIdentityMutationPersistence(pools.identity, store, () => []);
  });

  afterAll(async () => closeMultiContextTestPools(pools));

  async function createAccount(accountId: AccountId = createId("acc"), owner: EventStoreContext = context) {
    await store.appendToStream({
      streamId: `identity.account-${accountId}`,
      expectedVersion: "no_stream",
      context: owner,
      events: [
        {
          eventType: "identity.account.created",
          payload: { accountId, name: "Store LLC", displayName: "Store", accountType: "business" },
        },
      ],
    });
    return accountId;
  }

  it("serializes by attempt and reporter-target pair and never stores another public report on replay", async () => {
    const target = await createAccount();
    const submit = createAccountProfileReportRuntime(persistence);
    const input = {
      target,
      reporterAccountId: context.audit.forAccountId,
      reason: "other",
      details: "private report",
    } as const;
    const attemptId = randomUUID();
    const [first, second, duplicate] = await Promise.all([
      submit({ ...input, attemptId }, context),
      submit({ ...input, attemptId }, context),
      submit({ ...input, attemptId: randomUUID() }, context),
    ]);
    expect([first, second, duplicate]).toEqual(Array(3).fill({ status: "received" }));
    await expect(submit({ ...input, attemptId, reason: "personal-information" }, context)).rejects.toThrow(
      "attempt_conflict",
    );
    expect(await store.readAll({ eventTypes: ["identity.account-profile.report-submitted"] })).toHaveLength(1);
  });

  it("receives self, missing, cross-tenant, suspended and closed reports without appending", async () => {
    const self = await createAccount(context.audit.forAccountId);
    const suspended = await createAccount();
    const closed = await createAccount();
    const outside = await createAccount(createId("acc"), { ...context, tenantId: createId("tnt") });
    for (const [id, eventType] of [
      [suspended, "identity.account.suspended"],
      [closed, "identity.account.closed"],
    ]) {
      await store.appendToStream({
        streamId: `identity.account-${id}`,
        expectedVersion: 1,
        context,
        events: [{ eventType, payload: {} }],
      });
    }
    const submit = createAccountProfileReportRuntime(persistence);
    for (const target of [self, createId("acc"), outside, suspended, closed]) {
      await expect(
        submit(
          {
            target,
            attemptId: randomUUID(),
            reporterAccountId: self,
            reason: "other",
            details: null,
          },
          context,
        ),
      ).resolves.toEqual({ status: "received" });
    }
    expect(await store.readAll({ eventTypes: ["identity.account-profile.report-submitted"] })).toEqual([]);
  });

  it("commits one atomic redaction on concurrent redelivery and refuses a stale action on an edited stream", async () => {
    const handler = buildProfileRedactionReactionHandlers(persistence)[actionType]!;
    const accountId = await createAccount();
    const edited = await createAccount();
    const event = (targetId: AccountId) =>
      buildTransportEvent(
        actionType,
        {
          targetId,
          targetType: "account-profile",
          action: "redact-profile-display-name",
          actionId: createId("rca"),
          operatorUserId: context.audit.performedByUserId,
          recordedAt: actionAt,
          note: "Operator reviewed the name.",
        },
        { tenantId: context.tenantId, audit: context.audit },
      );
    clock = newer;
    await store.appendToStream({
      streamId: `identity.account-${edited}`,
      expectedVersion: 1,
      context,
      events: [
        { eventType: "identity.account.profile-updated", payload: { name: "Store LLC", displayName: "Newer name" } },
      ],
    });
    const action = event(accountId);
    await Promise.all([handler(action), handler(action), handler(event(edited))]);
    const history = await store.readStream({ streamId: `identity.account-${accountId}`, limit: 4 });
    expect(history.map(({ eventType }) => eventType)).toEqual([
      "identity.account.created",
      "identity.account.display-name-redacted",
      "identity.account.profile-updated",
    ]);
    expect(history.at(-1)?.payload).toEqual({ name: "Store LLC", displayName: "Name removed" });
    const other = await store.readStream({ streamId: `identity.account-${edited}`, limit: 4 });
    expect(other).toHaveLength(2);
    expect(other.at(-1)?.payload.displayName).toBe("Newer name");
  });
});
