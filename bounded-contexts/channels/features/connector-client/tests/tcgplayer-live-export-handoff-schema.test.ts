import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertLiveExportHandoffTransition,
  liveExportExternalReference,
  parseLiveExportHandoff,
  type LiveExportHandoff,
} from "../domain/live-export-handoff";
import { OperationProtocolError } from "../domain/operation-codec";
import { connectionId, liveExportCsv, liveExportFixture } from "./live-export-test-support";

afterEach(() => vi.restoreAllMocks());

type Fixture = Awaited<ReturnType<typeof liveExportFixture>>;
const limits = { maxBytes: 1_048_576, maxRecords: 5 };

async function shapes() {
  const f = await liveExportFixture({ limits });
  const payload = (await f.claim()).operations[0]!.payload;
  const bytes = new TextEncoder().encode(liveExportCsv(3));
  const fileSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const planned = {
    rawExportId: payload.exportId,
    fileSha256,
    downloadedAt: new Date(f.now()).toISOString(),
    byteLength: bytes.length,
    post: {
      externalReference: await liveExportExternalReference(connectionId, payload.exportId, fileSha256),
      state: "planned",
    },
  } as const satisfies LiveExportHandoff;
  const counted = (state: "dispatched" | "captured202", parsedRowCount: unknown = 3) => ({
    ...planned,
    post: { ...planned.post, state, parsedRowCount },
  });
  return { payload, planned, dispatched: counted("dispatched"), captured202: counted("captured202"), counted };
}
function refused(run: () => unknown) {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(OperationProtocolError);
  expect((error as OperationProtocolError).code).toBe("protocol-violation");
}

describe("tcgplayer-live-export-handoff-schema closed state-discriminated shape", () => {
  it("admits exactly planned without a count and dispatched/captured202 with a count from 1 through maxRecords", async () => {
    const s = await shapes();
    for (const value of [
      s.planned,
      s.dispatched,
      s.captured202,
      s.counted("dispatched", 1),
      s.counted("captured202", limits.maxRecords),
    ])
      expect(parseLiveExportHandoff(value, s.payload)).toEqual(value);
  });
  it.each([
    ["dispatched without a count", (s: Shapes) => ({ ...s.planned, post: { ...s.planned.post, state: "dispatched" } })],
    [
      "captured202 without a count",
      (s: Shapes) => ({ ...s.planned, post: { ...s.planned.post, state: "captured202" } }),
    ],
    ["planned with a count", (s: Shapes) => ({ ...s.planned, post: { ...s.planned.post, parsedRowCount: 3 } })],
    ["an unknown root field", (s: Shapes) => ({ ...s.dispatched, parsedRowCount: 3 })],
    ["an unknown planned post field", (s: Shapes) => ({ ...s.planned, post: { ...s.planned.post, note: "x" } })],
    [
      "an unknown dispatched post field",
      (s: Shapes) => ({ ...s.dispatched, post: { ...s.dispatched.post, note: "x" } }),
    ],
    [
      "an unknown captured202 post field",
      (s: Shapes) => ({ ...s.captured202, post: { ...s.captured202.post, note: "x" } }),
    ],
    ["an unknown state", (s: Shapes) => s.counted("posted" as "dispatched")],
    [
      "a missing state",
      (s: Shapes) => ({ ...s.planned, post: { externalReference: s.planned.post.externalReference } }),
    ],
    ["a missing reference", (s: Shapes) => ({ ...s.dispatched, post: { state: "dispatched", parsedRowCount: 3 } })],
    ["a null post", (s: Shapes) => ({ ...s.planned, post: null })],
    ["an array post", (s: Shapes) => ({ ...s.planned, post: [s.planned.post] })],
    ["a string post", (s: Shapes) => ({ ...s.planned, post: "planned" })],
  ] as const)("refuses %s", async (_name, shape) => {
    const s = await shapes();
    refused(() => parseLiveExportHandoff(shape(s), s.payload));
  });
  it.each([
    ["null", null],
    ["a string", "3"],
    ["a fraction", 2.5],
    ["zero", 0],
    ["a negative", -1],
    ["over maxRecords", limits.maxRecords + 1],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ] as const)("refuses %s as the count in dispatched and captured202", async (_name, count) => {
    const s = await shapes();
    for (const state of ["dispatched", "captured202"] as const)
      refused(() => parseLiveExportHandoff(s.counted(state, count), s.payload));
  });
  it.each([
    ["a foreign rawExportId", { rawExportId: "cxpl_foreign" }],
    ["an uppercase digest", { fileSha256: "A".repeat(64) }],
    ["a short digest", { fileSha256: "a".repeat(63) }],
    ["an invalid downloadedAt", { downloadedAt: "not-an-instant" }],
    ["a zero byteLength", { byteLength: 0 }],
    ["a fractional byteLength", { byteLength: 1.5 }],
    ["a byteLength over maxBytes", { byteLength: limits.maxBytes + 1 }],
  ] as const)("keeps identity validation: refuses %s", async (_name, patch) => {
    const s = await shapes();
    refused(() => parseLiveExportHandoff({ ...s.dispatched, ...patch }, s.payload));
  });
  it("refuses a reference outside the derived grammar", async () => {
    const s = await shapes();
    refused(() =>
      parseLiveExportHandoff(
        { ...s.dispatched, post: { ...s.dispatched.post, externalReference: "tcgx.v1:x" } },
        s.payload,
      ),
    );
  });
});

type Shapes = Awaited<ReturnType<typeof shapes>>;
const handoff = (value: unknown, s: Shapes) => parseLiveExportHandoff(value, s.payload);

describe("tcgplayer-live-export-handoff-schema transitions", () => {
  it("advances planned to dispatched to captured202 and admits an unchanged replay save", async () => {
    const s = await shapes();
    for (const [previous, next] of [
      [s.planned, s.planned],
      [s.planned, s.dispatched],
      [s.dispatched, s.dispatched],
      [s.dispatched, s.captured202],
      [s.captured202, s.captured202],
    ] as const)
      expect(() => assertLiveExportHandoffTransition(handoff(previous, s), handoff(next, s))).not.toThrow();
  });
  it.each([
    ["a dispatched rewind to planned", "dispatched", (s: Shapes) => s.planned],
    ["a captured202 rewind to dispatched", "captured202", (s: Shapes) => s.dispatched],
    ["a captured202 rewind to planned", "captured202", (s: Shapes) => s.planned],
    ["planned skipping the dispatched persist", "planned", (s: Shapes) => s.captured202],
    ["a dispatched count mutation", "dispatched", (s: Shapes) => s.counted("dispatched", 4)],
    ["a count mutation into captured202", "dispatched", (s: Shapes) => s.counted("captured202", 4)],
    ["a captured202 count mutation", "captured202", (s: Shapes) => s.counted("captured202", 4)],
    ["a digest mutation", "dispatched", (s: Shapes) => ({ ...s.dispatched, fileSha256: "b".repeat(64) })],
    [
      "a downloadedAt mutation",
      "dispatched",
      (s: Shapes) => ({
        ...s.dispatched,
        downloadedAt: new Date(Date.parse(s.dispatched.downloadedAt) + 1).toISOString(),
      }),
    ],
    [
      "a byteLength mutation",
      "dispatched",
      (s: Shapes) => ({ ...s.dispatched, byteLength: s.dispatched.byteLength + 1 }),
    ],
    [
      "a reference mutation",
      "captured202",
      (s: Shapes) => ({
        ...s.captured202,
        post: { ...s.captured202.post, externalReference: `tcgx.v1:${"c".repeat(64)}` },
      }),
    ],
  ] as const)("refuses %s", async (_name, from, next) => {
    const s = await shapes();
    refused(() => assertLiveExportHandoffTransition(handoff(s[from], s), handoff(next(s), s)));
  });
});

/** Rewrites the persisted member row directly, bypassing every journal write check, as a corrupted store would. */
async function persisted(f: Fixture, mutate: (handoff: Record<string, unknown>) => void) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = f.indexedDB.open("connector-raw-exports");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("operation-attempts", "readwrite");
      const store = tx.objectStore("operation-attempts");
      const all = store.getAll();
      all.onsuccess = () => {
        for (const row of all.result as { handoff: Record<string, unknown> }[]) {
          mutate(row.handoff);
          store.put(row);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
const lostAt = {
  // A worker lost after the handoff was journaled planned, before any parse.
  planned: (f: Fixture) =>
    f.store.read.mockImplementationOnce(async () => {
      throw new OperationProtocolError("stale-fence");
    }),
  // A worker lost after posting, before it observed the 202.
  dispatched: (f: Fixture) => {
    const ingest = f.platform.ingest;
    f.platform.ingest = async () => {
      f.platform.ingest = ingest;
      throw new OperationProtocolError("stale-fence");
    };
  },
  // A worker lost after captured202 was journaled, before accept.
  captured202: (f: Fixture) =>
    f.store.accept.mockImplementationOnce(async () => {
      throw new OperationProtocolError("stale-fence");
    }),
} as const;
async function interrupted(state: keyof typeof lostAt) {
  const f = await liveExportFixture();
  lostAt[state](f);
  f.platform.claims.push(await f.claim());
  await f.coordinator().coordinate(f.input);
  const member = (await f.journal.read(connectionId)).members[0];
  if (member?.operationKind !== "tcgplayer-live-export") throw new Error("live-export-member-missing");
  expect(member).toMatchObject({ state: "outcome-unknown", handoff: { post: { state } } });
  return { f, member, counters: () => [f.provider.calls.length, f.platform.posts.length, f.platform.reports.length] };
}

describe("tcgplayer-live-export-handoff-schema persistence", () => {
  it("journals the parsed count with dispatched before the POST, equal to the posted snapshot's count", async () => {
    const f = await liveExportFixture();
    let atPost: unknown;
    f.platform.ingest = async (body) => {
      atPost = { journal: (await f.journal.read(connectionId)).members[0], body: JSON.parse(body) };
      return new Response("{}", { status: 202 });
    };
    f.platform.claims.push(await f.claim());
    await f.coordinator().coordinate(f.input);
    expect(atPost).toMatchObject({
      journal: { handoff: { post: { state: "dispatched", parsedRowCount: 3 } } },
      body: { payload: { parsed: { parsedRowCount: 3 } } },
    });
    expect(f.lastOutcome()).toMatchObject({ kind: "live-export-complete", parsedRowCount: 3 });
  });
  it("the journal refuses a count mutation of a dispatched handoff", async () => {
    const { f, member } = await interrupted("dispatched");
    const state = await f.journal.read(connectionId);
    await expect(
      f.journal.change(connectionId, state, {
        reservations: state.reservations,
        members: [
          {
            ...member,
            revision: member.revision + 1,
            handoff: { ...member.handoff!, post: { ...member.handoff!.post, state: "dispatched", parsedRowCount: 2 } },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "stale-fence" });
  });
  it("a replay reproduces the journaled count; a disagreeing journal count is refused, never substituted", async () => {
    const control = await interrupted("dispatched");
    await control.f.coordinator().coordinate(control.f.input);
    expect(control.f.lastOutcome()).toMatchObject({ kind: "live-export-complete", parsedRowCount: 3 });
    expect(control.f.platform.posts).toHaveLength(2);
    expect(control.f.platform.posts[1]).toBe(control.f.platform.posts[0]);
    const { f, counters } = await interrupted("dispatched");
    await persisted(f, (handoff) => {
      (handoff.post as Record<string, unknown>).parsedRowCount = 2;
    });
    const before = counters();
    expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "protocol-violation" });
    expect(counters()).toEqual(before);
  });
  it.each([
    [
      "a count-omitted captured202",
      "captured202",
      (post: Record<string, unknown>): void => void delete post.parsedRowCount,
    ],
    [
      "a count-omitted dispatched",
      "dispatched",
      (post: Record<string, unknown>): void => void delete post.parsedRowCount,
    ],
    ["a count-bearing planned", "planned", (post: Record<string, unknown>): void => void (post.parsedRowCount = 3)],
    [
      "a zero-count captured202",
      "captured202",
      (post: Record<string, unknown>): void => void (post.parsedRowCount = 0),
    ],
  ] as const)(
    "%s persisted record is refused with no fetch, post, report or fabricated completion",
    async (_name, state, mutate) => {
      const { f, counters } = await interrupted(state);
      await persisted(f, (handoff) => mutate(handoff.post as Record<string, unknown>));
      // The journal's existing read law: an unparseable persisted row is incomplete authority, never defaulted.
      await expect(f.journal.read(connectionId)).rejects.toMatchObject({ code: "incomplete-authority" });
      const before = counters();
      for (let wake = 0; wake < 2; wake++)
        expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "unknown" });
      expect(counters()).toEqual(before);
      expect(f.platform.reports).toEqual([]);
    },
  );
});
