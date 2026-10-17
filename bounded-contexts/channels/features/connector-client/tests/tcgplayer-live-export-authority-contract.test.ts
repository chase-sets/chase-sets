import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTcgplayerFullExport } from "../../tcgplayer-csv/domain/csv";
import { tcgplayerLiveExportHeader } from "../../tcgplayer-csv/domain/profile";
import {
  isLiveExportAuthorityRequest,
  liveExportAuthorityUrl,
  tcgplayerLiveExportAuthority,
  tcgplayerLiveExportAuthorityVersion,
} from "../domain/live-export-authority";
import { liveExportCsv, liveExportExecutorMutant, liveExportFixture } from "./live-export-test-support";

type Capture = Readonly<{ source: string; sha256: string; body: string }>;
const captures: readonly Capture[] = JSON.parse(
  readFileSync(new URL("./fixtures/tcgplayer-live-export-authority-captures.json", import.meta.url), "utf8"),
);
// UTF-8 SHA256 of each COMPLETE comment or issue body, pinned by the #9288 binding annex section 6.
const pinned = {
  "https://github.com/chase-sets/chase-sets/issues/7924#issuecomment-5647783852":
    "eda78a5b62627b0a279388b231b2541569f559e34660387f961bb086f2e81949",
  "https://github.com/chase-sets/chase-sets/issues/7026#issuecomment-5555055372":
    "cc6efbfd6a8fa8db029d6d9c0898019c2bf398cab93c59f0a6a6b3515b7007ac",
  "https://github.com/chase-sets/chase-sets/issues/7924":
    "c2f1839d7d770733ae91c8aeb4052fb438fd64b2a34062346574e6ae2415c330",
} as const;
const body = (source: keyof typeof pinned) => captures.find((capture) => capture.source === source)!.body;

/** Header tokens through the landed CSV parser; the appended synthetic row only satisfies its non-empty rule. */
function headerOf(line: string): readonly string[] {
  const parsed = parseTcgplayerFullExport(
    { csv: `${line}\n${liveExportCsv(1).split("\n")[1]}\n`, surface: "staged" },
    { maxRecords: 1 },
  );
  if (parsed.kind !== "parsed") throw new Error(`capture-header-unparsed: ${parsed.reason}`);
  return parsed.header;
}

function capturedFacts() {
  const worker = body("https://github.com/chase-sets/chase-sets/issues/7924#issuecomment-5647783852");
  const records = [...worker.matchAll(/```json\n(\{.*?\})\n```/g)].map((match) => JSON.parse(match[1]!));
  const record = records.find((candidate) => candidate.capture === "exportWorkerOrigin");
  const page = worker.match(
    /Fresh page-origin comparison at `([^`]+)`: clicking Export From Live emitted GET `([^`?]+)\?([^`]+)`, no POST body, no redirect, HTTP (\d{3}), MIME `([^`]+)`\./,
  );
  const live = body("https://github.com/chase-sets/chase-sets/issues/7026#issuecomment-5555055372");
  const section = live.slice(live.indexOf("**exportFromLiveHeader**"));
  const blocks = [...section.matchAll(/```csv\n([^\n]+)\n/g)].map((match) => match[1]!);
  if (!record || !page || blocks.length < 2) throw new Error("capture-shape-moved");
  return {
    record,
    page: { at: page[1], path: page[2], query: page[3], status: Number(page[4]), mime: page[5] },
    header: headerOf(blocks[0]!),
    quotedHeader: headerOf(blocks[1]!),
  };
}
const captured = [
  "host",
  "path",
  "query",
  "method",
  "status",
  "contentType",
  "header",
  "origin",
  "capturedAt",
] as const;
function mismatches(candidate: Record<string, unknown>): string[] {
  const facts = capturedFacts();
  const expected: Record<(typeof captured)[number], unknown> = {
    host: facts.record.host,
    path: facts.record.path,
    query: facts.page.query,
    method: facts.record.method,
    status: facts.record.status,
    contentType: facts.page.mime,
    header: facts.header,
    origin: facts.record.origin,
    capturedAt: facts.record.capturedAt,
  };
  return captured.filter((field) => JSON.stringify(candidate[field]) !== JSON.stringify(expected[field]));
}

describe("tcgplayer-live-export-authority-contract", () => {
  it("checks in each complete capture body verbatim at its pinned UTF-8 digest", () => {
    expect(captures.map(({ source }) => source).sort()).toEqual(Object.keys(pinned).sort());
    for (const capture of captures) {
      const digest = createHash("sha256").update(capture.body, "utf8").digest("hex");
      expect(digest).toBe(capture.sha256);
      expect(digest).toBe(pinned[capture.source as keyof typeof pinned]);
    }
  });
  it("captured fields equal the verbatim worker record, page-origin sentence and live header", () => {
    const facts = capturedFacts();
    expect(mismatches(tcgplayerLiveExportAuthority)).toEqual([]);
    // Evidence assertions, not constant fields: no redirect at the worker and page moments, one host.
    expect(facts.record).toMatchObject({ redirected: false, finalHost: facts.record.host, bodyKind: "csv" });
    expect(facts.page).toMatchObject({ path: facts.record.path, status: facts.record.status });
    expect(facts.quotedHeader).toEqual(facts.header);
    expect(tcgplayerLiveExportAuthority.header).toBe(tcgplayerLiveExportHeader);
  });
  it("policy fields match the cited client policy, not a capture field", () => {
    const probe = body("https://github.com/chase-sets/chase-sets/issues/7924");
    expect(probe).toContain('fetch(url, { credentials: "include", ...init })');
    expect(probe).toContain("`cookies` permission forbidden");
    expect(tcgplayerLiveExportAuthority.credentials).toBe("include");
    // No-follow client policy under the exact-host fence; the capture's redirected:false is not a fetch mode.
    expect(tcgplayerLiveExportAuthority.redirect).toBe("manual");
    expect(Object.isFrozen(tcgplayerLiveExportAuthority)).toBe(true);
    expect(Object.keys(tcgplayerLiveExportAuthority).sort()).toEqual([...captured, "credentials", "redirect"].sort());
    expect(tcgplayerLiveExportAuthorityVersion).toBe("TcgplayerLiveExportAuthority/v1");
    expect(liveExportAuthorityUrl().href).toBe(
      "https://store.tcgplayer.com/Admin/Pricing/DownloadMyExportCSV?type=Pricing",
    );
  });
  it.each([
    ["host", "store.tcgplayer.co"],
    ["path", "/admin/pricing/DownloadMyExportCSV"],
    ["query", "type=Staged"],
    ["method", "POST"],
    ["status", 302],
    ["contentType", "text/html"],
    ["header", tcgplayerLiveExportHeader.slice(0, -1)],
    ["origin", "page"],
    ["capturedAt", "2026-09-12T18:10:57.656Z"],
  ] as const)("an edited %s fails against the unchanged full-body fixture", (field, value) => {
    expect(mismatches({ ...tcgplayerLiveExportAuthority, [field]: value })).toEqual([field]);
  });
  it("matches only the exact authority method, path and query", () => {
    const url = liveExportAuthorityUrl().href;
    expect(isLiveExportAuthorityRequest({ method: "GET", url })).toBe(true);
    for (const request of [
      { method: "POST", url },
      { method: "GET", url: url.replace("type=Pricing", "type=Pricing&x=1") },
      { method: "GET", url: url.replace("/Admin/", "/admin/") },
      { method: "GET", url: `${url}#fragment` },
    ])
      expect(isLiveExportAuthorityRequest(request)).toBe(false);
    for (const origin of ["https://tcgplayer.com", "http://store.tcgplayer.com", "http://localhost:46175"])
      expect(() => liveExportAuthorityUrl(origin)).toThrow("live-export-authority-origin-refused");
  });
  it("a foreign parser profile digest refuses before any network or storage call; the bypass mutant prepares", async () => {
    // A drifted client header makes the claimed profile digest foreign to this executor.
    const drifted = Object.freeze({ ...tcgplayerLiveExportAuthority, header: tcgplayerLiveExportHeader.slice(1) });
    const authority = await import("../domain/live-export-authority");
    const bindings = { "./live-export-authority": { ...authority, tcgplayerLiveExportAuthority: drifted } };
    const check = "payload.parserProfile.headerSha256 !== (await headerSha256()) ||";
    for (const [rewrites, ready] of [
      [[], false],
      [[[check, ""]], true],
    ] as const) {
      const f = await liveExportFixture({ executor: liveExportExecutorMutant(rewrites, bindings) });
      const claim = await f.claim();
      const member = claim.operations[0]!;
      const prepared = await f.executor.prepare({
        reservation: {
          schemaVersion: 1,
          connectionId: claim.connectionId,
          revision: 0,
          reservationId: claim.reservationId,
          executorKey: f.executor.key,
          reservedAt: claim.reservedAt,
          leaseExpiresAt: claim.leaseExpiresAt,
          memberOperationIds: [member.operationId],
          phase: "prepared",
        },
        members: [
          {
            schemaVersion: 1,
            connectionId: claim.connectionId,
            revision: 0,
            operationId: member.operationId,
            attemptId: member.attemptId,
            claimGeneration: member.claimGeneration,
            reservationId: claim.reservationId,
            leaseExpiresAt: claim.leaseExpiresAt,
            operationKind: member.operationKind,
            payload: member.payload,
            scheduleGeneration: member.scheduleGeneration,
            payloadDigest: member.payloadDigest,
            state: "prepared",
            preparedAt: claim.reservedAt,
          },
        ],
      });
      expect(prepared.ready).toBe(ready);
      if (!prepared.ready)
        expect(prepared.result.outcomes[0]).toMatchObject({
          outcome: { kind: "live-export-unknown", reason: "authority-unavailable" },
        });
      expect(f.request).not.toHaveBeenCalled();
      expect(f.store.write).not.toHaveBeenCalled();
    }
  });
});
