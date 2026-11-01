import { access, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverWrites, validateLostUpdateWriteGuard as candidateGuard } from "./lost-update-write-guard.mjs";
import { readTrackedSidecarPaths } from "../lib/git-listing.mjs";

const roots = [];
const repoRoot = process.cwd();
const REPOSITORY_SCAN_TEST_TIMEOUT_MS = 120_000;
const allowlistPath = "scripts/check-structure/lost-update-write-guard-allowlist.json";
const estimatesPath = "bounded-contexts/pricing/features/market-estimates/read-model/queries.ts";
const credentialsPath = "bounded-contexts/channels/features/credentials/api/runtime.ts";
const siblingPath = "bounded-contexts/pricing/features/market-estimates/read-model/entries.ts";
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
const git = (...args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
// The last central-reader revision is discoverable after landing too. During
// cutover it is the final main merge base; future source edits need not preserve
// historical line numbers, so the complete parity probe uses that exact tree.
const removal = git("log", "-1", "--format=%H", "--diff-filter=D", "--", allowlistPath).trim();
const base = removal ? `${removal}^` : git("merge-base", "HEAD", "origin/main").trim();
const legacySource = git("show", `${base}:scripts/check-structure/lost-update-write-guard.mjs`);
const legacy = (await import(`data:text/javascript;base64,${Buffer.from(legacySource).toString("base64")}`))
  .validateLostUpdateWriteGuard;
const candidateSource = await readFile(
  path.join(repoRoot, "scripts/check-structure/lost-update-write-guard.mjs"),
  "utf8",
);
const scannerPathspecs = [
  ":(glob)bounded-contexts/**/read-model/**",
  ":(glob)bounded-contexts/**/*projection.*",
  ":(glob)bounded-contexts/**/*queue.*",
  "bounded-contexts/channels/features/credentials/api/runtime.ts",
];
const compilerApiUrl = import.meta.resolve("@chase-sets/typescript-compiler-api");
const [legacyPredicate, candidatePredicate] = await Promise.all(
  [legacySource, candidateSource].map(async (source) => {
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(
        `${source
          .replace('"@chase-sets/typescript-compiler-api"', JSON.stringify(compilerApiUrl))
          .replace(
            '"../lib/git-listing.mjs"',
            JSON.stringify(new URL("../lib/git-listing.mjs", import.meta.url).href),
          )}\nexport { isReadModelOrProjectionFile as __predicate };`,
      ).toString("base64")}`
    );
    return module.__predicate;
  }),
);
const validateLostUpdateWriteGuard = process.env.LOST_UPDATE_BASE_CONTROL === "1" ? legacy : candidateGuard;
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("owner-local lost-update exceptions", () => {
  it("accepts delayed correct tracked-sidecar output without elapsed-time assertions", async () => {
    const source = "const sql = `DELETE FROM category_rows WHERE category_id = $1`;";
    const root = await fixture(siblingPath, source);
    const entries = await exceptions(root, siblingPath, source);
    await mkdir(path.join(root, ".git"), { recursive: true });
    const runGit = (_file, args) => ({
      status: 0,
      stdout: `${siblingPath}.lost-update-exceptions.json\0`,
    });
    expect((await candidateGuard({ repoRoot: root, runGit })).violations).toEqual([]);
    expect(entries).toHaveLength(1);
  });

  it.each([
    ["nonzero", () => ({ status: 1, stdout: "", stderr: "fatal" }), "status 1"],
    ["missing", () => undefined, "no result"],
    ["malformed", () => ({ status: 0, stdout: null }), "malformed output"],
  ])("rejects %s Git inspection state", (_name, runGit, message) => {
    expect(() => readTrackedSidecarPaths({ cwd: repoRoot, runGit })).toThrow(message);
  });

  it("does not retain the removed tracked-sidecar deadline", async () => {
    const source = await readFile("scripts/check-structure/lost-update-write-guard.mjs", "utf8");
    expect(source).not.toContain("timeout: 10000");
  });

  it("enrols the actual credential store SQL and rejects loss of its two-counter guard", async () => {
    const source = await readFile(credentialsPath, "utf8");
    const root = await fixture(credentialsPath, source);
    const result = await candidateGuard({ repoRoot: root });
    expect(result.violations).toEqual([]);
    expect(result.rows).toEqual([
      expect.objectContaining({ table: "channels_connection_credentials", classification: "guarded" }),
    ]);
    for (const column of credentialColumns.filter((name) => name !== "row_id")) {
      const unguarded = source.replace(new RegExp(`AND ${column} = \\$\\d+`), "");
      expect(unguarded).not.toBe(source);
      await put(root, credentialsPath, unguarded);
      expect((await candidateGuard({ repoRoot: root })).violations).toHaveLength(1);
    }
  });

  it("fails the historical market-estimates queries.ts shape (negative control)", async () => {
    const root = await fixture(
      estimatesPath,
      "const sql = `UPDATE pricing_market_price_estimates SET fresh_until = $2 WHERE estimate_id = $1`;",
    );
    await expect(candidateGuard({ repoRoot: root })).resolves.toMatchObject({
      violations: [expect.stringContaining("key-only UPDATE")],
    });
  });

  it("fails a key-only write at a second keyword-free read-model path", async () => {
    const root = await fixture(
      "bounded-contexts/example/features/estimates/read-model/queries.ts",
      "const sql = `UPDATE pricing_market_price_estimates SET fresh_until = $2 WHERE estimate_id = $1`;",
    );
    await expect(candidateGuard({ repoRoot: root })).resolves.toMatchObject({
      violations: [expect.stringContaining("key-only UPDATE")],
    });
  });

  it("accepts a predicate proving the read state is still current", async () => {
    const root = await fixture(
      "bounded-contexts/example/features/estimates/read-model/queries.ts",
      "const sql = `UPDATE pricing_market_price_estimates SET fresh_until = $2 WHERE estimate_id = $1 AND fresh_until = $3`;",
    );
    await expect(candidateGuard({ repoRoot: root })).resolves.toEqual(expect.objectContaining({ violations: [] }));
  });

  it("accepts a monotonic global-position predicate", async () => {
    const root = await fixture(
      "bounded-contexts/example/features/categories/read-model/projection.ts",
      "const sql = `UPDATE category_rows SET status = $2 WHERE category_id = $1 AND last_global_position <= $3`;",
    );
    await expect(candidateGuard({ repoRoot: root })).resolves.toEqual(expect.objectContaining({ violations: [] }));
  });

  it(
    "exception migration preserves complete classifications",
    { timeout: REPOSITORY_SCAN_TEST_TIMEOUT_MS },
    async () => {
      const root = await fixture();
      const archive = path.join(root, "base.tar");
      const inventory = git("ls-tree", "-r", "--name-only", base, "--", "bounded-contexts")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      expect(inventory.every((file) => legacyPredicate(file) === candidatePredicate(file))).toBe(true);
      const expectedScannerFiles = inventory.filter(candidatePredicate);
      execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, base, "--", ...scannerPathspecs], {
        cwd: repoRoot,
        timeout: 30000,
      });
      execFileSync("tar", ["-xf", archive, "-C", root], { timeout: 30000 });
      if (removal) {
        const sidecarArchive = path.join(root, "sidecars.tar");
        execFileSync(
          "git",
          [
            "archive",
            "--format=tar",
            `--output=${sidecarArchive}`,
            removal,
            "--",
            ":(glob)bounded-contexts/**/*.lost-update-exceptions.json",
          ],
          { cwd: repoRoot, timeout: 30000 },
        );
        execFileSync("tar", ["-xf", sidecarArchive, "-C", root], { timeout: 30000 });
      }
      for (const file of expectedScannerFiles) await access(path.join(root, file));
      const original = git("show", `${base}:${allowlistPath}`);
      await put(root, allowlistPath, original);
      const before = await legacy({ repoRoot: root });
      const partition = partitionBaseline(original, JSON.stringify(before.rows));
      expect(partition.every(({ matched }) => matched)).toBe(true);
      const sidecars = [];
      const files = [
        ...new Set(before.rows.filter((row) => row.classification === "key-only but safe").map((row) => row.file)),
      ];
      for (const file of files) {
        const sidecarPath = `${file}.lost-update-exceptions.json`;
        const text = await readFile(path.join(removal ? root : repoRoot, sidecarPath), "utf8");
        await put(root, `${file}.lost-update-exceptions.json`, text);
        for (const entry of JSON.parse(text)) sidecars.push({ file, entry });
      }
      await put(root, allowlistPath, "[]");
      const after = await validateLostUpdateWriteGuard({ repoRoot: root });
      assertMigration(original, before, sidecars, after);
      expect(await readFile(path.join(repoRoot, allowlistPath), "utf8").catch((error) => error.code)).toBe("ENOENT");

      // Membership and identity controls, including same-size replacement. These
      // compare independent base records, not a candidate-generated snapshot.
      for (const mutant of [
        sidecars.slice(1),
        [...sidecars, sidecars[0]],
        sidecars.map((item, i) => (i ? item : { ...item, entry: { ...item.entry, reason: `${item.entry.reason} ` } })),
      ])
        expect(() => assertMigration(original, before, mutant, after)).toThrow();
      const mutated = structuredClone(after);
      mutated.rows[0].classification =
        mutated.rows[0].classification === "guarded" ? "key-only lost-update risk" : "guarded";
      expect(() => assertMigration(original, before, sidecars, mutated)).toThrow("row parity");
      expect(() => assertMigration(original, before, sidecars, { ...after, rows: after.rows.slice(1) })).toThrow(
        "row parity",
      );
      const first = sidecars[0];
      const target = `${first.file}.lost-update-exceptions.json`;
      const controlRoot = await fixture(first.file, await readFile(path.join(root, first.file), "utf8"));
      const records = JSON.parse(await readFile(path.join(root, target), "utf8"));
      await put(controlRoot, target, JSON.stringify(records));
      const intact = await validateLostUpdateWriteGuard({ repoRoot: controlRoot });
      const strip = ({ id, file, line, kind, table, classification, binding }) => ({
        id,
        file,
        line,
        kind,
        table,
        classification,
        binding,
      });
      expect(intact.rows.filter((row) => row.file === first.file).map(strip)).toEqual(
        after.rows.filter((row) => row.file === first.file).map(strip),
      );
      await put(controlRoot, target, JSON.stringify(records.slice(1)));
      const lost = await validateLostUpdateWriteGuard({ repoRoot: controlRoot });
      const intactRows = intact.rows.filter((row) => row.file === first.file);
      const lostRows = lost.rows.filter((row) => row.file === first.file);
      const differences = lostRows.filter(
        (row, index) => JSON.stringify(strip(row)) !== JSON.stringify(strip(intactRows[index])),
      );
      expect(differences).toHaveLength(1);
      expect(differences[0].binding).toEqual(sidecars[0].entry.binding);
      expect(differences[0].classification).toBe("key-only lost-update risk");
      const replacements = new Map(lostRows.map((row) => [row.id, row]));
      const spliced = { ...after, rows: after.rows.map((row) => replacements.get(row.id) ?? row) };
      expect(() => assertMigration(original, before, sidecars.slice(1), spliced)).toThrow("row parity");
    },
  );

  it("unrelated lines preserve write binding but statement changes refuse", async () => {
    const source = await readFile(estimatesPath, "utf8");
    const root = await fixture(estimatesPath, source);
    const entries = await exceptions(root, estimatesPath, source);
    const original = await validateLostUpdateWriteGuard({ repoRoot: root });
    expect(original.rows.some((row) => row.classification === "key-only but safe")).toBe(true);
    for (const changed of [
      `// unrelated heading\n\n${source}`,
      source.replace(/export async function/, "\n\nexport async function"),
    ]) {
      await put(root, estimatesPath, changed);
      const result = await validateLostUpdateWriteGuard({ repoRoot: root });
      expect(result.violations).toEqual(original.violations);
      expect(result.rows.map(({ binding, classification }) => ({ binding, classification }))).toEqual(
        original.rows.map(({ binding, classification }) => ({ binding, classification })),
      );
      expect(await readFile(path.join(root, `${estimatesPath}.lost-update-exceptions.json`), "utf8")).toBe(
        JSON.stringify(entries),
      );
    }
    // Literal whitespace is data, as are interpolation expression tokens.
    for (const sql of [
      "UPDATE pricing_market_price_estimates SET fresh_until = $2 WHERE estimate_id = $1",
      "UPDATE pricing_market_price_estimates SET fresh_until = ${input.value} WHERE estimate_id = $1",
    ]) {
      const fixtureSource = `export async function save(db, input) { await db.query(\`${sql}\`); }`;
      await put(root, estimatesPath, fixtureSource);
      await exceptions(root, estimatesPath, fixtureSource);
      for (const mutated of [
        fixtureSource.replace("SET fresh_until", "SET  fresh_until"),
        fixtureSource.replace(sql.includes("${") ? "input.value" : "$2", sql.includes("${") ? "input.other" : "$3"),
      ]) {
        await put(root, estimatesPath, mutated);
        const result = await validateLostUpdateWriteGuard({ repoRoot: root });
        expect(result.rows[0].classification).toBe("key-only lost-update risk");
        expect(result.violations.some((line) => line.includes("stale sidecar"))).toBe(true);
      }
    }
    const credential = await readFile(credentialsPath, "utf8");
    await put(root, credentialsPath, credential);
    const beforeCredential = await validateLostUpdateWriteGuard({ repoRoot: root });
    await put(root, credentialsPath, `// unrelated\n\n${credential}`);
    const movedCredential = await validateLostUpdateWriteGuard({ repoRoot: root });
    expect(movedCredential.rows.find((row) => row.file === credentialsPath).binding).toEqual(
      beforeCredential.rows.find((row) => row.file === credentialsPath).binding,
    );
    expect(movedCredential.rows.find((row) => row.file === credentialsPath).classification).toBe("guarded");
  });

  it("exception bindings reject stale duplicate ambiguous and credential drift", async () => {
    const source =
      "export async function save(db) { await db.query(`UPDATE pricing_market_price_estimates SET fresh_until = $2 WHERE estimate_id = $1`); }";
    const root = await fixture(siblingPath, source);
    const entries = await exceptions(root, siblingPath, source);
    expect((await validateLostUpdateWriteGuard({ repoRoot: root })).violations).toEqual([]);
    for (const [label, records, diagnostic] of [
      ["malformed", "{", "malformed sidecar"],
      ["shape", "{}", "must contain an array"],
      ["unjustified", JSON.stringify([{ ...entries[0], reason: "short" }]), "justification"],
      ["duplicate", JSON.stringify([...entries, entries[0]]), "duplicat"],
      [
        "stale",
        JSON.stringify([{ ...entries[0], binding: { ...entries[0].binding, digest: "0".repeat(64) } }]),
        "stale sidecar",
      ],
      [
        "cross-module",
        JSON.stringify([{ ...entries[0], binding: { ...entries[0].binding, module: estimatesPath } }]),
        "cross-module",
      ],
      [
        "directory",
        JSON.stringify([
          { ...entries[0], binding: { ...entries[0].binding, module: path.posix.dirname(siblingPath) } },
        ]),
        "cross-module",
      ],
    ]) {
      await put(root, `${siblingPath}.lost-update-exceptions.json`, records);
      const result = await validateLostUpdateWriteGuard({ repoRoot: root });
      expect(
        result.violations.some((line) => line.includes(diagnostic)),
        label,
      ).toBe(true);
      expect(result.rows[0].classification, label).toBe("key-only lost-update risk");
    }
    await put(root, `${siblingPath}.lost-update-exceptions.json`, JSON.stringify(entries));
    await put(
      root,
      siblingPath,
      `${source}\nexport async function future(db) { await db.query(\`UPDATE unrelated_rows SET value = $2 WHERE id = $1\`); }`,
    );
    expect((await validateLostUpdateWriteGuard({ repoRoot: root })).rows[1].classification).toBe(
      "key-only lost-update risk",
    );
    await put(
      root,
      siblingPath,
      source.replace(
        "await db.query",
        "await db.query(`UPDATE pricing_market_price_estimates SET fresh_until = $2 WHERE estimate_id = $1`); await db.query",
      ),
    );
    const ambiguous = await validateLostUpdateWriteGuard({ repoRoot: root });
    expect(ambiguous.violations.length).toBeGreaterThan(0);
    expect(ambiguous.rows.every((row) => row.classification === "key-only lost-update risk")).toBe(true);
    const credential = await readFile(credentialsPath, "utf8");
    await rm(path.join(root, siblingPath));
    await rm(path.join(root, `${siblingPath}.lost-update-exceptions.json`));
    await put(root, credentialsPath, credential);
    expect((await validateLostUpdateWriteGuard({ repoRoot: root })).violations).toEqual([]);
    const updateStart = credential.indexOf("UPDATE channels_connection_credentials");
    const updateEnd = credential.indexOf("`", updateStart);
    const whereStart = credential.indexOf("WHERE", updateStart);
    for (const column of credentialColumns) {
      const mutated =
        credential.slice(0, whereStart) +
        credential.slice(whereStart, updateEnd).replace(new RegExp(`\\b${column} = \\$\\d+`), "") +
        credential.slice(updateEnd);
      expect(mutated).not.toBe(credential);
      await put(root, credentialsPath, mutated);
      const result = await validateLostUpdateWriteGuard({ repoRoot: root });
      expect(result.rows[0].classification, column).toBe("key-only lost-update risk");
      await exceptions(root, credentialsPath, mutated);
      expect(
        (await validateLostUpdateWriteGuard({ repoRoot: root })).rows[0].classification,
        `${column} cannot be waived`,
      ).toBe("key-only lost-update risk");
      await rm(path.join(root, `${credentialsPath}.lost-update-exceptions.json`));
    }
  });

  it("keeps fulfillment's identical risk siblings outside the named waiver", async () => {
    const file = "bounded-contexts/fulfillment/features/shipments/read-model/projection.ts";
    const source = await readFile(file, "utf8");
    const root = await fixture(file, source);
    await put(
      root,
      `${file}.lost-update-exceptions.json`,
      await readFile(`${file}.lost-update-exceptions.json`, "utf8"),
    );
    const result = await validateLostUpdateWriteGuard({ repoRoot: root });
    const duplicates = result.rows.filter((row) => row.binding?.boundary && row.table === "fulfillment_shipment_pages");
    expect(duplicates.some((row) => row.classification === "key-only but safe")).toBe(true);
    expect(
      duplicates.filter((row) => row.classification === "key-only lost-update risk").length,
    ).toBeGreaterThanOrEqual(2);
    const records = JSON.parse(await readFile(path.join(root, `${file}.lost-update-exceptions.json`), "utf8"));
    for (const entry of records) delete entry.binding.boundary;
    await put(root, `${file}.lost-update-exceptions.json`, JSON.stringify(records));
    expect(
      (await validateLostUpdateWriteGuard({ repoRoot: root })).violations.some((line) =>
        line.includes("stale sidecar"),
      ),
    ).toBe(true);
  });

  it("rejects orphaned sidecars and source relocation without rebinding", async () => {
    const source = "const sql = `DELETE FROM category_rows WHERE category_id = $1`;";
    const root = await fixture(estimatesPath, source);
    await exceptions(root, estimatesPath, source);
    await put(root, siblingPath, source);
    await put(
      root,
      `${siblingPath}.lost-update-exceptions.json`,
      await readFile(path.join(root, `${estimatesPath}.lost-update-exceptions.json`), "utf8"),
    );
    await rm(path.join(root, estimatesPath));
    const result = await validateLostUpdateWriteGuard({ repoRoot: root });
    expect(result.violations.some((line) => line.includes("owner source is missing"))).toBe(true);
    expect(result.violations.some((line) => line.includes("cross-module"))).toBe(true);
    expect(result.rows[0].classification).toBe("key-only lost-update risk");
  });

  it("ignores built output without letting sidecars choose the scanner population", async () => {
    const source = "const sql = `DELETE FROM category_rows WHERE category_id = $1`;";
    const root = await fixture(siblingPath, source);
    const before = await validateLostUpdateWriteGuard({ repoRoot: root });
    await put(root, "bounded-contexts/pricing/dist/read-model/queries.ts", source);
    await put(root, "bounded-contexts/pricing/dist/read-model/queries.ts.lost-update-exceptions.json", "{");
    expect(await validateLostUpdateWriteGuard({ repoRoot: root })).toEqual(before);
    expect(before.rows[0].classification).toBe("key-only lost-update risk");
  });

  it("keeps interpolation trivia out of the digest but preserves token and literal data", () => {
    const binding = (expression) =>
      discoverWrites({
        relativeFile: siblingPath,
        source: `function save(){ return \`UPDATE rows SET value = \${${expression}} WHERE id = $1\`; }`,
      })[0].binding;
    expect(binding("input.value")).toEqual(binding(" input /* comment */ . value "));
    expect(binding("'a b'")).not.toEqual(binding("'ab'"));
    expect(binding("input.value")).not.toEqual(binding("input.other"));
  });

  it("requires sidecars to be tracked in a repository", async () => {
    const source = "const sql = `DELETE FROM category_rows WHERE category_id = $1`;";
    const root = await fixture(siblingPath, source);
    await exceptions(root, siblingPath, source);
    execFileSync("git", ["init", "--quiet"], { cwd: root, timeout: 10000 });
    const untracked = await validateLostUpdateWriteGuard({ repoRoot: root });
    expect(untracked.violations.some((line) => line.includes("untracked sidecar"))).toBe(true);
    expect(untracked.rows[0].classification).toBe("key-only lost-update risk");
    execFileSync("git", ["add", "."], { cwd: root, timeout: 10000 });
    expect((await validateLostUpdateWriteGuard({ repoRoot: root })).violations).toEqual([]);
  });

  it("kills the kind-table-only binding bypass mutant", async () => {
    const source = "function save(){ return `UPDATE category_rows SET value = $2 WHERE id = $1`; }";
    const root = await fixture(siblingPath, source);
    await exceptions(root, siblingPath, source);
    await put(root, siblingPath, source.replace("$2", "$3"));
    const assertRefusal = (result) => expect(result.rows[0].classification).toBe("key-only lost-update risk");
    assertRefusal(await validateLostUpdateWriteGuard({ repoRoot: root }));
    const guardSource = await readFile("scripts/check-structure/lost-update-write-guard.mjs", "utf8");
    const governingMatch =
      "const matches = sidecarEntriesByBinding.get(`${row.file}\\u0000${JSON.stringify(row.binding)}`) ?? [];";
    expect(guardSource.split(governingMatch)).toHaveLength(2);
    const mutantSource = guardSource
      .replace(
        governingMatch,
        "const matches = sidecarEntries.filter((entry) => entry.source === row.file && entry.binding.kind === row.kind && entry.binding.table === row.table);",
      )
      .replace(
        '"@chase-sets/typescript-compiler-api"',
        JSON.stringify(import.meta.resolve("@chase-sets/typescript-compiler-api")),
      )
      .replace('"../lib/git-listing.mjs"', JSON.stringify(new URL("../lib/git-listing.mjs", import.meta.url).href));
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(mutantSource).toString("base64")}`);
    const bypassed = await mutant.validateLostUpdateWriteGuard({ repoRoot: root });
    expect(() => assertRefusal(bypassed)).toThrow();
    expect(bypassed.rows[0].classification).toBe("key-only but safe");
  });

  it("binds nested constants and unnamed closures to the nearest named owner", () => {
    const source =
      'const handlers = { "owner.changed": async () => { await transaction(async () => { const sql = `DELETE FROM rows WHERE id = ${key}`; await query(sql); }); }, "owner.removed": async () => { const sql = `DELETE FROM rows WHERE id = ${key}`; } };';
    const rows = discoverWrites({ source, relativeFile: siblingPath });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.binding.boundary)).toEqual(['"owner.changed"', '"owner.removed"']);
    expect(rows[0].binding.digest).toBe(rows[1].binding.digest);
  });
});

async function fixture(file, source = "") {
  const root = await mkdtemp(path.join(os.tmpdir(), "lost-update-guard-"));
  roots.push(root);
  await mkdir(path.join(root, "bounded-contexts"), { recursive: true });
  await put(root, allowlistPath, "[]");
  if (file) await put(root, file, source);
  return root;
}

async function put(root, file, source) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), source);
}

async function exceptions(root, file, source) {
  const entries = discoverWrites({ source, relativeFile: file })
    .filter((row) => !row.guarded)
    .map((row, index) => ({
      id: `synthetic-exception-${index}`,
      binding: row.binding,
      classification: "key-only but safe",
      reason: "Synthetic exact write exception for isolated binding controls.",
    }));
  await put(root, `${file}.lost-update-exceptions.json`, JSON.stringify(entries));
  return entries;
}

function partitionBaseline(allowlistText, inventoryText) {
  const entries = JSON.parse(allowlistText);
  const rows = JSON.parse(inventoryText);
  for (const [label, records] of [
    ["allowlist", entries],
    ["inventory", rows],
  ]) {
    assert(Array.isArray(records), `${label} must be an array`);
    const seen = new Set();
    for (const record of records) {
      assert(record && typeof record.id === "string", `unreadable ${label} identity`);
      assert(
        /^bounded-contexts\/[^:]+:[1-9]\d*:(UPDATE|DELETE):[a-zA-Z_][a-zA-Z0-9_]*$/.test(record.id),
        `invalid ${label} identity`,
      );
      assert(!seen.has(record.id), `duplicate ${label} identity`);
      seen.add(record.id);
      if (label === "allowlist")
        assert(typeof record.reason === "string" && record.reason.trim().length >= 20, "unreadable reason");
      else
        assert.equal(
          record.id,
          `${record.file}:${record.line}:${record.kind}:${record.table}`,
          "inconsistent inventory identity",
        );
    }
  }
  return entries.map((entry) => ({ entry, matched: rows.some((row) => row.id === entry.id) }));
}

function assertMigration(original, before, sidecars, after) {
  const entries = JSON.parse(original);
  partitionBaseline(original, JSON.stringify(before.rows));
  const strip = ({ id, file, line, kind, table, classification }) => ({ id, file, line, kind, table, classification });
  assert.deepEqual(after.rows.map(strip), before.rows.map(strip), "row parity");
  const accounted = sidecars.map(({ file, entry }) => {
    const matches = after.rows.filter(
      (row) => row.file === file && JSON.stringify(row.binding) === JSON.stringify(entry.binding),
    );
    assert.equal(matches.length, 1, "binding cardinality");
    assert.equal(matches[0].classification, entry.classification, "classification parity");
    return { id: matches[0].id, reason: entry.reason };
  });
  assert.deepEqual(
    accounted.sort((a, b) => a.id.localeCompare(b.id)),
    entries.sort((a, b) => a.id.localeCompare(b.id)),
    "base membership and justification parity",
  );
  assert.equal(after.violations.length, before.violations.length, "diagnostic parity");
  for (const row of before.rows.filter((row) => row.classification === "key-only lost-update risk"))
    assert(
      after.violations.some((line) => line.startsWith(`${row.id}: key-only `)),
      `missing risk diagnostic ${row.id}`,
    );
}
