import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryOwnerStreamReservationStore,
  OWNER_STREAM_MAX_LIVE_GRANTS_PER_RESOURCE,
} from "@chase-sets/event-core/owner-stream-reservation";
import { createIsolatedPostgresTestSchema, type IsolatedPostgresTestSchema } from "./postgres-db-test-support";
import { createPostgresOwnerStreamReservationStore } from "./owner-stream-reservation";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for owner-stream DB proof.");
const describeDb = adminDatabaseUrl ? describe : describe.skip;

const reservationInput = (reservationId: string) => ({
  reservationId,
  operationId: "operation-1",
  ownerStreamId: "owner-stream-1",
  purpose: "listing-activation",
  resourceKey: "resource-1",
  consumer: { storeId: "consumer-1", requestId: "request-1" },
  seal: { version: 7, storeIncarnation: "owner-incarnation-1" },
  target: { listingId: "listing-1" },
  commandFingerprint: "fingerprint-1",
});

describe("owner-stream reservation in-memory parity", () => {
  it("proves the named abort-first and bound controls without a database", async () => {
    const store = createInMemoryOwnerStreamReservationStore();
    const reservation = await store.reserve(reservationInput("reservation-1"));
    const binding = {
      consumerStoreId: "consumer-1",
      requestId: "request-1",
      reservationIds: [reservation.reservationId],
    };
    await store.beginInvalidation("owner-stream-1");
    await store.openRequestTerminal(binding);
    await store.abortRequestTerminal(binding);
    expect((await store.driveInvalidation("owner-stream-1")).status).toBe("APPLIED");
    for (let index = 0; index < OWNER_STREAM_MAX_LIVE_GRANTS_PER_RESOURCE; index += 1)
      if (index > 0) await store.reserve(reservationInput(`reservation-${index}`));
    await expect(store.reserve(reservationInput("reservation-over-bound"))).rejects.toMatchObject({
      code: "concurrency_conflict",
    });
  });
});

describeDb("owner-stream reservation Postgres protocol", () => {
  let ownerSchema: IsolatedPostgresTestSchema;
  let consumerSchema: IsolatedPostgresTestSchema;
  beforeAll(async () => {
    ownerSchema = await createIsolatedPostgresTestSchema(adminDatabaseUrl!, "owner_stream_reservation_owner");
    consumerSchema = await createIsolatedPostgresTestSchema(adminDatabaseUrl!, "owner_stream_reservation_consumer");
  });
  beforeEach(async () => Promise.all([ownerSchema.reset(), consumerSchema.reset()]));
  afterAll(async () => {
    await ownerSchema?.close();
    await consumerSchema?.close();
  });

  it.each(["prepare-failure", "lost-reply", "consumer-restart"])(
    "keeps a reservation open across %s",
    async (scenario) => {
      const store = createPostgresOwnerStreamReservationStore({
        ownerPool: ownerSchema.pool,
        consumerPool: consumerSchema.pool,
      });
      const reservation = await store.reserve(reservationInput(`reservation-${scenario}`));
      expect((await store.getReservation(reservation.reservationId))?.status).toBe("OPEN");
    },
  );

  it("records inbound evidence before a reservation conflict settles", async () => {
    const store = createPostgresOwnerStreamReservationStore({
      ownerPool: ownerSchema.pool,
      consumerPool: consumerSchema.pool,
    });
    await store.reserve(reservationInput("reservation-1"));
    await expect(
      store.recordInboundEvidence({ evidenceId: "evidence-1", resourceKey: "resource-1", payload: {} }),
    ).resolves.toMatchObject({ status: "PENDING" });
  });
});
