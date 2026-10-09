import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coordinatorFixture } from "./coordinator-test-support";
import { mutatedCoordinator } from "./coordinator-mutation-support";

afterEach(() => vi.restoreAllMocks());
describe("connector-coordinator discriminating controls", () => {
  it.each([false, true])("captured-cancellation bypass=%s changes the retained-success witness", async (bypass) => {
    const f = await coordinatorFixture();
    f.claims[0] = {
      ...f.claim,
      operations: [f.claim.operations[0], { ...f.claim.operations[0], operationId: "operation-2" }],
    };
    f.dispatchOnce.mockImplementation(async (work) => {
      f.setAuthority("report-only");
      return f.result(work);
    });
    await f.coordinator().coordinate(f.input);
    expect((await f.journal.read(f.input.connectionId)).members.map((member) => member.state)).toEqual([
      "receipt-captured",
      "prepared",
    ]);
    await (bypass ? mutatedCoordinator("captured-cancellation-bypass")(f.ports) : f.coordinator()).coordinate(f.input);
    expect(JSON.parse(f.reports[0]).outcomes.map((item: { outcome: { kind: string } }) => item.outcome.kind)).toEqual(
      bypass ? ["abandoned", "abandoned"] : ["applied", "abandoned"],
    );
    expect(f.dispatchOnce).toHaveBeenCalledTimes(1);
    expect((await f.journal.read(f.input.connectionId)).reservations[0].phase).toBe("acked");
  });
  it.each([false, true])("prepare-dispatch bypass=%s changes the zero-dispatch witness", async (bypass) => {
    const f = await coordinatorFixture();
    f.prepare.mockImplementation(async (work) => ({
      ready: false,
      result: {
        outcomes: f
          .result(work)
          .outcomes.map((item) => ({ ...item, outcome: { kind: "rejected", code: "validation" } })),
      },
    }));
    await (bypass ? mutatedCoordinator("prepare-dispatch")(f.ports) : f.coordinator()).coordinate(f.input);
    expect(f.dispatchOnce.mock.calls.length === 0).toBe(!bypass);
  });
  it.each([false, true])("report-invalid bypass=%s changes the zero-report witness", async (bypass) => {
    const f = await coordinatorFixture();
    f.claims[0] = { ...f.claim, operations: [{ ...f.claim.operations[0], payloadDigest: "0".repeat(64) }] };
    await (bypass ? mutatedCoordinator("report-invalid")(f.ports) : f.coordinator()).coordinate(f.input);
    expect(f.reports.length === 0).toBe(!bypass);
  });
  it.each([false, true])("replay-guard bypass=%s changes the one-mutation witness", async (bypass) => {
    const f = await coordinatorFixture();
    f.dispatchOnce.mockRejectedValueOnce(new Error("synthetic-after-provider-commit"));
    await f.coordinator().coordinate(f.input);
    await (bypass ? mutatedCoordinator("replay-guard")(f.ports) : f.coordinator()).coordinate(f.input);
    expect(f.dispatchOnce.mock.calls.length === 1).toBe(!bypass);
  });
  it.each([false, true])("completeness-bypass=%s changes the zero-claim witness", async (bypass) => {
    const f = await coordinatorFixture();
    const original = IDBObjectStore.prototype.count;
    vi.spyOn(IDBObjectStore.prototype, "count").mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = original.apply(this, args);
      request.addEventListener("success", () => Object.defineProperty(request, "result", { value: 1 }));
      return request;
    });
    await (bypass ? mutatedCoordinator("completeness-bypass")(f.ports) : f.coordinator()).coordinate(f.input);
    expect(f.request.mock.calls.length === 0).toBe(!bypass);
  });
  it.each([false, true])("fence-removed bypass=%s changes stale-capture refusal", async (bypass) => {
    const f = await coordinatorFixture();
    f.dispatchOnce.mockImplementation(async (work) => {
      const retained = await f.journal.read(f.input.connectionId);
      await f.journal.change(f.input.connectionId, retained, {
        ...retained,
        reservations: retained.reservations.map((row) => ({
          ...row,
          revision: row.revision + 1,
          lastRefusal: "transport",
        })),
      });
      return f.result(work);
    });
    await (bypass ? mutatedCoordinator("fence-removed")(f.ports) : f.coordinator()).coordinate(f.input);
    expect(f.reports.length === 0).toBe(!bypass);
  });
  it.each([false, true])(
    "per-member-batch-transaction bypass=%s changes the whole-unit dispatch witness",
    async (bypass) => {
      const f = await coordinatorFixture("reservation");
      f.claims[0] = {
        ...f.claim,
        operations: [f.claim.operations[0], { ...f.claim.operations[0], operationId: "operation-2" }],
      };
      await (bypass ? mutatedCoordinator("per-member-batch-transaction")(f.ports) : f.coordinator()).coordinate(
        f.input,
      );
      expect(f.dispatchOnce.mock.calls.length === 1 && f.dispatchOnce.mock.calls[0][0].members.length === 2).toBe(
        !bypass,
      );
    },
  );
});
