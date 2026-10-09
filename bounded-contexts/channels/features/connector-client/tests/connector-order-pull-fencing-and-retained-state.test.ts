import { describe, expect, it } from "vitest";
import { pullFixture } from "./connector-order-pull-test-support";

describe("connector-order-pull-fencing-and-retained-state", () => {
  it("permits one two-store CAS winner and preserves the losing worker's snapshot", async () => {
    const f = await pullFixture();
    f.dispatch.mockImplementation(async (_u, _s, pull) => {
      await pull!.save(f.handoff);
      throw new Error("synthetic stop");
    });
    await f.coordinator().coordinate(f.input);
    const before = await f.journal.read(f.input.connectionId);
    const member = before.members[0];
    if (member.operationKind !== "tcgplayer-order-pull" || !member.handoff) throw new Error("missing handoff");
    const next = {
      members: [
        {
          ...member,
          revision: member.revision + 1,
          handoff: { ...member.handoff, usage: { ...member.handoff.usage, providerCalls: 1 } },
        },
      ],
      reservations: [{ ...before.reservations[0], revision: before.reservations[0].revision + 1 }],
    };
    const outcomes = await Promise.allSettled([
      f.journal.change(f.input.connectionId, before, next),
      f.journal.change(f.input.connectionId, before, next),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await f.journal.read(f.input.connectionId)).toEqual(next);
  });
  it("rehomes a single pull atomically, refuses orphan/split/merge and retains all progress", async () => {
    const f = await pullFixture();
    f.dispatch.mockImplementation(async (_u, _s, pull) => {
      await pull!.save(f.handoff);
      throw new Error("synthetic stop");
    });
    await f.coordinator().coordinate(f.input);
    const before = await f.journal.read(f.input.connectionId);
    await expect(f.journal.change(f.input.connectionId, before, { ...before, reservations: [] })).rejects.toThrow();
    await expect(f.journal.change(f.input.connectionId, before, { ...before, members: [] })).rejects.toThrow();
    const member = before.members[0];
    const reservation = before.reservations[0];
    await expect(
      f.journal.change(f.input.connectionId, before, {
        members: [member, { ...member, operationId: "synthetic-second" }],
        reservations: [
          {
            ...reservation,
            revision: reservation.revision + 1,
            memberOperationIds: [member.operationId, "synthetic-second"],
          },
        ],
      }),
    ).rejects.toThrow();
    const next = {
      members: [
        {
          ...member,
          revision: member.revision + 1,
          reservationId: "synthetic-rehome",
          attemptId: "synthetic-attempt-2",
          claimGeneration: 2,
        },
      ],
      reservations: [{ ...reservation, reservationId: "synthetic-rehome", revision: 0 }],
    };
    await f.journal.change(f.input.connectionId, before, next);
    expect(await f.journal.read(f.input.connectionId)).toEqual(next);
    await expect(f.journal.change(f.input.connectionId, before, before)).rejects.toThrow("stale-fence");
  });
  it.each(["pause", "revoke", "deadline", "lease", "providerNotBefore"])(
    "blocks %s before an effect",
    async (fence) => {
      const f = await pullFixture();
      f.dispatch.mockImplementation(async (_u, _s, pull) => {
        await pull!.save(f.handoff);
        if (fence === "pause") f.setAuthority("report-only");
        if (fence === "revoke") f.setAuthority("absent");
        if (fence === "deadline") f.setNow(f.now() + f.payload.bounds.budgetMs);
        if (fence === "lease") f.setNow(Date.parse(f.claim.leaseExpiresAt) - 30000);
        if (fence === "providerNotBefore") f.setNow(f.now() - 1);
        const effect =
          fence === "providerNotBefore"
            ? pull!.read(async () => {
                throw new Error("provider effect escaped fence");
              })
            : pull!.sale("SYNTHETIC-ORDER-1", 0, f.post);
        await expect(effect).rejects.toThrow("stale-fence");
        throw new Error("synthetic interruption");
      });
      await f.coordinator().coordinate(f.input);
      expect(f.posts).toEqual([]);
      expect(f.reports).toEqual([]);
    },
  );
  it.each(["boot", "update", "work", "unpair"] as const)(
    "retains incomplete independent membership at %s",
    async (reason) => {
      const f = await pullFixture();
      f.dispatch.mockImplementation(async (_u, _s, pull) => {
        await pull!.save(f.handoff);
        throw new Error("synthetic stop");
      });
      await f.coordinator().coordinate(f.input);
      const before = await f.journal.read(f.input.connectionId);
      f.setAuthority("report-only");
      await f.coordinator().coordinate({ ...f.input, reason });
      expect(await f.journal.read(f.input.connectionId)).toEqual(before);
      expect(f.posts).toEqual([]);
      expect(f.reports).toEqual([]);
    },
  );
  it("keeps acked rows inert on the day after and compacts both stores at 24 hours", async () => {
    const f = await pullFixture();
    await f.coordinator().coordinate(f.input);
    const snapshot = await f.journal.read(f.input.connectionId);
    f.setNow(f.now() + 86399999);
    await f.coordinator().coordinate(f.input);
    expect(await f.journal.read(f.input.connectionId)).toEqual(snapshot);
    f.setNow(f.now() + 1);
    await f.coordinator().coordinate(f.input);
    expect(await f.journal.read(f.input.connectionId)).toEqual({ members: [], reservations: [] });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.posts).toHaveLength(2);
    expect(f.reports).toHaveLength(1);
  });
});
