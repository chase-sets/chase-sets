import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresConfigurationEpochStore } from "./configuration-epoch";
import { createIsolatedPostgresTestSchema, type IsolatedPostgresTestSchema } from "./postgres-db-test-support";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("postgres acknowledged configuration epoch closure", () => {
  let schema: IsolatedPostgresTestSchema;

  beforeAll(async () => {
    schema = await createIsolatedPostgresTestSchema(databaseUrl!, "configuration_epoch");
  });
  beforeEach(async () => schema.reset());
  afterAll(async () => schema?.close());

  it("holds the shared owner lock through grant capture and installs only after every receipt", async () => {
    const store = createPostgresConfigurationEpochStore({ pool: schema.pool });
    await store.open({ key: "channels.connection:acct_db", storeIncarnation: "owner-1", keyCreationEpoch: 0 });
    await store.registerConsumer("channels.connection:acct_db", {
      consumerStoreId: "consumer-a",
      storeIncarnation: "consumer-1",
    });
    await store.registerConsumer("channels.connection:acct_db", {
      consumerStoreId: "consumer-b",
      storeIncarnation: "consumer-1",
    });
    const grant = await store.captureGrant({
      key: "channels.connection:acct_db",
      consumerStoreId: "consumer-a",
      storeIncarnation: "consumer-1",
    });
    const closure = await store.beginClosure(grant.key, 0);
    await expect(store.installClosure(grant.key, 0, closure.topologyRevision)).rejects.toThrow("pending");
    await expect(
      store.captureGrant({ key: grant.key, consumerStoreId: "consumer-a", storeIncarnation: "consumer-1" }),
    ).rejects.toThrow("not OPEN");
    await store.acknowledgeClosedThrough({
      key: grant.key,
      epoch: 0,
      topologyRevision: closure.topologyRevision,
      consumerStoreId: "consumer-a",
      storeIncarnation: "consumer-1",
    });
    await store.acknowledgeClosedThrough({
      key: grant.key,
      epoch: 0,
      topologyRevision: closure.topologyRevision,
      consumerStoreId: "consumer-b",
      storeIncarnation: "consumer-1",
    });
    await store.installClosure(grant.key, 0, closure.topologyRevision);
    await expect(
      store.captureGrant({ key: grant.key, consumerStoreId: "consumer-a", storeIncarnation: "consumer-1" }),
    ).resolves.toMatchObject({ epoch: 1 });
  });
});
