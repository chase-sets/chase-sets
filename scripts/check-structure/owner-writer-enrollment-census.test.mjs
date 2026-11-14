import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";
import { discoverOwnerWriters, enrollmentErrors, ownerWriterSources } from "./owner-writer-enrollment-census.mjs";

const manifest = JSON.parse(
  readFileSync(path.join(repoRoot, "scripts/check-structure/owner-writer-enrollment.json"), "utf8"),
);
describe("owner writer enrollment census", () => {
  it("closes every append, handler and SQL writer discovered by owner dataflow", () => {
    expect(enrollmentErrors(discoverOwnerWriters(ownerWriterSources()), manifest)).toEqual([]);
  });
  it("binds every enrollment and exclusion to an existing source symbol and executable proof", () => {
    for (const row of manifest.writers) {
      const [sourcePath, sourceSymbol] = (row.enrollment ?? row.sourceSymbol).split("::");
      const code = readFileSync(path.join(repoRoot, sourcePath), "utf8");
      for (const symbol of sourceSymbol.split(" > ")) expect(code).toContain(symbol);
      if (row.foldTest) {
        const [testPath, title] = row.foldTest.split("::");
        expect(readFileSync(path.join(repoRoot, testPath), "utf8")).toContain(title);
      }
    }
    const fence = readFileSync(
      path.join(repoRoot, "bounded-contexts/identity/features/account-management/api/fences.ts"),
      "utf8",
    );
    expect(fence.indexOf("await ownerEpochs.enroll(client, inputs)")).toBeLessThan(
      fence.indexOf("return store.appendToStreamsInTransaction(client, inputs)"),
    );
  });
  it.each([
    `const hidden = 'identity.account-' + id; function planted() { return store.appendToStream({ streamId: hidden, events }); }`,
    `const hidden = 'identity.user-' + id; function planted() { return renamed.appendToStreams([{ streamId: hidden, events }]); }`,
    `const save = store.appendToStream; const hidden = 'identity.account-' + id; function planted() { return save({streamId: hidden, events}); }`,
    `const hidden = 'identity.' + 'account-' + id; function planted() { return store.appendToStream({streamId: hidden, events}); }`,
    "const table = 'event_store_events'; const hidden = 'identity.user-' + id; function planted() { return db.query(`INSERT INTO ${table} (stream_id) VALUES ($1)`, [hidden]); }",
    `function planted() { return db.query('INSERT INTO event_store_events (stream_id) VALUES ($1)', ['identity.membership-' + id]); }`,
    `function planted() { return db.query('UPDATE event_store_events SET payload = $1 WHERE stream_id = $2', [payload, 'identity.account-' + id]); }`,
  ])("rejects a planted unenrolled physical writer regardless of path vocabulary", (code) => {
    const sites = discoverOwnerWriters({ "packages/innocent/adapter.ts": code });
    expect(sites).toHaveLength(1);
    expect(enrollmentErrors(sites, { writers: [] })[0]).toContain("UNKNOWN writer");
  });
  it("requires source symbols and fold proof for exclusions", () => {
    const site = { file: "x.ts", symbol: "x", sink: "store.appendToStream", keys: ["account"] };
    expect(enrollmentErrors([site], { writers: [{ ...site, disposition: "excluded" }] })).toEqual([
      expect.stringContaining("unproven exclusion"),
    ]);
  });
});
