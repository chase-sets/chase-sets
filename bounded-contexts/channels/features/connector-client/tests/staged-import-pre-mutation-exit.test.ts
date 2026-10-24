import { describe, expect, it } from "vitest";
import { createConnectorOperationCoordinator } from "../domain/operation-coordinator";
import {
  assertStagedImportTimingTransition,
  prepareStagedImportDispatch,
  type StagedImportTiming,
} from "../domain/staged-import-dispatch";
import { mutatedStagedImport } from "./coordinator-mutation-support";
import { floorFixture, validationRejectedResult } from "./staged-import-floor-test-support";

type Kind = "read" | "mutation";
type Edit = readonly [string, string];
const releaseAfterMutation: Edit = ['plan.requests.slice(0, sent).every((hop) => hop.kind === "read")', "true"];
const busyBypass: Edit = ["!busy &&", ""];
const stoppedBypass: Edit = ["!stopped &&", ""];
const intentBypass: Edit = ['timing.state !== "intent" &&', ""];
const fenceBypass: Edit = ["!readsOnly || !(await ports.fence())", "!readsOnly"];

/** The real handle over a prepared journal unit; every save is checked against the existing transition law. */
async function handle(kinds: readonly Kind[], edits: readonly Edit[] = []) {
  const f = await floorFixture(
    kinds.map(() => 1000),
    kinds,
  );
  f.ports.executors = [{ ...f.executor, prepare: async () => ({ ready: true }) }];
  await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
  let current = await f.journal.read(f.input.connectionId);
  const unit = { reservation: current.reservations[0]!, members: current.members };
  const prepared = await f.executor.prepare(unit);
  if (!prepared.ready) throw new Error("synthetic-prepare-refused");
  const saves: StagedImportTiming[] = [];
  const hooks: { wait?(): void; provider?(): void; failPolicy?: boolean } = {};
  let fence = true;
  const factory = edits.length
    ? mutatedStagedImport({ dispatch: edits }).prepareStagedImportDispatch
    : prepareStagedImportDispatch;
  const guard = await factory({
    unit,
    preparation: prepared.stagedImport,
    dispatchDeadlineMs: 600000,
    epoch: "synthetic-epoch",
    platformOrigin: f.ports.platformOrigin,
    accessToken: "SYNTHETIC",
    monotonic: f.ports.clock.monotonic,
    wait: async (ms) => {
      hooks.wait?.();
      await f.ports.wait(ms);
    },
    current: () => current,
    fence: async () => fence,
    save: async (timing) => {
      const before = saves.at(-1);
      saves.push(timing);
      if (before) assertStagedImportTimingTransition(before, timing);
      current = { ...current, reservations: [{ ...unit.reservation, stagedImport: timing }] };
    },
    request: async (request) => {
      if (request.url.includes("dispatch-policy") && hooks.failPolicy) return new Response(null, { status: 500 });
      if (new URL(request.url).origin === "https://synthetic-provider.invalid") hooks.provider?.();
      return f.request(request);
    },
  });
  const send = (index: number, signal = new AbortController().signal) =>
    guard.send(
      `synthetic-hop-${index}`,
      new Request("https://synthetic-provider.invalid/hop", { redirect: "error" }),
      signal,
    );
  const released = () => saves.filter((timing) => timing.state === "released");
  return {
    f,
    guard,
    send,
    saves,
    hooks,
    released,
    setFence: (value: boolean) => {
      fence = value;
    },
  };
}

describe("staged-import-pre-mutation-exit (synthetic, no provider authority)", () => {
  it.each([
    [["read", "mutation", "mutation"], 1],
    [["read", "read", "mutation"], 2],
    [["mutation"], 0],
  ] as const)("after %j with %i read(s) it saves released, then refuses every later send", async (kinds, reads) => {
    const h = await handle(kinds);
    for (let index = 0; index < reads; index++) await h.send(index);
    await h.guard.refuseBeforeMutation();
    expect(h.released()).toEqual([
      expect.objectContaining({
        state: "released",
        requestIndex: reads,
        lastStart: reads ? 60000 * reads : null,
        lastCompletion: reads ? 60000 * reads + 1000 : null,
      }),
    ]);
    await expect(h.send(reads)).rejects.toThrow("staged-import-authority-refused");
    await expect(h.guard.finish()).rejects.toThrow("staged-import-outcome-unknown");
    await expect(h.guard.refuseBeforeMutation()).rejects.toThrow("staged-import-outcome-unknown");
    expect(h.f.starts).toHaveLength(reads);
    expect(h.released()).toHaveLength(1);
  });
  it("the released reads keep their floor credit for the next same-epoch dispatch only", async () => {
    for (const sameEpoch of [true, false]) {
      const f = await floorFixture([1000, 1000], ["read", "mutation"]);
      const dispatchAll = f.executor.dispatchOnce;
      f.ports.executors = [
        {
          ...f.executor,
          dispatchOnce: async (unit, signal, pull, stagedImport, live) => {
            if (unit.reservation.reservationId !== "reservation-1")
              return dispatchAll(unit, signal, pull, stagedImport, live);
            await stagedImport!.send(
              "synthetic-hop-0",
              new Request("https://synthetic-provider.invalid/hop", { redirect: "error" }),
            );
            return validationRejectedResult(unit, f.settlement);
          },
        },
      ];
      const first = createConnectorOperationCoordinator(f.ports);
      await first.coordinate(f.input);
      f.claims.push({
        ...f.claim,
        reservationId: "reservation-2",
        operations: f.claim.operations.map((row) => ({ ...row, operationId: "operation-2", attemptId: "attempt-2" })),
      });
      await (sameEpoch ? first : createConnectorOperationCoordinator(f.ports)).coordinate(f.input);
      expect(f.starts).toEqual(sameEpoch ? [60000, 120000, 180000] : [60000, 121000, 181000]);
    }
  });
  it.each([false, true])(
    "after a started mutation it throws and latches; release-after-mutation=%s",
    async (bypass) => {
      const h = await handle(["read", "mutation", "mutation"], bypass ? [releaseAfterMutation] : []);
      await h.send(0);
      await h.send(1);
      const refusal = h.guard.refuseBeforeMutation();
      if (bypass) await refusal;
      else await expect(refusal).rejects.toThrow("staged-import-outcome-unknown");
      expect(h.released()).toHaveLength(bypass ? 1 : 0);
      await expect(h.send(2)).rejects.toThrow("staged-import-authority-refused");
      expect(h.f.starts).toEqual([60000, 120000]);
    },
  );
  it.each([
    ["none", []],
    ["stopped", [stoppedBypass]],
    ["stopped+intent", [stoppedBypass, intentBypass]],
  ] as const)("in intent after an aborted read it throws; bypass=%s", async (name, edits) => {
    const h = await handle(["read", "mutation"], edits);
    const abort = new AbortController();
    h.hooks.provider = () => abort.abort();
    await expect(h.send(0, abort.signal)).rejects.toThrow("staged-import-outcome-unknown");
    expect(h.saves.at(-1)?.state).toBe("intent");
    const refusal = h.guard.refuseBeforeMutation();
    // Only removing both STOP and the intent guard reaches the release sink; the journal law then refuses it.
    if (name === "stopped+intent") await expect(refusal).rejects.toThrow("stale-fence");
    else await expect(refusal).rejects.toThrow("staged-import-outcome-unknown");
    expect(h.released()).toHaveLength(name === "stopped+intent" ? 1 : 0);
  });
  it("in intent while its read is in flight it throws", async () => {
    const h = await handle(["read", "mutation"]);
    let refusal: Promise<void> | undefined;
    h.hooks.provider = () => {
      refusal = h.guard.refuseBeforeMutation();
      refusal.catch(() => undefined);
    };
    await h.send(0);
    await expect(refusal).rejects.toThrow("staged-import-outcome-unknown");
    expect(h.released()).toEqual([]);
    await expect(h.send(1)).rejects.toThrow("staged-import-authority-refused");
  });
  it.each([false, true])("while busy before R0 starts it throws; busy-bypass=%s", async (bypass) => {
    const h = await handle(["read", "mutation"], bypass ? [busyBypass] : []);
    let refusal: Promise<void> | undefined;
    h.hooks.wait = () => {
      refusal = h.guard.refuseBeforeMutation();
      refusal.catch(() => undefined);
    };
    await h.send(0).catch(() => undefined);
    // The bypassed release races the in-flight send's intent; either order reaches the release sink.
    if (bypass) await refusal?.catch(() => undefined);
    else await expect(refusal).rejects.toThrow("staged-import-outcome-unknown");
    expect(h.released()).toHaveLength(bypass ? 1 : 0);
  });
  it.each([false, true])("with a failed fence it throws and latches; fence-bypass=%s", async (bypass) => {
    const h = await handle(["read", "mutation"], bypass ? [fenceBypass] : []);
    await h.send(0);
    h.setFence(false);
    const refusal = h.guard.refuseBeforeMutation();
    if (bypass) await refusal;
    else await expect(refusal).rejects.toThrow("staged-import-outcome-unknown");
    expect(h.released()).toHaveLength(bypass ? 1 : 0);
    h.setFence(true);
    await expect(h.send(1)).rejects.toThrow("staged-import-authority-refused");
    expect(h.f.starts).toEqual([60000]);
  });
  it.each([false, true])("after a stopped send with nothing started it throws; stopped-bypass=%s", async (bypass) => {
    const h = await handle(["read", "mutation"], bypass ? [stoppedBypass] : []);
    h.hooks.failPolicy = true;
    await expect(h.send(0)).rejects.toThrow("staged-import-policy-unavailable");
    expect(h.f.starts).toEqual([]);
    const refusal = h.guard.refuseBeforeMutation();
    if (bypass) await refusal;
    else await expect(refusal).rejects.toThrow("staged-import-outcome-unknown");
    expect(h.released()).toHaveLength(bypass ? 1 : 0);
  });
});
