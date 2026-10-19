import { mkdtemp, mkdir, rm, writeFile, readFile, open } from "node:fs/promises";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateLostUpdateWriteGuard } from "./lost-update-write-guard.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("lost update write guard", () => {
  it("enrols the actual credential store SQL and rejects loss of its two-counter guard", async () => {
    const file = "bounded-contexts/channels/features/credentials/api/runtime.ts";
    const source = await readFile(file, "utf8");
    const root = await fixture(file, "");
    await writeFile(path.join(root, file), source);
    const result = await validateLostUpdateWriteGuard({ repoRoot: root });
    expect(result.violations).toEqual([]);
    expect(result.rows).toEqual([
      expect.objectContaining({ table: "channels_connection_credentials", classification: "guarded" }),
    ]);
    for (const column of [
      "token_generation",
      "envelope_revision",
      "version",
      "kind",
      "provider_key",
      "environment",
      "account_id",
      "connection_id",
      "payload_format",
      "created_at",
    ]) {
      const unguarded = source.replace(new RegExp(`AND ${column} = \\$\\d+`), "");
      expect(unguarded).not.toBe(source);
      await writeFile(path.join(root, file), unguarded);
      expect((await validateLostUpdateWriteGuard({ repoRoot: root })).violations).toHaveLength(1);
    }
  });
  it("fails the historical market-estimates queries.ts shape (negative control)", async () => {
    const root = await fixture(
      "bounded-contexts/pricing/features/market-estimates/read-model/queries.ts",
      `UPDATE pricing_market_price_estimates SET fresh_until = $2 WHERE estimate_id = $1`,
    );
    await expect(validateLostUpdateWriteGuard({ repoRoot: root })).resolves.toMatchObject({
      violations: [expect.stringContaining("key-only UPDATE")],
    });
  });
  it("fails a key-only write at a second keyword-free read-model path", async () => {
    const root = await fixture(
      "bounded-contexts/example/features/estimates/read-model/queries.ts",
      `UPDATE pricing_market_price_estimates SET fresh_until = $2 WHERE estimate_id = $1`,
    );
    await expect(validateLostUpdateWriteGuard({ repoRoot: root })).resolves.toMatchObject({
      violations: [expect.stringContaining("key-only UPDATE")],
    });
  });
  it("accepts a predicate proving the read state is still current", async () => {
    const root = await fixture(
      "bounded-contexts/example/features/estimates/read-model/queries.ts",
      `UPDATE pricing_market_price_estimates SET fresh_until = $2 WHERE estimate_id = $1 AND fresh_until = $3`,
    );
    await expect(validateLostUpdateWriteGuard({ repoRoot: root })).resolves.toEqual(
      expect.objectContaining({ violations: [] }),
    );
  });
  it("accepts a monotonic global-position predicate", async () => {
    const root = await fixture(
      "bounded-contexts/example/features/categories/read-model/projection.ts",
      `UPDATE category_rows SET status = $2 WHERE category_id = $1 AND last_global_position <= $3`,
    );
    await expect(validateLostUpdateWriteGuard({ repoRoot: root })).resolves.toEqual(
      expect.objectContaining({ violations: [] }),
    );
  });
});

const allowlistPath = "scripts/check-structure/lost-update-write-guard-allowlist.json";
const blueprintPath = "bounded-contexts/catalog/features/blueprints/read-model/admin-projection.ts";
const estimatesPath = "bounded-contexts/pricing/features/market-estimates/read-model/queries.ts";
const siblingPath = "bounded-contexts/pricing/features/market-estimates/read-model/entries.ts";
const credentialsPath = "bounded-contexts/channels/features/credentials/api/runtime.ts";
const blueprintTable = "catalog_admin_blueprint_detail_pages";
const estimatesTable = "pricing_market_price_estimates";
const credentialColumns = [
  "row_id",
  "token_generation",
  "envelope_revision",
  "version",
  "kind",
  "provider_key",
  "environment",
  "account_id",
  "connection_id",
  "payload_format",
  "created_at",
];
const credentialSql = `UPDATE channels_connection_credentials SET payload = $12 WHERE ${credentialColumns
  .map((column, index) => `${column} = $${index + 1}`)
  .join(" AND ")}`;

describe("central allowlist reconciliation", () => {
  it("baseline reconciliation partitions every original entry", async () => {
    const { root, original, before } = await reconciliationFixture();
    const inventory = JSON.stringify(before.rows);
    const partition = partitionBaseline(original, inventory);
    expect(partition).toEqual(
      JSON.parse(original).map((entry, index) => ({ entry, matched: index === 1 || index === 3 })),
    );
    const live = partition[1].entry;
    for (const id of [
      `${siblingPath}:44:DELETE:${blueprintTable}`,
      `${blueprintPath}:45:DELETE:${blueprintTable}`,
      `${blueprintPath}:44:UPDATE:${blueprintTable}`,
      `${blueprintPath}:44:DELETE:${estimatesTable}`,
    ]) {
      expect(partitionBaseline(JSON.stringify([{ ...live, id }]), inventory), id).toEqual([
        { entry: { ...live, id }, matched: false },
      ]);
    }

    // Bad inputs must stop before the guard's Map/Set can conceal duplicates.
    const entries = JSON.parse(original);
    const duplicate = JSON.stringify([...entries, entries[0]]);
    await writeFile(path.join(root, allowlistPath), duplicate);
    const duplicateResult = await validateLostUpdateWriteGuard({ repoRoot: root });
    expect(() => partitionBaseline(duplicate, JSON.stringify(duplicateResult.rows))).toThrow(
      "duplicate allowlist identity",
    );
    expect(() => partitionBaseline(original, JSON.stringify([...before.rows, before.rows[0]]))).toThrow(
      "duplicate inventory identity",
    );
    for (const unreadable of ["{", "null", "{}", "[null]", '[{"id":42}]']) {
      expect(() => partitionBaseline(unreadable, inventory)).toThrow();
      expect(() => partitionBaseline(original, unreadable)).toThrow();
    }
    const inconsistent = structuredClone(before.rows);
    inconsistent[0].line += 1;
    expect(() => partitionBaseline(original, JSON.stringify(inconsistent))).toThrow("inventory identity");
    await writeFile(path.join(root, allowlistPath), "{");
    await expect(validateLostUpdateWriteGuard({ repoRoot: root })).rejects.toThrow();
    await rm(path.join(root, allowlistPath));
    await expect(validateLostUpdateWriteGuard({ repoRoot: root })).rejects.toThrow("ENOENT");
  });

  it("retiring zero-match entries preserves every effective classification", async () => {
    const { root, original, before } = await reconciliationFixture();
    const survivors = partitionBaseline(original, JSON.stringify(before.rows))
      .filter(({ matched }) => matched)
      .map(({ entry }) => entry);
    const after = await discoverWithAllowlist(root, survivors);
    assertRetirement(original, before, survivors, after);
    expect(after.rows.map(({ classification }) => classification)).toContain("key-only but safe");
    expect(after.rows.map(({ classification }) => classification)).toContain("guarded");

    // Include same-size mutations to defeat count-only parity.
    for (const [label, mutate, rejection] of [
      ["changed classification", (rows) => (rows[0].classification = "key-only but safe"), "row parity"],
      ["changed identity", (rows) => (rows[0].file = siblingPath), "inventory identity"],
      ["missing row", (rows) => rows.pop(), "row parity"],
      [
        "extra row",
        (rows) =>
          rows.push({
            ...rows[0],
            id: `${siblingPath}:99:UPDATE:${estimatesTable}`,
            file: siblingPath,
            line: 99,
            kind: "UPDATE",
            table: estimatesTable,
          }),
        "row parity",
      ],
    ]) {
      const changed = structuredClone(after);
      mutate(changed.rows);
      expect(() => assertRetirement(original, before, survivors, changed), label).toThrow(rejection);
    }
    for (const records of [
      [...survivors].reverse(),
      survivors.map((entry, index) => (index === 0 ? { ...entry, reason: `${entry.reason} ` } : entry)),
      [...survivors, JSON.parse(original)[0]],
    ]) {
      const result = await discoverWithAllowlist(root, records);
      expect(() => assertRetirement(original, before, records, result)).toThrow("survivor records");
    }
  });

  it("stale retirement cannot authorize a risky write or remove a live waiver", async () => {
    const { root, original, before } = await reconciliationFixture();
    const entries = JSON.parse(original);
    const survivors = entries.filter((_, index) => index === 1 || index === 3);
    const after = await discoverWithAllowlist(root, survivors);
    assertRetirement(original, before, survivors, after);

    // Keep all sources and reasons fixed; vary only the stale record's identity.
    for (const risk of before.rows.filter((row) => row.classification === "key-only lost-update risk")) {
      const staleIndex = risk.table === blueprintTable ? 0 : 2;
      const repinned = entries.map((entry, index) => (index === staleIndex ? { ...entry, id: risk.id } : entry));
      const result = await discoverWithAllowlist(root, repinned);
      expect(result.rows.find((row) => row.id === risk.id)?.classification).toBe("key-only but safe");
      expect(result.violations).not.toContain(riskDiagnostic(risk));
      expect(() => assertRetirement(original, before, repinned, result)).toThrow("survivor records");
      expect(() => assertRetirement(original, before, survivors, result)).toThrow("row parity");
    }

    const withoutLiveWaiver = survivors.slice(1);
    const lostWaiver = await discoverWithAllowlist(root, withoutLiveWaiver);
    const liveRow = before.rows.find((row) => row.id === survivors[0].id);
    expect(lostWaiver.violations).toContain(riskDiagnostic(liveRow));
    expect(() => assertRetirement(original, before, withoutLiveWaiver, lostWaiver)).toThrow("survivor records");
    expect(() => assertRetirement(original, before, survivors, lostWaiver)).toThrow("row parity");

    const unrelatedRisk = after.rows.find((row) => row.file === siblingPath);
    const omittedRow = { ...after, rows: after.rows.filter((row) => row.id !== unrelatedRisk.id) };
    expect(() => assertRetirement(original, before, survivors, omittedRow)).toThrow("row parity");
    const suppressedRisk = {
      ...after,
      violations: after.violations.filter((line) => line !== riskDiagnostic(unrelatedRisk)),
    };
    expect(() => assertRetirement(original, before, survivors, suppressedRisk)).toThrow("diagnostic parity");
  });

  it("risk residue stays fail closed after stale retirement", async () => {
    const { root, original, before } = await reconciliationFixture();
    const survivors = JSON.parse(original).filter((_, index) => index === 1 || index === 3);
    const after = await discoverWithAllowlist(root, survivors);
    assertRetirement(original, before, survivors, after);
    const stdoutPath = path.join(root, "inventory.json");
    const stderrPath = path.join(root, "diagnostics.txt");
    const stdout = await open(stdoutPath, "w");
    const stderr = await open(stderrPath, "w");
    try {
      const exit = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [path.resolve("scripts/check-structure/lost-update-write-guard.mjs"), "--inventory"],
          { cwd: root, stdio: ["ignore", stdout.fd, stderr.fd] },
        );
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal }));
      });
      expect(exit).toEqual({ code: 1, signal: null });
    } finally {
      await Promise.all([stdout.close(), stderr.close()]);
    }
    expect(await readFile(stderrPath, "utf8")).toBe(`${after.violations.join("\n")}\n`);
    expect(JSON.parse(await readFile(stdoutPath, "utf8"))).toEqual(after.rows);

    // Freeze the retired allowlist and all other source bytes. Each credential
    // predicate independently governs safety, even after stale entries are gone.
    for (const [index, column] of credentialColumns.entries()) {
      const drifted = credentialSql.replace(`${column} = $${index + 1}`, `${column} <> $${index + 1}`);
      await writeFile(path.join(root, credentialsPath), `const sql = \`${drifted}\`;`);
      const result = await validateLostUpdateWriteGuard({ repoRoot: root });
      const credential = result.rows.find((row) => row.file === credentialsPath);
      expect(credential.classification).toBe("key-only lost-update risk");
      expect(result.violations).toEqual([
        ...after.violations.slice(0, 1),
        riskDiagnostic(credential),
        ...after.violations.slice(1),
      ]);
      expect(() => assertRetirement(original, before, survivors, result)).toThrow("row parity");
    }
  });
});

function riskDiagnostic(row) {
  return `${row.id}: key-only ${row.kind} on a read-model/projection table; add a read-state concurrency predicate or a justified allowlist entry.`;
}

function staleDiagnostic(entry) {
  return `${allowlistPath}: stale allowlist entry '${entry.id}'.`;
}

// Test-only accounting: the unmodified validator supplies discovery and
// classifications. Validate captured identities before any membership lookup.
function partitionBaseline(allowlistText, inventoryText) {
  const entries = JSON.parse(allowlistText);
  const rows = JSON.parse(inventoryText);
  for (const [label, records] of [
    ["allowlist", entries],
    ["inventory", rows],
  ]) {
    assert(Array.isArray(records), `${label} must be an array`);
    const seen = [];
    for (const record of records) {
      assert(record && typeof record.id === "string", `unreadable ${label} identity`);
      assert(
        /^bounded-contexts\/[^:]+:[1-9]\d*:(UPDATE|DELETE):[a-zA-Z_][a-zA-Z0-9_]*$/.test(record.id),
        `invalid ${label} identity`,
      );
      assert(!seen.includes(record.id), `duplicate ${label} identity: ${record.id}`);
      seen.push(record.id);
      if (label === "allowlist") {
        assert.deepEqual(Object.keys(record).sort(), ["id", "reason"]);
        assert(typeof record.reason === "string" && record.reason.trim().length >= 20, "unreadable reason");
      } else {
        assert.equal(
          record.id,
          `${record.file}:${record.line}:${record.kind}:${record.table}`,
          "inconsistent inventory identity",
        );
        assert(Number.isSafeInteger(record.line) && record.line > 0, "invalid inventory line");
        assert(
          ["guarded", "key-only but safe", "key-only lost-update risk"].includes(record.classification),
          "unreadable classification",
        );
      }
    }
  }
  return entries.map((entry) => ({ entry, matched: rows.some((row) => row.id === entry.id) }));
}

function assertRetirement(original, before, retained, after) {
  const partition = partitionBaseline(original, JSON.stringify(before.rows));
  partitionBaseline(JSON.stringify(retained), JSON.stringify(after.rows));
  assert.deepEqual(
    retained,
    partition.filter(({ matched }) => matched).map(({ entry }) => entry),
    "survivor records and order",
  );
  assert.deepEqual(after.rows, before.rows, "row parity");
  const retiredDiagnostics = partition.filter(({ matched }) => !matched).map(({ entry }) => staleDiagnostic(entry));
  assert.deepEqual(
    after.violations,
    before.violations.filter((line) => !retiredDiagnostics.includes(line)),
    "diagnostic parity",
  );
}

async function discoverWithAllowlist(root, entries) {
  await writeFile(path.join(root, allowlistPath), `${JSON.stringify(entries, null, 2)}\n`);
  return validateLostUpdateWriteGuard({ repoRoot: root });
}

async function reconciliationFixture() {
  const root = await fixture(blueprintPath, "");
  const blueprintSql = `DELETE FROM ${blueprintTable} WHERE blueprint_id = $1`;
  const estimateSql = `UPDATE ${estimatesTable} SET fresh_until = $2 WHERE estimate_id = $1`;
  for (const [file, source] of [
    [blueprintPath, `${"\n".repeat(39)}const first = \`${blueprintSql}\`;\n\n\n\nconst second = \`${blueprintSql}\`;`],
    [estimatesPath, `const first = \`${estimateSql}\`;\nconst second = \`${estimateSql} AND fresh_until = $3\`;`],
    [siblingPath, `const sql = \`${estimateSql}\`;`],
    [credentialsPath, `const sql = \`${credentialSql}\`;`],
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), source);
  }
  const entries = [
    {
      id: `${blueprintPath}:41:DELETE:${blueprintTable}`,
      reason: "Synthetic stale blueprint waiver; never move this identity.",
    },
    {
      id: `${blueprintPath}:44:DELETE:${blueprintTable}`,
      reason: "Synthetic effective waiver; preserve these exact bytes.  ",
    },
    {
      id: `${estimatesPath}:9:UPDATE:${estimatesTable}`,
      reason: "Synthetic stale estimate waiver; never guess a candidate.",
    },
    {
      id: `${estimatesPath}:2:UPDATE:${estimatesTable}`,
      reason: "Synthetic matching guarded entry must also survive retirement.",
    },
  ];
  const before = await discoverWithAllowlist(root, entries);
  // Independent fixture expectations ensure discovery cannot silently omit a
  // path or merge the two same-table candidates into one identity.
  expect(before.rows).toEqual(
    [
      [blueprintPath, 40, "DELETE", blueprintTable, "key-only lost-update risk"],
      [blueprintPath, 44, "DELETE", blueprintTable, "key-only but safe"],
      [credentialsPath, 1, "UPDATE", "channels_connection_credentials", "guarded"],
      [siblingPath, 1, "UPDATE", estimatesTable, "key-only lost-update risk"],
      [estimatesPath, 1, "UPDATE", estimatesTable, "key-only lost-update risk"],
      [estimatesPath, 2, "UPDATE", estimatesTable, "guarded"],
    ].map(([file, line, kind, table, classification]) => ({
      id: `${file}:${line}:${kind}:${table}`,
      file,
      line,
      kind,
      table,
      classification,
    })),
  );
  expect(before.violations).toEqual([
    riskDiagnostic(before.rows[0]),
    riskDiagnostic(before.rows[3]),
    riskDiagnostic(before.rows[4]),
    staleDiagnostic(entries[0]),
    staleDiagnostic(entries[2]),
  ]);
  return { root, original: await readFile(path.join(root, allowlistPath), "utf8"), before };
}

async function fixture(relativePath, sql) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lost-update-guard-"));
  roots.push(root);
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(path.join(root, "scripts/check-structure"), { recursive: true });
  await writeFile(target, `const sql = \`${sql}\`;`, "utf8");
  await writeFile(path.join(root, "scripts/check-structure/lost-update-write-guard-allowlist.json"), "[]", "utf8");
  return root;
}
