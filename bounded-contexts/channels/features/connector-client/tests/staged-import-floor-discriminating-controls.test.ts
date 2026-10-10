import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createConnectorOperationCoordinator } from "../domain/operation-coordinator";
import * as dispatch from "../domain/staged-import-dispatch";
import * as fit from "../domain/staged-import-fit";
import * as policy from "../../connector-feed/domain/staged-import-dispatch-policy";
import * as validation from "../../outbound-sync/domain/validation";
import * as records from "../domain/extension-records";
import * as codec from "../domain/operation-codec";
import { evaluate } from "./coordinator-mutation-support";
import { floorFixture } from "./staged-import-floor-test-support";

function mutant(before: string, after: string): typeof dispatch.prepareStagedImportDispatch {
  const source = readFileSync(new URL("../domain/staged-import-dispatch.ts", import.meta.url), "utf8");
  if (source.split(before).length !== 2) throw new Error("floor-mutant-anchor-moved");
  const result = evaluate(source.replace(before, after), {
    "../../outbound-sync/domain/validation": validation,
    "./extension-records": records,
    "./operation-codec": codec,
    "./staged-import-fit": fit,
    "../../connector-feed/domain/staged-import-dispatch-policy": policy,
  });
  if (typeof result.prepareStagedImportDispatch !== "function") throw new Error("missing-mutant-export");
  return result.prepareStagedImportDispatch as typeof dispatch.prepareStagedImportDispatch;
}

describe("staged-import single-bypass controls (synthetic, no provider authority)", () => {
  it.each([false, true])("request floor bypass=%s kills the start-spacing witness", async (bypass) => {
    const f = await floorFixture();
    f.ports.executors = [{ ...f.executor, prepare: async () => ({ ready: true }) }];
    await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
    let current = await f.journal.read(f.input.connectionId);
    const unit = { reservation: current.reservations[0], members: current.members };
    const prepared = await f.executor.prepare(unit);
    if (!prepared.ready) throw new Error("synthetic-prepare-refused");
    const factory = bypass
      ? mutant("const wait = Math.max(0, eligible - clock());", "eligible = clock(); const wait = 0;")
      : dispatch.prepareStagedImportDispatch;
    const guard = await factory({
      unit,
      preparation: prepared.stagedImport,
      dispatchDeadlineMs: 600000,
      epoch: "synthetic-epoch",
      platformOrigin: f.ports.platformOrigin,
      accessToken: "SYNTHETIC",
      monotonic: f.ports.clock.monotonic,
      wait: f.ports.wait,
      current: () => current,
      fence: async () => true,
      save: async (timing) => {
        current = { ...current, reservations: [{ ...unit.reservation, stagedImport: timing }] };
      },
      request: f.request,
    });
    for (const index of [0, 1, 2])
      await guard.send(
        `synthetic-hop-${index}`,
        new Request("https://synthetic-provider.invalid/hop", { redirect: "error" }),
        new AbortController().signal,
      );
    expect(f.starts).toEqual(bypass ? [0, 1000, 2000] : [60000, 120000, 180000]);
  });
  it.each([false, true])("restart-credit bypass=%s kills the full-interval witness", async (bypass) => {
    const f = await floorFixture([1000]);
    await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
    f.claims.push({
      ...f.claim,
      reservationId: "reservation-2",
      operations: f.claim.operations.map((row) => ({ ...row, operationId: "operation-2", attemptId: "attempt-2" })),
    });
    f.ports.executors = [{ ...f.executor, prepare: async () => ({ ready: true }) }];
    await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
    let current = await f.journal.read(f.input.connectionId);
    const reservation = current.reservations.find((row) => row.reservationId === "reservation-2")!;
    const unit = {
      reservation,
      members: current.members.filter((row) => row.reservationId === reservation.reservationId),
    };
    const prepared = await f.executor.prepare(unit);
    if (!prepared.ready) throw new Error("synthetic-prepare-refused");
    const factory = bypass ? mutant("row.epoch === ports.epoch &&", "true &&") : dispatch.prepareStagedImportDispatch;
    const guard = await factory({
      unit,
      preparation: prepared.stagedImport,
      dispatchDeadlineMs: 600000,
      epoch: "synthetic-new-epoch",
      platformOrigin: f.ports.platformOrigin,
      accessToken: "SYNTHETIC",
      monotonic: f.ports.clock.monotonic,
      wait: f.ports.wait,
      current: () => current,
      fence: async () => true,
      save: async (timing) => {
        current = {
          ...current,
          reservations: current.reservations.map((row) =>
            row.reservationId === reservation.reservationId ? { ...row, stagedImport: timing } : row,
          ),
        };
      },
      request: f.request,
    });
    await guard.send(
      "synthetic-hop-0",
      new Request("https://synthetic-provider.invalid/hop", { redirect: "error" }),
      new AbortController().signal,
    );
    expect(f.starts).toEqual(bypass ? [60000, 120000] : [60000, 121000]);
  });
  it.each([false, true])(
    "fresh nonce binding bypass=%s kills the zero-send witness with other inputs frozen",
    async (bypass) => {
      const f = await floorFixture([1000]);
      f.ports.executors = [{ ...f.executor, prepare: async () => ({ ready: true }) }];
      await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
      let current = await f.journal.read(f.input.connectionId);
      const unit = { reservation: current.reservations[0], members: current.members };
      const prepared = await f.executor.prepare(unit);
      if (!prepared.ready) throw new Error("synthetic-prepare-refused");
      const factory = bypass
        ? mutant("next.requestNonce !== requestNonce", "false")
        : dispatch.prepareStagedImportDispatch;
      let error: unknown;
      try {
        const guard = await factory({
          unit,
          preparation: prepared.stagedImport,
          dispatchDeadlineMs: 600000,
          epoch: "synthetic-epoch",
          platformOrigin: f.ports.platformOrigin,
          accessToken: "SYNTHETIC",
          monotonic: f.ports.clock.monotonic,
          wait: f.ports.wait,
          current: () => current,
          fence: async () => true,
          save: async (timing) => {
            current = { ...current, reservations: [{ ...unit.reservation, stagedImport: timing }] };
          },
          request: async (req) => {
            const response = await f.request(req);
            if (!req.url.includes("dispatch-policy")) return response;
            const value = await response.json();
            return Response.json({ ...value, requestNonce: "0".repeat(32) });
          },
        });
        await guard.send(
          "synthetic-hop-0",
          new Request("https://synthetic-provider.invalid/hop", { redirect: "error" }),
          new AbortController().signal,
        );
      } catch (failure) {
        error = failure;
      }
      if (bypass) expect(error).toBeUndefined();
      expect(f.starts.length === 0).toBe(!bypass);
      if (!bypass) expect(error).toBeInstanceOf(policy.StagedImportDispatchError);
    },
  );
  it.each([false, true])("fit guard bypass=%s kills the unchanged +1ms boundary witness", (bypass) => {
    let assertFit = fit.assertStagedImportFit;
    if (bypass) {
      const source = readFileSync(new URL("../domain/staged-import-fit.ts", import.meta.url), "utf8");
      const anchor = "input.costMs > input.remainingMs";
      if (source.split(anchor).length !== 2) throw new Error("fit-mutant-anchor-moved");
      const result = evaluate(source.replace(anchor, "false"), {
        "./extension-records": records,
        "../../connector-feed/domain/staged-import-dispatch-policy": policy,
      });
      assertFit = result.assertStagedImportFit as typeof fit.assertStagedImportFit;
    }
    let refused = false;
    try {
      assertFit({
        costMs: 185001,
        remainingMs: 185000,
        dispatchDeadlineMs: 600000,
        now: 0,
        leaseExpiresAt: 1800000,
        policyRemainingMs: Infinity,
      });
    } catch {
      refused = true;
    }
    expect(refused).toBe(!bypass);
  });
});
