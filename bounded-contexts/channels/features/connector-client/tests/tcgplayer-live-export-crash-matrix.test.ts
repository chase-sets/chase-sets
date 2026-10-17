import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stagedImportPolicy from "../../connector-feed/domain/staged-import-dispatch-policy";
import * as pullCodec from "../../outbound-sync/domain/order-pull-codec";
import * as validation from "../../outbound-sync/domain/validation";
import * as liveExportExecution from "../domain/live-export-execution";
import { OperationProtocolError } from "../domain/operation-codec";
import type { createConnectorOperationCoordinator } from "../domain/operation-coordinator";
import * as protocol from "../domain/operation-protocol";
import * as execution from "../domain/order-pull-execution";
import * as handoff from "../domain/order-pull-handoff";
import * as retention from "../domain/raw-export-record";
import * as stagedImport from "../domain/staged-import-dispatch";
import * as journal from "../integrations/connector-indexeddb";
import { evaluate } from "./coordinator-mutation-support";
import { connectionId, liveExportFixture } from "./live-export-test-support";

afterEach(() => vi.restoreAllMocks());

type Fixture = Awaited<ReturnType<typeof liveExportFixture>>;
type Restart = "worker-restart" | "browser-relaunch";
/** A worker lost at this boundary: the in-flight dispatch never journals its result. */
const lost = (): never => {
  throw new OperationProtocolError("stale-fence");
};
const boundaries = {
  "after fetch, before write": (f: Fixture) => f.store.write.mockImplementationOnce(async () => lost()),
  "after write, before handoff": (f: Fixture) =>
    f.store.write.mockImplementationOnce(async (input) => {
      await f.retentionStore.write(input);
      return lost();
    }),
  "after handoff": (f: Fixture) => f.store.read.mockImplementationOnce(async () => lost()),
  "after post, before 202 observed": (f: Fixture) => {
    const ingest = f.platform.ingest;
    f.platform.ingest = async () => {
      f.platform.ingest = ingest;
      return lost();
    };
  },
  "after 202, before accept": (f: Fixture) => f.store.accept.mockImplementationOnce(async () => lost()),
} as const;

async function restart(f: Fixture, mode: Restart) {
  if (mode === "browser-relaunch") {
    f.relaunch();
    // Boot sweeps keyless raw before any coordinate.
    expect((await f.retentionStore.run({ reason: "boot", deleteAll: false })).ok).toBe(true);
  }
}
async function crashThenResume(
  arrange: (f: Fixture) => unknown,
  mode: Restart,
  options: Parameters<typeof liveExportFixture>[0] = {},
) {
  const f = await liveExportFixture(options);
  arrange(f);
  f.platform.claims.push(await f.claim());
  await f.coordinator().coordinate(f.input);
  const rawBefore = (await f.rawRows()).length;
  const reportsAtCrash = f.platform.reports.length;
  await restart(f, mode);
  const decrypt = vi.spyOn(crypto.subtle, "decrypt");
  await f.coordinator().coordinate(f.input);
  return {
    f,
    row: {
      fetches: f.provider.calls.length,
      posts: f.platform.posts.length,
      outcome: (f.lastOutcome()?.kind === "live-export-complete" ? "complete" : f.lastOutcome()?.reason) as string,
      rawBefore,
      rawAfter: (await f.rawRows()).length,
      reportsAtCrash,
      decrypts: decrypt.mock.calls.length,
    },
  };
}

describe("tcgplayer-live-export-crash-matrix", () => {
  it("before fetch: the member stays prepared and the next coordinate dispatches once", async () => {
    let crashed = false;
    const { f, row } = await crashThenResume(() => {}, "worker-restart", {
      wrap: (executor) => ({
        ...executor,
        prepare: async (unit) => {
          if (!crashed) {
            crashed = true;
            return lost();
          }
          return executor.prepare(unit);
        },
      }),
    });
    expect(row).toMatchObject({ fetches: 1, posts: 1, outcome: "complete", rawBefore: 0, rawAfter: 0 });
    expect(row.reportsAtCrash).toBe(0);
    expect((await f.journal.read(connectionId)).members[0]?.state).toBe("acked");
  });
  it.each([
    [
      "after fetch, before write",
      "worker-restart",
      { fetches: 1, posts: 0, outcome: "download-unproven", rawBefore: 0, rawAfter: 0, decrypts: 0 },
    ],
    [
      "after write, before handoff",
      "worker-restart",
      { fetches: 1, posts: 0, outcome: "download-unproven", rawBefore: 1, rawAfter: 1, decrypts: 0 },
    ],
    [
      "after handoff",
      "worker-restart",
      { fetches: 1, posts: 1, outcome: "complete", rawBefore: 1, rawAfter: 0, decrypts: 1 },
    ],
    [
      "after handoff",
      "browser-relaunch",
      { fetches: 1, posts: 0, outcome: "raw-unreadable", rawBefore: 1, rawAfter: 0, decrypts: 0 },
    ],
    [
      "after post, before 202 observed",
      "worker-restart",
      { fetches: 1, posts: 2, outcome: "complete", rawBefore: 1, rawAfter: 0, decrypts: 1 },
    ],
    [
      "after 202, before accept",
      "worker-restart",
      { fetches: 1, posts: 1, outcome: "complete", rawBefore: 1, rawAfter: 0, decrypts: 0 },
    ],
  ] as const)("%s (%s)", async (boundary, mode, expected) => {
    const { f, row } = await crashThenResume(boundaries[boundary], mode);
    expect(row).toEqual({ ...expected, reportsAtCrash: 0 });
    // Exactly one provider fetch for this exportId, and any repost is byte-identical.
    expect(new Set(f.platform.posts).size).toBeLessThanOrEqual(1);
    if (boundary === "after write, before handoff") {
      // Present raw without a handoff is never a snapshot; only its deadline removes it.
      f.setNow(f.now() + 24 * 60 * 60 * 1000);
      expect((await f.retentionStore.run({ reason: "retention", deleteAll: false })).ok).toBe(true);
      expect(await f.rawRows()).toEqual([]);
      expect(f.store.read).not.toHaveBeenCalled();
    }
  });
  it("settled: the day-after boot, work and retention wake are inert for the exportId", async () => {
    const { f } = await crashThenResume(boundaries["after handoff"], "worker-restart");
    const settled = {
      fetches: f.provider.calls.length,
      posts: f.platform.posts.length,
      reports: f.platform.reports.length,
    };
    f.setNow(f.now() + 25 * 60 * 60 * 1000);
    for (const reason of ["boot", "work", "retention"] as const) {
      await f.retentionStore.run({ reason, deleteAll: false });
      await f.coordinator().coordinate({ ...f.input, ...(reason === "retention" ? {} : { reason }) });
    }
    expect({
      fetches: f.provider.calls.length,
      posts: f.platform.posts.length,
      reports: f.platform.reports.length,
    }).toEqual(settled);
    expect(await f.journal.read(connectionId)).toEqual({ members: [], reservations: [] });
    expect(await f.rawRows()).toEqual([]);
  });
});

const states = {
  absent: boundaries["after fetch, before write"],
  planned: boundaries["after handoff"],
  dispatched: boundaries["after post, before 202 observed"],
  captured202: boundaries["after 202, before accept"],
} as const;
async function expireAndRebind(
  state: keyof typeof states,
  mode: Restart,
  coordinator?: typeof createConnectorOperationCoordinator,
) {
  const f = await liveExportFixture(coordinator ? { coordinator } : {});
  states[state](f);
  f.platform.claims.push(await f.claim());
  await f.coordinator().coordinate(f.input);
  const retained = (await f.journal.read(connectionId)).members[0];
  await restart(f, mode);
  // The expired old lease authorizes no fetch, post or report.
  f.setNow(Date.parse(retained!.leaseExpiresAt) + 1);
  const before = {
    fetches: f.provider.calls.length,
    posts: f.platform.posts.length,
    reports: f.platform.reports.length,
  };
  await f.coordinator().coordinate(f.input);
  expect({
    fetches: f.provider.calls.length,
    posts: f.platform.posts.length,
    reports: f.platform.reports.length,
  }).toEqual(before);
  f.platform.claims.push(await f.claim({ attemptId: "attempt-2", claimGeneration: 2, reservationId: "reservation-2" }));
  await f.coordinator().coordinate(f.input);
  const report = f.platform.reports.at(-1) as { reservationId: string; outcomes: { attemptId: string }[] } | undefined;
  return { f, retained, report };
}

describe("tcgplayer-live-export-crash-matrix lease-expiry rebind", () => {
  it.each([
    ["absent", "worker-restart", "download-unproven", 0],
    ["absent", "browser-relaunch", "download-unproven", 0],
    ["planned", "worker-restart", "complete", 1],
    ["planned", "browser-relaunch", "raw-unreadable", 0],
    ["dispatched", "worker-restart", "complete", 2],
    ["dispatched", "browser-relaunch", "raw-unreadable", 1],
    ["captured202", "worker-restart", "complete", 1],
    ["captured202", "browser-relaunch", "complete", 1],
  ] as const)("%s handoff, %s: carried unchanged, %s, zero additional fetch", async (state, mode, outcome, posts) => {
    const { f, retained, report } = await expireAndRebind(state, mode);
    expect(retained?.operationKind === "tcgplayer-live-export" ? retained.handoff?.post.state : undefined).toBe(
      state === "absent" ? undefined : state,
    );
    expect(f.provider.calls).toHaveLength(1);
    expect(f.platform.posts).toHaveLength(posts);
    expect(new Set(f.platform.posts).size).toBeLessThanOrEqual(1);
    expect(f.lastOutcome()?.kind === "live-export-complete" ? "complete" : f.lastOutcome()?.reason).toBe(outcome);
    // The new attempt reports under its own identity; the retained handoff identity is unchanged.
    expect(report).toMatchObject({ reservationId: "reservation-2", outcomes: [{ attemptId: "attempt-2" }] });
    const settled = (await f.journal.read(connectionId)).members[0];
    if (
      retained?.operationKind === "tcgplayer-live-export" &&
      retained.handoff &&
      settled?.operationKind === "tcgplayer-live-export"
    ) {
      expect(settled.handoff).toMatchObject({
        rawExportId: retained.handoff.rawExportId,
        fileSha256: retained.handoff.fileSha256,
        downloadedAt: retained.handoff.downloadedAt,
        post: { externalReference: retained.handoff.post.externalReference },
      });
    }
    expect(await f.rawRows()).toEqual([]);
  });
  it.each(["dispatched", "captured202"] as const)(
    "a drop-handoff-on-rebind mutant fails the %s witness",
    async (state) => {
      const source = readFileSync(new URL("../domain/operation-coordinator.ts", import.meta.url), "utf8");
      const carry =
        '...(old?.operationKind === "tcgplayer-live-export" && old.handoff ? { handoff: old.handoff } : {}),';
      expect(source.split(carry)).toHaveLength(2);
      const mutant = evaluate(source.replace(carry, ""), {
        "../../outbound-sync/domain/validation": validation,
        "./raw-export-record": retention,
        "./order-pull-handoff": handoff,
        "./order-pull-execution": execution,
        "./live-export-execution": liveExportExecution,
        "./staged-import-dispatch": stagedImport,
        "../../connector-feed/domain/staged-import-dispatch-policy": stagedImportPolicy,
        "../../outbound-sync/domain/order-pull-codec": pullCodec,
        "../integrations/connector-indexeddb": journal,
        "./operation-protocol": protocol,
      }).createConnectorOperationCoordinator as typeof createConnectorOperationCoordinator;
      const candidate = await expireAndRebind(state, "worker-restart");
      expect(candidate.f.lastOutcome()?.kind).toBe("live-export-complete");
      const killed = await expireAndRebind(state, "worker-restart", mutant);
      expect(killed.f.lastOutcome()?.kind).not.toBe("live-export-complete");
      expect(killed.f.provider.calls).toHaveLength(1);
    },
  );
});
