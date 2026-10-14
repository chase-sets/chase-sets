import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
