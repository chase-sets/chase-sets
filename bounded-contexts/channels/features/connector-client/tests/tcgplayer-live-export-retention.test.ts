import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationProtocolError } from "../domain/operation-codec";
import { parseRawExport, rawExportLifetime } from "../domain/raw-export-record";
import { connectionId, liveExportExecutorMutant, liveExportFixture, sentinel } from "./live-export-test-support";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type Fixture = Awaited<ReturnType<typeof liveExportFixture>>;
const needle = new TextEncoder().encode(sentinel);
function contains(bytes: Uint8Array) {
  outer: for (let index = 0; index + needle.length <= bytes.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) if (bytes[index + offset] !== needle[offset]) continue outer;
    return true;
  }
  return false;
}
/** Every place a plaintext sentinel could rest outside worker memory in this harness. */
async function sentinelLocations(f: Fixture, downloads: string) {
  const found: string[] = [];
  for (const row of await f.rawRows()) {
    const raw = parseRawExport(row);
    if (contains(new Uint8Array(raw.ciphertext)) || JSON.stringify({ ...raw, ciphertext: null }).includes(sentinel))
      found.push(`raw-exports/${raw.rawExportId}`);
  }
  if (JSON.stringify(await f.journal.read(connectionId)).includes(sentinel)) found.push("journal");
  if (JSON.stringify(f.session).includes(sentinel)) found.push("session");
  for (const name of readdirSync(downloads))
    if (contains(readFileSync(join(downloads, name)))) found.push(`downloads/${name}`);
  return found;
}
function downloadsDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "live-export-downloads-"));
  directories.push(directory);
  return directory;
}

describe("tcgplayer-live-export-retention", () => {
  it("retains only ciphertext and journals no plaintext across ambiguous and completed admissions", async () => {
    const downloads = downloadsDirectory();
    const f = await liveExportFixture();
    f.platform.ingest = async () => new Response("{}", { status: 503 });
    f.platform.claims.push(await f.claim());
    await f.coordinator().coordinate(f.input);
    // The ambiguous admission keeps one sealed raw record; it is the scan's positive surface.
    expect(await f.rawRows()).toHaveLength(1);
    expect(await sentinelLocations(f, downloads)).toEqual([]);
    // The derived snapshot is the only plaintext that leaves the worker, and only to the platform.
    expect(f.platform.posts[0]).toContain(sentinel);
    const complete = await liveExportFixture();
    complete.platform.claims.push(await complete.claim());
    await complete.coordinator().coordinate(complete.input);
    expect(complete.lastOutcome()?.kind).toBe("live-export-complete");
    expect(await sentinelLocations(complete, downloads)).toEqual([]);
    expect(Object.keys(complete.session)).toEqual([]);
  });
  it("a temp-file mutant leaves plaintext in Downloads and fails the scan", async () => {
    const downloads = downloadsDirectory();
    const mutant = liveExportExecutorMutant(
      [
        [
          "const byteLength = fetched.bytes.byteLength;",
          "const byteLength = fetched.bytes.byteLength; writeTempFile(fetched.bytes);",
        ],
      ],
      { writeTempFile: (bytes: Uint8Array) => writeFileSync(join(downloads, "TCGplayer__MyPricing.csv"), bytes) },
    );
    const f = await liveExportFixture({ executor: mutant });
    f.platform.claims.push(await f.claim());
    await f.coordinator().coordinate(f.input);
    expect(await sentinelLocations(f, downloads)).toEqual(["downloads/TCGplayer__MyPricing.csv"]);
  });
  it("accepts on the 202 path itself: raw is removed with every sweep disabled", async () => {
    const f = await liveExportFixture();
    const sweep = vi.spyOn(f.retentionStore, "run");
    f.platform.claims.push(await f.claim());
    await f.coordinator().coordinate(f.input);
    expect(f.lastOutcome()?.kind).toBe("live-export-complete");
    expect(sweep).not.toHaveBeenCalled();
    expect(f.store.accept).toHaveBeenCalledTimes(1);
    expect(await f.rawRows()).toEqual([]);
  });
  it("two real writes schedule the retention deadline at the earliest expiry", async () => {
    const f = await liveExportFixture();
    f.platform.ingest = async () => new Response("{}", { status: 503 });
    const writes: { downloadedAt: string; expiresAt: string }[] = [];
    for (const scheduleGeneration of [1, 2]) {
      f.platform.claims.push(await f.claim({ scheduleGeneration, reservationId: `reservation-${scheduleGeneration}` }));
      await f.coordinator().coordinate(f.input);
      const member = (await f.journal.read(connectionId)).members.find(
        (row) => row.operationKind === "tcgplayer-live-export" && row.scheduleGeneration === scheduleGeneration,
      );
      if (member?.operationKind !== "tcgplayer-live-export" || !member.handoff) throw new Error("handoff-missing");
      writes.push({
        downloadedAt: member.handoff.downloadedAt,
        expiresAt: new Date(Date.parse(member.handoff.downloadedAt) + rawExportLifetime).toISOString(),
      });
      f.setNow(f.now() + 60_000);
    }
    const rows = (await f.rawRows())
      .map((row) => parseRawExport(row))
      .sort((a, b) => Date.parse(a.downloadedAt) - Date.parse(b.downloadedAt));
    expect(rows.map(({ downloadedAt, expiresAt }) => ({ downloadedAt, expiresAt }))).toEqual(writes);
    expect(new Set(rows.map((row) => row.expiresAt)).size).toBe(2);
    const earliest = Math.min(...writes.map((write) => Date.parse(write.expiresAt)));
    expect(f.scheduleDeadline.mock.calls.map(([when]) => when)).toEqual([earliest, earliest]);
  });
});

async function counters(f: Fixture) {
  return {
    fetches: f.provider.calls.length,
    posts: f.platform.posts.length,
    reports: f.platform.reports.length,
    raw: (await f.rawRows()).length,
  };
}
async function liveMember(f: Fixture) {
  const member = (await f.journal.read(connectionId)).members[0];
  if (member?.operationKind !== "tcgplayer-live-export") throw new Error("live-export-member-missing");
  return member;
}

describe("tcgplayer-live-export-retention cleanup failure", () => {
  it("a key-deletion failure after 202 surfaces cleanup-failed, keeps captured202, and the retry completes without refetch or repost", async () => {
    const f = await liveExportFixture();
    // Only the real retention store's session-key deletion fails, once, inside accept.
    f.sessionPort.remove.mockRejectedValueOnce(new Error("synthetic-session-remove-failed"));
    f.platform.claims.push(await f.claim());
    expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "cleanup-failed" });
    const retained = await liveMember(f);
    expect(retained).toMatchObject({
      state: "outcome-unknown",
      handoff: { post: { state: "captured202", parsedRowCount: 3 } },
    });
    expect(await counters(f)).toEqual({ fetches: 1, posts: 1, reports: 0, raw: 1 });
    // The bounded retry sweep removes the accepted record; completion then projects the journal.
    expect(await f.retentionStore.run({ reason: "retention", deleteAll: false })).toEqual({
      ok: true,
      nextDeadline: null,
    });
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    expect((await f.coordinator().coordinate(f.input)).outcome).toBe("ok");
    expect(decrypt).not.toHaveBeenCalled();
    expect(await counters(f)).toEqual({ fetches: 1, posts: 1, reports: 1, raw: 0 });
    expect(f.lastOutcome()).toEqual({
      kind: "live-export-complete",
      exportId: retained.payload.exportId,
      fileSha256: retained.handoff!.fileSha256,
      capturedAt: retained.handoff!.downloadedAt,
      parsedRowCount: 3,
      externalReference: retained.handoff!.post.externalReference,
    });
    expect((await liveMember(f)).handoff).toEqual(retained.handoff);
  });
  it("a terminal cap refusal whose cleanup fails surfaces cleanup-failed; the retry re-runs accept and reports with zero posts", async () => {
    const f = await liveExportFixture({ limits: { maxBytes: 1_048_576, maxRecords: 2 } });
    // accept marks the record refused, then fails before changing it: the record stays keyed and unaccepted.
    f.store.accept.mockImplementationOnce(async (rawExportId) => {
      f.sessionPort.setAccessLevel.mockRejectedValueOnce(new Error("synthetic-session-unavailable"));
      return f.retentionStore.accept(rawExportId);
    });
    f.platform.claims.push(await f.claim());
    expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "cleanup-failed" });
    expect(await liveMember(f)).toMatchObject({ state: "outcome-unknown", handoff: { post: { state: "planned" } } });
    expect(await counters(f)).toEqual({ fetches: 1, posts: 0, reports: 0, raw: 1 });
    // A periodic sweep does not own an unexpired, keyed, unaccepted record; only the accept path removes it.
    expect((await f.retentionStore.run({ reason: "retention", deleteAll: false })).ok).toBe(true);
    expect((await f.rawRows()).length).toBe(1);
    expect((await f.coordinator().coordinate(f.input)).outcome).toBe("ok");
    expect(f.lastOutcome()).toMatchObject({ kind: "live-export-unknown", reason: "raw-unreadable" });
    expect(await counters(f)).toEqual({ fetches: 1, posts: 0, reports: 1, raw: 0 });
  });
  it("an expected read refusal stays raw-unreadable and never becomes cleanup-failed", async () => {
    const f = await liveExportFixture();
    f.store.read.mockImplementationOnce(async () => {
      throw new OperationProtocolError("stale-fence");
    });
    f.platform.claims.push(await f.claim());
    expect((await f.coordinator().coordinate(f.input)).outcome).toBe("unknown");
    // Browser relaunch: keys are lost and the boot sweep removes the keyless record.
    f.relaunch();
    expect((await f.retentionStore.run({ reason: "boot", deleteAll: false })).ok).toBe(true);
    expect((await f.coordinator().coordinate(f.input)).outcome).toBe("ok");
    expect(f.lastOutcome()).toMatchObject({ kind: "live-export-unknown", reason: "raw-unreadable" });
    expect(await counters(f)).toEqual({ fetches: 1, posts: 0, reports: 1, raw: 0 });
  });
});
