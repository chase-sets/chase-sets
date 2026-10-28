import { describe, expect, it } from "vitest";
import {
  createInMemoryOwnerStreamReservationStore,
  OWNER_STREAM_MAX_LIVE_GRANTS_PER_RESOURCE,
} from "./owner-stream-reservation";

const input = (reservationId: string, resourceKey = "resource-1") => ({
  reservationId,
  operationId: "operation-1",
  ownerStreamId: "owner-stream-1",
  purpose: "listing-activation",
  resourceKey,
  consumer: { storeId: "consumer-1", requestId: "request-1" },
  seal: { version: 7, storeIncarnation: "owner-incarnation-1" },
  target: { listingId: "listing-1" },
  commandFingerprint: "fingerprint-1",
});

describe("owner-stream reservations", () => {
  it("abort-first releases only after the original terminal abort and then applies invalidation", async () => {
    const store = createInMemoryOwnerStreamReservationStore();
    const reservation = await store.reserve(input("reservation-1"));
    const binding = {
      consumerStoreId: "consumer-1",
      requestId: "request-1",
      reservationIds: [reservation.reservationId],
    };

    expect((await store.beginInvalidation("owner-stream-1")).status).toBe("PENDING");
    expect((await store.driveInvalidation("owner-stream-1")).status).toBe("ABORT-REQUESTED");
    await store.openRequestTerminal(binding);
    expect((await store.abortRequestTerminal(binding)).status).toBe("ABORTED");
    expect((await store.driveInvalidation("owner-stream-1")).status).toBe("APPLIED");
    expect((await store.getReservation(reservation.reservationId))?.releaseStatus).toBe("ABORTED");
    await expect(store.commitRequestTerminal(binding)).rejects.toMatchObject({ code: "concurrency_conflict" });
  });

  it("keeps inbound evidence pending and refuses the 129th live grant without a write", async () => {
    const store = createInMemoryOwnerStreamReservationStore();
    for (let index = 0; index < OWNER_STREAM_MAX_LIVE_GRANTS_PER_RESOURCE; index += 1)
      await store.reserve(input(`reservation-${index}`));

    expect(
      (await store.recordInboundEvidence({ evidenceId: "evidence-1", resourceKey: "resource-1", payload: {} })).status,
    ).toBe("PENDING");
    await expect(store.reserve(input("reservation-over-bound"))).rejects.toMatchObject({
      code: "concurrency_conflict",
    });
    expect(store.reservations.size).toBe(OWNER_STREAM_MAX_LIVE_GRANTS_PER_RESOURCE);
  });

  it("does not release an unknown terminal by time or retry", async () => {
    const store = createInMemoryOwnerStreamReservationStore();
    const reservation = await store.reserve(input("reservation-1"));
    await store.beginInvalidation("owner-stream-1");
    expect((await store.driveInvalidation("owner-stream-1")).status).toBe("ABORT-REQUESTED");
    expect((await store.getReservation(reservation.reservationId))?.status).toBe("OPEN");
  });
});
