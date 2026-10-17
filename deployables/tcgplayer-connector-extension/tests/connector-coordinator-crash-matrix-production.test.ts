import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { startLoopback } from "../__tests__/harness/loopback";
import { syntheticClaim } from "../__tests__/harness/claim";
import { syntheticExecutor } from "../__tests__/harness/executors.harness";
import { journalPhases, observeJournal } from "../__tests__/harness/journal-boundaries";
import { compose, journal } from "./connector-composition-support";

let server: Awaited<ReturnType<typeof startLoopback>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock("../src/host-registry");
});

describe("connector-coordinator-crash-matrix-production", () => {
  for (const unit of ["operation", "reservation"] as const) {
    for (const phase of journalPhases) {
      for (const side of ["pending", "committed"] as const) {
        it(`${unit} ${phase} ${side} keeps provider dispatch non-replayable`, async () => {
          server = await startLoopback();
          const database = new IDBFactory();
          const boundary = observeJournal(database, { phase, side });
          const original = syntheticExecutor(unit);
          const executor =
            phase === "outcome-unknown"
              ? {
                  ...original,
                  dispatchOnce: async (...args: Parameters<typeof original.dispatchOnce>) => {
                    await original.dispatchOnce(...args);
                    throw new Error("SYNTHETIC_RECEIPT_LOSS");
                  },
                }
              : original;
          const f = await compose([executor], database);
          await f.fixture.click();
          const claim = syntheticClaim();
          server.claims.push(claim);
          await f.fixture.alarm("connector-work");
          expect(boundary.interrupted()).toBe(true);
          const before = await journal(database);
          // A rolled-back admission is delivered again by the same platform fake.
          if (before.reservations.length === 0) server.claims.push(claim);
          const next = await compose([original], database, f.fixture.local.rows);
          await next.fixture.alarm("connector-work");
          const after = await journal(database);
          expect(server.portalCalls.length).toBeLessThanOrEqual(1);
          expect(after.members.every((member) => ["acked", "outcome-unknown"].includes(member.state))).toBe(true);
          expect(after.members).toHaveLength(1);
          if (after.members[0]?.state === "outcome-unknown") expect(unit).toBe("reservation");
          for (const row of boundary.observations)
            expect(row.stores.sort()).toEqual(["operation-attempts", "reservations"]);
          boundary.restore();
        });
      }
    }
  }
});
