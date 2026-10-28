import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "./test-support";
import type { AppendToStreamInput } from "./storage";
import {
  createInMemoryOwnerStreamReservationStore,
  type RequestTerminalBinding,
  type ReserveOwnerStreamInput,
} from "./owner-stream-reservation";

const reservation = (
  id = "reservation-1",
  overrides: Partial<ReserveOwnerStreamInput> = {},
): ReserveOwnerStreamInput => ({
  reservationId: id,
  operationId: "operation-1",
  ownerStreamId: "owner-1",
  purpose: "activation",
  resourceKey: "stock-1",
  consumer: { storeId: "consumer", incarnation: "consumer-incarnation", requestId: "request-1" },
  seal: { version: 7, storeIncarnation: "owner-incarnation" },
  target: { listingId: "listing-1" },
  commandFingerprint: "full-command",
  ...overrides,
});
function binding(r = reservation()): RequestTerminalBinding {
  return {
    consumerStoreId: r.consumer.storeId,
    consumerIncarnation: r.consumer.incarnation,
    requestId: r.consumer.requestId,
    target: r.target,
    commandFingerprint: r.commandFingerprint,
    reservations: [r],
    preparationDeadline: "2026-10-28T00:00:00.000Z",
  };
}
function append(requestTerminal?: RequestTerminalBinding, streamId = "test.consumer-1"): AppendToStreamInput {
  return {
    streamId,
    expectedVersion: "no_stream",
    events: [{ eventId: "event-1" as never, eventType: "test.committed", payload: {} }],
    context: {
      tenantId: "tenant" as never,
      audit: { performedByUserId: "user" as never, forAccountId: "account" as never },
    },
    ...(requestTerminal ? { requestTerminal } : {}),
  };
}
function fixture() {
  let version = 7;
  let applied = 0;
  let clock = Date.parse("2026-10-27T00:00:00Z");
  const store = createInMemoryOwnerStreamReservationStore({
    consumer: { storeId: "consumer", incarnation: "consumer-incarnation" },
    readOwnerSeal: () => ({ version, storeIncarnation: "owner-incarnation" }),
    applyInvalidation: () => {
      version += 1;
    },
    applyInboundEvidence: (e) => {
      applied += Number(e.payload.quantity);
    },
    now: () => clock,
  });
  const memory = createInMemoryEventStore({ ownerStreamReservations: store });
  return {
    store,
    memory,
    version: () => version,
    applied: () => applied,
    expire: () => {
      clock = Date.parse("2026-10-29T00:00:00Z");
    },
  };
}

describe("owner-stream reservations", () => {
  it("abort-first sends the original abort CAS, refuses every event and opens the next revision", async () => {
    const f = fixture();
    const r = reservation();
    const b = binding(r);
    await f.store.reserve(r);
    await f.store.openRequestTerminal(b);
    await f.store.beginInvalidation(r.ownerStreamId);
    await expect(f.store.reserve(reservation("late"))).rejects.toThrow("pending");
    expect((await f.store.driveInvalidation(r.ownerStreamId)).status).toBe("APPLIED");
    await expect(f.memory.eventStore.appendToStreams!([append(b)])).rejects.toThrow("final");
    expect(f.memory.allEvents).toHaveLength(0);
    expect((await f.store.getReservation(r.reservationId))?.releaseStatus).toBe("ABORTED");
    expect(f.version()).toBe(8);
    await expect(f.store.reserve(reservation("next", { seal: { ...r.seal, version: 8 } }))).resolves.toMatchObject({
      status: "OPEN",
    });
  });
  it("terminal-first commits atomically, then the owner applies without an abort override", async () => {
    const f = fixture();
    const r = reservation();
    const b = binding(r);
    await f.store.reserve(r);
    await f.store.openRequestTerminal(b);
    await f.memory.eventStore.appendToStreams!([append(b)]);
    expect(f.memory.allEvents).toHaveLength(1);
    expect(f.version()).toBe(7);
    await f.store.beginInvalidation(r.ownerStreamId);
    await f.store.driveInvalidation(r.ownerStreamId);
    expect((await f.store.getReservation(r.reservationId))?.releaseStatus).toBe("COMMITTED");
    expect(f.version()).toBe(8);
    await expect(f.memory.eventStore.appendToStreams!([append(b, "test.replay")])).rejects.toThrow("final");
  });
  it("rolls back terminal, events, event ids and positions on a late append failure", async () => {
    const f = fixture();
    const r = reservation();
    const b = binding(r);
    await f.store.reserve(r);
    await f.store.openRequestTerminal(b);
    await f.memory.eventStore.appendToStream(append(undefined, "test.existing"));
    await expect(f.memory.eventStore.appendToStreams!([append(b, "test.new")])).rejects.toThrow();
    expect(f.memory.allEvents).toHaveLength(1);
    expect((await f.store.openRequestTerminal(b)).status).toBe("OPEN");
    await f.memory.eventStore.appendToStreams!([
      { ...append(b, "test.new"), events: [{ eventId: "event-2" as never, eventType: "test.committed", payload: {} }] },
    ]);
    expect(f.memory.allEvents.map((e) => e.globalPosition)).toEqual(["1", "2"]);
  });
  it.each(["appendToStream", "appendToStreamsIndependently"] as const)(
    "rejects terminal bypass through %s including empty appends",
    async (method) => {
      const f = fixture();
      const value = { ...append(binding()), events: [] };
      const call =
        method === "appendToStream"
          ? f.memory.eventStore.appendToStream(value)
          : f.memory.eventStore.appendToStreamsIndependently!([value]);
      await expect(call).rejects.toThrow("require appendToStreams");
      expect(f.memory.allEvents).toHaveLength(0);
    },
  );
  it.each(["consumer", "command", "target", "owner", "manifest", "deadline"])(
    "refuses immutable terminal %s drift with zero events",
    async (field) => {
      const f = fixture();
      const r = reservation();
      const b = binding(r);
      await f.store.reserve(r);
      await f.store.openRequestTerminal(b);
      const changed = structuredClone(b) as {
        -readonly [K in keyof RequestTerminalBinding]: RequestTerminalBinding[K];
      };
      if (field === "consumer") changed.consumerIncarnation = "other";
      if (field === "command") {
        changed.commandFingerprint = "other";
        changed.reservations = [{ ...r, commandFingerprint: "other" }];
      }
      if (field === "target") {
        changed.target = { listingId: "other" };
        changed.reservations = [{ ...r, target: changed.target }];
      }
      if (field === "owner") changed.reservations = [{ ...r, seal: { ...r.seal, storeIncarnation: "other" } }];
      if (field === "manifest") changed.reservations = [{ ...r, reservationId: "other" }];
      if (field === "deadline") changed.preparationDeadline = "2030-01-01T00:00:00Z";
      await expect(f.memory.eventStore.appendToStreams!([append(changed)])).rejects.toThrow();
      await expect(f.store.openRequestTerminal(changed)).rejects.toThrow();
      expect(f.memory.allEvents).toHaveLength(0);
    },
  );
  it("requires complete preparation and binds every reservation retry field", async () => {
    const f = fixture();
    const r = reservation();
    await expect(f.store.openRequestTerminal(binding(r))).rejects.toThrow("incomplete");
    await f.store.reserve(r);
    for (const altered of [
      { ...r, operationId: "other" },
      { ...r, purpose: "other" },
      { ...r, commandFingerprint: "other" },
      { ...r, target: { other: true } },
    ])
      await expect(f.store.reserve(altered)).rejects.toThrow("reused");
    await expect(f.store.reserve(reservation("stale", { seal: { ...r.seal, version: 6 } }))).rejects.toThrow(
      "not current",
    );
    expect(f.store.snapshot().reservations.size).toBe(1);
  });
  it("keeps unknown outcomes blocking until an original terminal CAS, never elapsed time", async () => {
    const f = fixture();
    const r = reservation();
    const b = binding(r);
    await f.store.reserve(r);
    await f.store.beginInvalidation(r.ownerStreamId);
    f.expire();
    expect((await f.store.driveInvalidation(r.ownerStreamId)).status).toBe("ABORT-REQUESTED");
    expect((await f.store.getReservation(r.reservationId))?.status).toBe("OPEN");
    expect(f.version()).toBe(7);
    expect((await f.store.abortPreparationDeadline(b)).status).toBe("ABORTED");
    expect((await f.store.getReservation(r.reservationId))?.status).toBe("OPEN");
    await f.store.driveInvalidation(r.ownerStreamId);
    expect(f.version()).toBe(8);
    await expect(f.memory.eventStore.appendToStreams!([append(b)])).rejects.toThrow("final");
  });
  it("public abort CAS remains final and cannot be undone by an atomic append", async () => {
    const f = fixture();
    const r = reservation();
    const b = binding(r);
    await f.store.reserve(r);
    await f.store.openRequestTerminal(b);
    expect((await f.store.abortRequestTerminal(b)).status).toBe("ABORTED");
    await expect(f.memory.eventStore.appendToStreams!([append(b)])).rejects.toThrow("final");
    expect((await f.store.openRequestTerminal(b)).status).toBe("ABORTED");
    expect(f.memory.allEvents).toHaveLength(0);
  });
  it("refuses the local consumer incarnation even for an internally consistent foreign binding", async () => {
    const f = fixture();
    const r = reservation("foreign", {
      consumer: { storeId: "consumer", incarnation: "foreign", requestId: "request-1" },
    });
    await f.store.reserve(r);
    await expect(f.store.openRequestTerminal(binding(r))).rejects.toThrow("incarnation");
    await expect(f.store.abortRequestTerminal(binding(r))).rejects.toThrow("incarnation");
    expect(f.store.snapshot().terminals.size).toBe(0);
  });
  it("does not abort before the preparation deadline", async () => {
    const f = fixture();
    const r = reservation();
    const b = binding(r);
    await f.store.reserve(r);
    await f.store.openRequestTerminal(b);
    expect((await f.store.abortPreparationDeadline(b)).status).toBe("OPEN");
  });
  it.each(["resource", "purpose", "live"])(
    "refuses the first excess %s without writes across streams and operations",
    async (kind) => {
      const f = fixture();
      const count = kind === "resource" ? 32 : kind === "purpose" ? 8 : 128;
      const row = (i: number) =>
        reservation(`r-${i}`, {
          ownerStreamId: `owner-${i}`,
          resourceKey: kind === "resource" ? `stock-${i}` : "stock-1",
          purpose: kind === "purpose" ? `purpose-${i}` : "activation",
          operationId: kind === "live" ? `operation-${i}` : "operation-1",
        });
      for (let i = 0; i < count; i += 1) await f.store.reserve(row(i));
      const before = f.store.snapshot();
      await expect(f.store.reserve(row(count))).rejects.toThrow("bound exceeded");
      expect(f.store.snapshot()).toEqual(before);
    },
  );
  it("records payload first, reports blocked until settlement, applies exactly once and never early", async () => {
    const f = fixture();
    const r = reservation();
    const b = binding(r);
    await f.store.reserve(r);
    const e = { evidenceId: "sale", resourceKey: r.resourceKey, payload: { quantity: 2 } };
    expect(await f.store.recordInboundEvidence(e)).toEqual({ ...e, status: "PENDING" });
    expect(f.applied()).toBe(0);
    expect((await f.store.settleInboundEvidence(e.evidenceId)).status).toBe("BLOCKED");
    expect(f.applied()).toBe(0);
    await expect(f.store.reserve(reservation("late"))).rejects.toThrow("pending");
    await f.store.openRequestTerminal(b);
    expect((await f.store.settleInboundEvidence(e.evidenceId)).status).toBe("APPLIED");
    expect(f.applied()).toBe(2);
    await f.store.settleInboundEvidence(e.evidenceId);
    expect(f.applied()).toBe(2);
    await expect(f.store.recordInboundEvidence({ ...e, payload: { quantity: 3 } })).rejects.toThrow("reused");
  });
});
