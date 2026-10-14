import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveLiveExportId } from "../../outbound-sync/api/live-export-payload";
import { parseTcgplayerFullExport } from "../../tcgplayer-csv/domain/csv";
import { liveExportExternalReference } from "../domain/live-export-handoff";
import {
  connectionId,
  liveExportCsv,
  liveExportExecutorMutant,
  liveExportFixture,
  providerOrigin,
} from "./live-export-test-support";

afterEach(() => vi.restoreAllMocks());

type Fixture = Awaited<ReturnType<typeof liveExportFixture>>;
async function run(f: Fixture) {
  f.platform.claims.push(await f.claim());
  await f.coordinator().coordinate(f.input);
  return {
    outcome: f.lastOutcome(),
    fetches: f.provider.calls.length,
    posts: f.platform.posts.length,
    raw: (await f.rawRows()).length,
  };
}
function invalidUtf8() {
  const bytes = new TextEncoder().encode(liveExportCsv(3));
  bytes[bytes.length - 3] = 0xff;
  return bytes;
}
const unknown = (reason: string) => ({
  kind: "live-export-unknown",
  exportId: deriveLiveExportId(connectionId, 1),
  reason,
});
const refused = (reason: string) => ({ outcome: unknown(reason), fetches: 1, posts: 0, raw: 0 });

async function sha256(text: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Exactly the executor's envelope bytes for a fixture CSV at the fixture clock. */
async function measured(f: Fixture, csv: string) {
  const parsed = parseTcgplayerFullExport({ csv, surface: "live" }, { maxRecords: f.limits.maxRecords });
  if (parsed.kind !== "parsed") throw new Error("fixture-csv-refused");
  const fileSha256 = await sha256(csv);
  const payload = { parsed, fileSha256, capturedAt: new Date(f.now()).toISOString() };
  const externalReference = await liveExportExternalReference(
    connectionId,
    deriveLiveExportId(connectionId, 1),
    fileSha256,
  );
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  return { envelope: encode({ inboundKind: "export", externalReference, payload }), payload: encode(payload) };
}
/** A CSV whose whole posted envelope is exactly `target` bytes, padded with multibyte titles. */
async function sizedCsv(f: Fixture, target: number) {
  const one = (await measured(f, liveExportCsv(1))).envelope;
  const perRow = (await measured(f, liveExportCsv(2))).envelope - one;
  let rows = Math.floor((target - one - 4096) / perRow) + 1;
  let base = (await measured(f, liveExportCsv(rows))).envelope;
  // Row width grows with its digits, so step down until the padding is non-negative.
  while (base > target) {
    rows -= Math.ceil((base - target) / perRow) + 1;
    base = (await measured(f, liveExportCsv(rows))).envelope;
  }
  const pad = target - base;
  const csv = liveExportCsv(rows, {
    title: (index) => (index === 1 ? `${"é".repeat(Math.floor(pad / 2))}${"a".repeat(pad % 2)}` : ""),
  });
  const sizes = await measured(f, csv);
  if (sizes.envelope !== target) throw new Error("fixture-envelope-size-drift");
  return { csv, ...sizes };
}

describe("tcgplayer-live-export-completeness", () => {
  it("a complete export posts one derived snapshot and removes raw", async () => {
    const f = await liveExportFixture();
    const result = await run(f);
    expect(result).toMatchObject({ fetches: 1, posts: 1, raw: 0 });
    expect(result.outcome).toMatchObject({ kind: "live-export-complete", parsedRowCount: 3 });
  });
  it.each([
    ["non-200", { status: 500, body: "x" }, "download-unproven"],
    ["manual redirect", { status: 302, body: null, location: `${providerOrigin}/signin` }, "session-lost"],
    ["unauthorized", { status: 401, body: "" }, "session-lost"],
    ["forbidden", { status: 403, body: "" }, "session-lost"],
    [
      "HTML interstitial",
      { body: "<html>Sign in</html>", contentType: "text/html; charset=utf-8" },
      "download-unproven",
    ],
    ["CSV served without CSV MIME", { body: liveExportCsv(3), contentType: "text/html" }, "download-unproven"],
    ["missing content type", { body: liveExportCsv(3), contentType: null }, "download-unproven"],
    ["empty", { body: "" }, "download-unproven"],
    ["foreign final host", { body: liveExportCsv(3), url: "http://127.0.0.1:46176/x" }, "download-unproven"],
    ["network rejection", { reject: true }, "download-unproven"],
    ["truncated mid-record", { body: liveExportCsv(3).slice(0, -25) }, "parse-refused"],
    ["header drift", { body: liveExportCsv(3).replace("TCG Market Price", "TCG Market Price (USD)") }, "parse-refused"],
    ["invalid UTF-8", { body: invalidUtf8() }, "parse-refused"],
  ] as const)("%s yields the named unknown with zero posts and no raw record", async (name, reply, reason) => {
    const f = await liveExportFixture();
    f.provider.reply = () => reply;
    expect(await run(f)).toEqual(refused(reason));
    if (reason === "session-lost") expect(f.provider.redirectTargetCalls).toBe(0);
  });
  it("an oversized download is unproven before any write", async () => {
    const f = await liveExportFixture();
    f.provider.reply = () => ({ body: liveExportCsv(3).padEnd(f.limits.maxBytes + 1, "\n") });
    expect(await run(f)).toEqual(refused("download-unproven"));
    expect(f.store.write).not.toHaveBeenCalled();
  });
  it("cap rows complete and cap+1 rows exceed, with zero posts and no raw record", async () => {
    const limits = { maxBytes: 1_048_576, maxRecords: 5 };
    const exact = await liveExportFixture({ limits });
    exact.provider.reply = () => ({ body: liveExportCsv(5) });
    expect((await run(exact)).outcome).toMatchObject({ kind: "live-export-complete", parsedRowCount: 5 });
    const over = await liveExportFixture({ limits });
    over.provider.reply = () => ({ body: liveExportCsv(6) });
    expect(await run(over)).toEqual(refused("cap-exceeded"));
  });
  it("measures the whole envelope: exact cap posts, cap+1 and a fitting multibyte payload exceed", async () => {
    const limits = { maxBytes: 1_048_576, maxRecords: 1_000_000 };
    const probe = await liveExportFixture({ limits });
    const atCap = await sizedCsv(probe, limits.maxBytes);
    const overCap = await sizedCsv(probe, limits.maxBytes + 1);
    const multibyte = await sizedCsv(probe, limits.maxBytes + 64);
    // The multibyte payload alone fits; only the posted envelope exceeds the cap.
    expect(multibyte.payload).toBeLessThanOrEqual(limits.maxBytes);
    expect(overCap.payload).toBeLessThanOrEqual(limits.maxBytes);
    for (const [fixture, expected] of [
      [atCap, "live-export-complete"],
      [overCap, "cap-exceeded"],
      [multibyte, "cap-exceeded"],
    ] as const) {
      const f = await liveExportFixture({ limits });
      f.provider.reply = () => ({ body: fixture.csv });
      const result = await run(f);
      expect(result.outcome?.kind === "live-export-complete" ? "live-export-complete" : result.outcome?.reason).toBe(
        expected,
      );
      expect(result.posts).toBe(expected === "live-export-complete" ? 1 : 0);
      if (expected === "live-export-complete")
        expect(new TextEncoder().encode(f.platform.posts[0]!).byteLength).toBe(limits.maxBytes);
      expect(result.raw).toBe(0);
    }
  });
  it("credentials are threaded under the registered host only", async () => {
    const credentialed = await liveExportFixture();
    credentialed.provider.reply = (request) =>
      request.credentials === "include"
        ? { body: liveExportCsv(3) }
        : { status: 302, body: null, location: `${providerOrigin}/signin` };
    expect((await run(credentialed)).outcome?.kind).toBe("live-export-complete");
    const unregistered = await liveExportFixture({ executorOrigin: "http://127.0.0.1:46176" });
    expect(await run(unregistered)).toEqual({ ...refused("download-unproven"), fetches: 0 });
  });
  it("an admission that is not exactly 202 {} stays ambiguous and keeps the dispatched handoff", async () => {
    const f = await liveExportFixture();
    f.platform.ingest = async () => new Response("{}", { status: 500 });
    expect(await run(f)).toEqual({ outcome: unknown("admission-ambiguous"), fetches: 1, posts: 1, raw: 1 });
    expect((await f.journal.read(connectionId)).members[0]).toMatchObject({
      handoff: { post: { state: "dispatched", parsedRowCount: 3 } },
    });
  });
});

describe("tcgplayer-live-export-completeness guard mutants", () => {
  const cases = [
    {
      name: "session-lost reason swapped",
      rewrite: ['return { reason: "session-lost" };', 'return { reason: "download-unproven" };'],
      reply: { status: 302, body: null, location: `${providerOrigin}/signin` },
      candidate: "session-lost",
    },
    {
      name: "CSV MIME guard removed",
      rewrite: ['!/^text\\/csv(?:\\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||', ""],
      reply: { body: liveExportCsv(3), contentType: "text/html" },
      candidate: "download-unproven",
    },
    {
      name: "truncated tail repaired instead of refused",
      rewrite: [
        'parseTcgplayerFullExport({ csv, surface: "live" }',
        'parseTcgplayerFullExport({ csv: csv.slice(0, csv.lastIndexOf("\\n", csv.length - 2) + 1), surface: "live" }',
      ],
      reply: { body: liveExportCsv(3).slice(0, -25) },
      candidate: "parse-refused",
    },
    {
      name: "record cap mapped to parse refusal",
      rewrite: ['parsed.reason === "record-limit-exceeded" ? "cap-exceeded" : "parse-refused"', '"parse-refused"'],
      reply: { body: liveExportCsv(6) },
      candidate: "cap-exceeded",
      limits: { maxBytes: 1_048_576, maxRecords: 5 },
    },
    {
      name: "202 guard removed",
      rewrite: ['admitted = response.status === 202 && (await response.text()) === "{}";', "admitted = true;"],
      reply: { body: liveExportCsv(3) },
      ingest: 500,
      candidate: "admission-ambiguous",
    },
    {
      name: "credentials withheld",
      rewrite: ["credentials: authority.credentials,", 'credentials: "omit",'],
      reply: "credentialed",
      candidate: "live-export-complete",
    },
  ] as const;
  it.each(cases)("$name: candidate holds, mutant changes the witness", async (spec) => {
    const witness = async (mutant: boolean) => {
      const f = await liveExportFixture({
        ...("limits" in spec ? { limits: spec.limits } : {}),
        ...(mutant
          ? { executor: liveExportExecutorMutant([spec.rewrite as unknown as readonly [string, string]]) }
          : {}),
      });
      f.provider.reply = (request) =>
        spec.reply === "credentialed"
          ? request.credentials === "include"
            ? { body: liveExportCsv(3) }
            : { status: 302, body: null, location: `${providerOrigin}/signin` }
          : spec.reply;
      if ("ingest" in spec) f.platform.ingest = async () => new Response("{}", { status: spec.ingest });
      const result = await run(f);
      return result.outcome?.kind === "live-export-complete" ? "live-export-complete" : result.outcome?.reason;
    };
    expect(await witness(false)).toBe(spec.candidate);
    expect(await witness(true)).not.toBe(spec.candidate);
  });
  it("a payload-only size check posts the fitting multibyte payload whose envelope exceeds the cap", async () => {
    const limits = { maxBytes: 1_048_576, maxRecords: 1_000_000 };
    const multibyte = await sizedCsv(await liveExportFixture({ limits }), limits.maxBytes + 64);
    const mutant = liveExportExecutorMutant([
      [
        "if (new TextEncoder().encode(body).byteLength > limits.maxBytes)",
        "if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > limits.maxBytes)",
      ],
    ]);
    for (const [executor, posts] of [
      [undefined, 0],
      [mutant, 1],
    ] as const) {
      const f = await liveExportFixture({ limits, ...(executor ? { executor } : {}) });
      f.provider.reply = () => ({ body: multibyte.csv });
      expect((await run(f)).posts).toBe(posts);
    }
  });
});
