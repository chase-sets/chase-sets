import { describe, expect, it } from "vitest";
import { coordinatorFixture } from "./coordinator-test-support";

describe("connector-coordinator-crash-matrix", () => {
  it.each(["operation", "reservation"] as const)(
    "commits %s intent before its single executor call and captures before report",
    async (unit) => {
      const f = await coordinatorFixture(unit);
      f.dispatchOnce.mockImplementation(async (work) => {
        const retained = await f.journal.read(f.input.connectionId);
        expect(retained.members.every((member) => member.state === "dispatched")).toBe(true);
        expect(retained.reservations[0].phase).toBe("dispatched");
        return f.result(work);
      });
      expect(await f.coordinator().coordinate(f.input)).toMatchObject({ outcome: "ok" });
      const state = await f.journal.read(f.input.connectionId);
      expect(state.members[0].state).toBe("acked");
      expect(state.reservations[0].reportEnvelope?.runSettlement).toEqual(
        unit === "reservation" ? f.settlement : undefined,
      );
      expect(f.dispatchOnce).toHaveBeenCalledTimes(1);
      expect(await f.coordinator().coordinate(f.input)).toMatchObject({ outcome: "ok" });
      expect(f.dispatchOnce).toHaveBeenCalledTimes(1);
    },
  );
  it("does not replay a provider mutation whose receipt was lost", async () => {
    const f = await coordinatorFixture();
    let mutations = 0;
    f.dispatchOnce.mockImplementation(async () => {
      mutations++;
      throw new Error("synthetic-worker-death");
    });
    expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "unknown" });
    expect((await f.journal.read(f.input.connectionId)).members[0].state).toBe("outcome-unknown");
    await f.coordinator().coordinate(f.input);
    expect(mutations).toBe(1);
    expect(JSON.parse(f.reports[0]).outcomes[0].outcome).toEqual({ kind: "outcome-unknown" });
  });
  it("repeats a committed envelope byte-identically including settlement after acknowledgement loss", async () => {
    const f = await coordinatorFixture("reservation");
    const request = f.request.getMockImplementation()!;
    let reports = 0;
    f.request.mockImplementation(async (input) => {
      const response = await request(input);
      if (new URL(input.url).pathname.endsWith("/report") && reports++ === 0)
        throw new Error("synthetic-response-loss");
      return response;
    });
    expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "unknown" });
    expect((await f.journal.read(f.input.connectionId)).members[0].state).toBe("reported");
    await f.coordinator().coordinate(f.input);
    expect(f.reports).toHaveLength(2);
    expect(f.reports[1]).toBe(f.reports[0]);
    expect(f.dispatchOnce).toHaveBeenCalledTimes(1);
  });
  it("keeps bound ambiguity unknown without fabricating a settlement", async () => {
    const f = await coordinatorFixture("reservation");
    f.dispatchOnce.mockRejectedValue(new Error("synthetic-worker-death"));
    await f.coordinator().coordinate(f.input);
    await f.coordinator().coordinate(f.input);
    expect(f.dispatchOnce).toHaveBeenCalledTimes(1);
    expect(f.reports).toEqual([]);
    expect((await f.journal.read(f.input.connectionId)).members[0].state).toBe("outcome-unknown");
  });
  it("commits prepare refusal and never dispatches it", async () => {
    const f = await coordinatorFixture();
    f.prepare.mockImplementation(async (work) => ({
      ready: false,
      result: {
        outcomes: f
          .result(work)
          .outcomes.map((outcome) => ({ ...outcome, outcome: { kind: "rejected", code: "validation" } })),
      },
    }));
    await f.coordinator().coordinate(f.input);
    expect(f.dispatchOnce).not.toHaveBeenCalled();
    const retained = await f.journal.read(f.input.connectionId);
    expect(retained.reservations[0].reportEnvelope?.outcomes[0].outcome).toEqual({
      kind: "rejected",
      code: "validation",
    });
    expect(retained.members[0].state).toBe("acked");
  });
  it("a bound executor cannot omit its settlement or smuggle client authority", async () => {
    for (const kind of ["omitted", "forged-context"] as const) {
      const f = await coordinatorFixture("reservation");
      f.dispatchOnce.mockImplementation(async (work) => {
        const result = f.result(work);
        return kind === "omitted"
          ? { outcomes: result.outcomes }
          : { ...result, runSettlement: { ...f.settlement, context: null } };
      });
      expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "unknown" });
      expect(f.reports).toEqual([]);
      expect((await f.journal.read(f.input.connectionId)).members[0].state).toBe("outcome-unknown");
    }
  });
  it("a crash after dispatch intent but before the call cannot cause a later dispatch", async () => {
    const f = await coordinatorFixture();
    const input = {
      ...f.input,
      authority: async () => {
        const retained = await f.journal.read(f.input.connectionId);
        if (retained.members.some((member) => member.state === "dispatched"))
          throw new Error("synthetic-before-call-crash");
        return "paired-idle" as const;
      },
    };
    expect(await f.coordinator().coordinate(input)).toEqual({ outcome: "unknown" });
    await f.coordinator().coordinate(f.input);
    expect(f.dispatchOnce).not.toHaveBeenCalled();
    expect(JSON.parse(f.reports[0]).outcomes[0].outcome.kind).toBe("outcome-unknown");
  });
});
