import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateRealClockElapsedBounds } from "./real-clock-elapsed-bounds.mjs";

const allowlistPath = "scripts/check-structure/real-clock-elapsed-bounds-allowlist.json";
const base = "anywhere/not-a-workspace";
const roots = [];
let log;

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  log.mockRestore();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const detectionFixtures = {
  "direct.test.ts": {
    id: "test:direct subtraction::1::1",
    source: `
it("direct subtraction", async () => {
  const startedAt = performance.now();
  await work();
  expect(performance.now() - startedAt).toBeLessThan(250);
});`,
  },
  "const-hop.test.ts": {
    id: "test:const hop::1::1",
    source: `
it("const hop", () => {
  const startedAt = Date.now();
  const elapsed = Date.now() - startedAt;
  expect(elapsed).toBeLessThanOrEqual(100);
});`,
  },
  "two-hop.test.ts": {
    id: "test:two-hop chain::1::1",
    source: `
it("two-hop chain", () => {
  const startedAt = process.hrtime.bigint();
  const finishedAt = process.hrtime.bigint();
  const elapsed = finishedAt - startedAt;
  const elapsedMs = Number(elapsed) / 1e6;
  expect(elapsedMs).toBeLessThan(50);
});`,
  },
  "let-reassignment.test.ts": {
    id: "test:let reassignment::1::1",
    source: `
it("let reassignment", async () => {
  const startedAt = new Date().getTime();
  let elapsed = 0;
  await work();
  elapsed = new Date().getTime() - startedAt;
  expect(elapsed).toBeLessThan(50);
});`,
  },
  "soft.test.ts": {
    id: "test:soft with message::1::1",
    source: `
it("soft with message", () => {
  expect.soft(performance.now() - startedAt, "fast path").toBeLessThan(10);
});`,
  },
  "not-greater.test.ts": {
    id: "test:negated greater::1::1",
    source: `
it("negated greater", () => {
  expect(Date.now() - startedAt).not.toBeGreaterThan(1_000);
});`,
  },
  "reversed.test.ts": {
    id: "test:reversed greater::1::1",
    source: `
it("reversed greater", () => {
  expect(1_000).toBeGreaterThanOrEqual(performance.now() - startedAt);
});`,
  },
  "assert-ok.test.mjs": {
    id: "test:assert ok::1::1",
    source: `
import assert from "node:assert/strict";
test("assert ok", () => {
  const startedAt = performance.now();
  assert.ok(performance.now() - startedAt < 500);
});`,
  },
  "assert-mirrored.spec.cjs": {
    id: "test:assert mirrored::1::1",
    source: `
const assert = require("node:assert");
test("assert mirrored", () => {
  assert(500 >= Date.now() - startedAt);
});`,
  },
  "render-budget.test.tsx": {
    id: "test:renders within a frame::1::1",
    source: `
it("renders within a frame", () => {
  const startedAt = performance.now();
  render(<Grid rows={rows} elapsed={performance.now()} />);
  expect(performance.now() - startedAt).toBeLessThan(16);
});`,
  },
  "shadowed.test.ts": {
    id: "test:outer binding::1::1",
    source: `
const elapsed = performance.now() - moduleStartedAt;
function checkParameter(elapsed: number) {
  expect(elapsed).toBeLessThan(10);
}
it("shadowed binding", () => {
  const elapsed = 5;
  expect(elapsed).toBeLessThan(10);
  {
    let elapsed = 1;
    elapsed = 2;
    expect(elapsed).toBeLessThan(10);
  }
});
it("outer binding", () => {
  expect(elapsed).toBeLessThan(10);
});`,
  },
  "cycle.test.ts": {
    id: "test:reassignment cycle::1::1",
    source: `
it("reassignment cycle", () => {
  let a = performance.now() - startedAt;
  let b = a;
  a = b;
  b = a;
  expect(b).toBeLessThan(10);
  let c = 0;
  let d = c;
  c = d;
  d = c;
  expect(c).toBeLessThan(10);
});`,
  },
  "template-title.test.ts": {
    id: "test:[shard ${shard + 1}/${CAPABILITY_SHARDS}] stays fast::1::1",
    source: `
it(\`[shard \${shard + 1}/\${CAPABILITY_SHARDS}] stays fast\`, () => {
  expect(performance.now() - startedAt).toBeLessThan(5);
});`,
  },
  "duplicate-second.test.ts": {
    id: "test:x::2::1",
    source: `
it("x", () => {
  expect(performance.now() - startedAt).toBeGreaterThan(5);
});
it("x", () => {
  expect(performance.now() - startedAt).toBeLessThan(5);
});
it("x#2", () => {
  expect(1).toBe(1);
});`,
  },
  "duplicate-hash.test.ts": {
    id: "test:x#2::1::1",
    source: `
it("x", () => {
  expect(1).toBe(1);
});
it(\`x\`, () => {
  expect(1).toBe(1);
});
it("x#2", () => {
  expect(performance.now() - startedAt).toBeLessThan(5);
});`,
  },
  "nested-playwright.spec.ts": {
    id: "test:inside a step::1::1",
    source: `
test.describe("suite", () => {
  test.beforeEach(async () => {});
  test("inside a step", async () => {
    await test.step("measure", async () => {
      const startedAt = Date.now();
      expect(Date.now() - startedAt).toBeLessThan(5);
    });
  });
});`,
  },
  "function-scope.test.ts": {
    id: "function:assertWithinBudget::1::1",
    source: `
function assertWithinBudget(startedAt: number) {
  expect(performance.now() - startedAt).toBeLessThan(5);
}
it("uses the helper", () => {
  assertWithinBudget(performance.now());
});`,
  },
  "arrow-function-scope.test.ts": {
    id: "function:assertFast::1::1",
    source: `
const assertFast = (startedAt: number) => {
  expect(Date.now() - startedAt).toBeLessThan(5);
};`,
  },
  "module-scope.spec.mts": {
    id: "module:::1::1",
    source: `
const startedAt = Date.now();
await setup();
expect(Date.now() - startedAt).toBeLessThan(100);`,
  },
  "comment-performance.test.ts": {
    id: "test:comment-separated performance::1::1",
    source: `
it("comment-separated performance", () => {
  expect(performance /* clock */.now() - startedAt).toBeLessThan(5);
});`,
  },
  "comment-date.test.ts": {
    id: "test:line-comment-separated Date::1::1",
    source: `
it("line-comment-separated Date", () => {
  expect(Date // clock
    .now() - startedAt).toBeLessThan(5);
});`,
  },
  "comment-hrtime.test.ts": {
    id: "test:comment-separated hrtime::1::1",
    source: `
it("comment-separated hrtime", () => {
  expect(process/* clock */.hrtime() - startedAt).toBeLessThan(5);
});`,
  },
  "comment-hrtime-bigint.test.ts": {
    id: "test:comment-separated hrtime bigint::1::1",
    source: `
it("comment-separated hrtime bigint", () => {
  expect(process/* clock */.hrtime.bigint() - startedAt).toBeLessThan(5n);
});`,
  },
  "comment-get-time.test.ts": {
    id: "test:comment-separated getTime::1::1",
    source: `
it("comment-separated getTime", () => {
  expect(new Date().getTime/* clock */() - startedAt).toBeLessThan(5);
});`,
  },
  "comment-value-of.test.ts": {
    id: "test:comment-separated valueOf::1::1",
    source: `
it("comment-separated valueOf", () => {
  expect(new Date()./* clock */valueOf() - startedAt).toBeLessThan(5);
});`,
  },
  "escaped-identifier.test.ts": {
    id: "test:escaped identifier after a regular expression::1::1",
    source: `
it("escaped identifier after a regular expression", () => {
  expect(name).toMatch(/[/*]/);
  expect(\\u0070erformance.now() - startedAt).toBeLessThan(5); /* scanned as code */
});`,
  },
  "jsx-text.test.jsx": {
    id: "test:after JSX text::1::1",
    source: `
it("after JSX text", () => {
  render(<a>http://example.test</a>); expect(performance.now() - startedAt).toBeLessThan(5);
});`,
  },
  "escaped-after-jsx-text.test.jsx": {
    id: "test:escaped clock after JSX URL text::1::1",
    source: `
it("escaped clock after JSX URL text", () => {
  render(<a>http://example.test</a>); expect(\\u0070erformance.now() - startedAt).toBeLessThan(5);
});`,
  },
  "escaped-after-if-regex.test.ts": {
    id: "test:escaped clock after a regular expression following if::1::1",
    source: `
it("escaped clock after a regular expression following if", () => {
  if (enabled) /[//]/.test(value); expect(\\u0044ate.now() - startedAt).toBeLessThan(5);
});`,
  },
  "escaped-after-block-regex.test.ts": {
    id: "test:escaped clock after a regular expression following a block::1::1",
    source: `
it("escaped clock after a regular expression following a block", () => {
  if (enabled) {} /[//]/.test(value); expect(proce\\u{73}s.hrtime() - startedAt).toBeLessThan(5);
});`,
  },
};

const escapedTextControls = `
it("escapes outside code", () => {
  // expect(\\u0070erformance.now() - startedAt).toBeLessThan(5);
  const quoted = "expect(\\u0044ate.now() - startedAt).toBeLessThan(5)";
  const pattern = /proce\\u0073s\\.hrtime\\(\\) - startedAt/;
  render(<a>expect(\\u0070erformance.now() - startedAt).toBeLessThan(5)</a>);
  expect(quoted.length - pattern.source.length).toBeLessThan(500);
});`;

const cleanControls = `
import assert from "node:assert/strict";

function measure() {
  return performance.now() - startedAt;
}

it("lower bounds", () => {
  const elapsed = performance.now() - startedAt;
  expect(elapsed).toBeGreaterThanOrEqual(100);
  expect(elapsed).not.toBeLessThan(5);
  expect(5).toBeLessThan(elapsed);
  expect(5).not.toBeGreaterThan(elapsed);
  assert(elapsed > 10);
  assert.ok(10 <= elapsed);
});

it("negated less-than on the argument is outside the listed forms", () => {
  const elapsed = new Date().valueOf() - startedAt;
  expect(1_000).not.toBeLessThan(elapsed);
  expect(1_000).not.toBeLessThanOrEqual(new Date().valueOf() - startedAt);
});

it("timestamp ordering", () => {
  const t = Date.now();
  expect(t).toBeLessThanOrEqual(Date.now());
  expect(record.createdAt).toBeLessThanOrEqual(Date.now());
  expect(Date.now()).toBeGreaterThanOrEqual(t);
  assert.ok(t <= Date.now());
});

it("constants", () => {
  expect(10 - 3).toBeLessThan(10);
  const budget = 500 - 100;
  expect(budget).toBeLessThan(1_000);
  assert(budget - 1 < 1_000);
});

it("property access and helper return values", async () => {
  const result = { elapsed: performance.now() - startedAt };
  expect(result.elapsed).toBeLessThan(100);
  const samples = [performance.now() - startedAt];
  expect(samples[0]).toBeLessThan(100);
  const measured = measure();
  expect(measured).toBeLessThan(100);
  const measureArrow = () => performance.now() - startedAt;
  expect(measureArrow()).toBeLessThan(100);
  const { elapsed } = { elapsed: Date.now() - startedAt };
  expect(elapsed).toBeLessThan(100);
  const launch = await runLaunch();
  expect(launch.elapsedMs).toBeLessThan(100);
  expect(Date.parse(finishedAt) - Date.parse(startedAt)).toBeLessThan(1_000);
});

it("informational log", () => {
  const elapsed = Date.now() - startedAt;
  console.log(\`took \${performance.now() - startedAt}ms\`);
  console.info("elapsed", elapsed);
});

it("liveness race", { timeout: 1_000 }, async () => {
  await Promise.race([
    work(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 5_000)),
  ]);
  while (Date.now() - startedAt < 5_000) {
    if (await ready()) break;
  }
});
`;

describe("real-clock elapsed bounds guard", () => {
  it("flags every upper bound on a real-clock elapsed quantity", async () => {
    const files = Object.fromEntries(
      Object.entries(detectionFixtures).map(([name, fixture]) => [`${base}/${name}`, fixture.source]),
    );
    const root = await fixtureRepo({
      ...files,
      [`${base}/helpers.ts`]: `expect(performance.now() - startedAt).toBeLessThan(5);`,
      [`${base}/notes.test.md`]: `expect(performance.now() - startedAt).toBeLessThan(5);`,
    });
    const result = await validateRealClockElapsedBounds({ repoRoot: root, allowlistPath });

    const idsByFile = new Map();
    for (const row of result.rows) idsByFile.set(row.file, [...(idsByFile.get(row.file) ?? []), row.id]);
    for (const [name, fixture] of Object.entries(detectionFixtures)) {
      expect(idsByFile.get(`${base}/${name}`), name).toEqual([`${base}/${name}::${fixture.id}`]);
    }
    expect(result.rows).toHaveLength(Object.keys(detectionFixtures).length);
    expect(result.violations.map((violation) => violation.split(": real-clock elapsed upper bound")[0]).sort()).toEqual(
      Object.entries(detectionFixtures)
        .map(([name, fixture]) => `${base}/${name}::${fixture.id}`)
        .sort(),
    );
    expect(result.total).toBe(Object.keys(detectionFixtures).length);
    expect(result.scanned).toBe(Object.keys(detectionFixtures).length);
  });

  it("numbers ordinals within one scope and ignores untracked or token-free test files", async () => {
    const root = await fixtureRepo({
      [`${base}/ordinals.test.ts`]: `
it("t", () => {
  expect(performance.now() - startedAt).toBeLessThan(5);
  expect(1).toBe(1);
  expect(Date.now() - startedAt).toBeLessThan(5);
});
expect(Date.now() - startedAt).toBeLessThan(5);`,
      [`${base}/token-free.test.ts`]: `it("t", () => { expect(1).toBeLessThan(2); });`,
    });
    await writeFile(
      path.join(root, `${base}/untracked.test.ts`),
      `it("u", () => { expect(performance.now() - startedAt).toBeLessThan(5); });`,
    );
    const result = await validateRealClockElapsedBounds({ repoRoot: root, allowlistPath });
    expect(result.rows.map((row) => row.id)).toEqual([
      `${base}/ordinals.test.ts::test:t::1::1`,
      `${base}/ordinals.test.ts::test:t::1::2`,
      `${base}/ordinals.test.ts::module:::1::1`,
    ]);
    expect({ scanned: result.scanned, total: result.total }).toEqual({ scanned: 1, total: 2 });
  });

  it("ignores lower bounds, timestamp ordering, constants, logs, liveness races and escapes outside code", async () => {
    const root = await fixtureRepo({
      [`${base}/controls.test.ts`]: cleanControls,
      [`${base}/controls.spec.mjs`]: cleanControls.replace(/: number/g, ""),
      [`${base}/escaped-text.test.jsx`]: escapedTextControls,
    });
    const result = await validateRealClockElapsedBounds({ repoRoot: root, allowlistPath });
    expect(result).toMatchObject({ violations: [], rows: [], scanned: 3, total: 3 });
  });

  it("rejects stale, duplicate and unjustified allowlist entries", async () => {
    const flagged = `it("allowlisted", () => { expect(performance.now() - startedAt).toBeLessThan(5); });`;
    const justified = "Hosted strict budget owned by the script-budget issue.";
    const id = `${base}/allowed.test.ts::test:allowlisted::1::1`;
    const files = { [`${base}/allowed.test.ts`]: flagged, [`${base}/also.test.ts`]: flagged };
    const alsoId = `${base}/also.test.ts::test:allowlisted::1::1`;

    const allowed = await fixtureRepo(files, [
      { id, reason: justified },
      { id: alsoId, reason: justified },
    ]);
    const passing = await validateRealClockElapsedBounds({ repoRoot: allowed, allowlistPath });
    expect(passing.violations).toEqual([]);
    expect(passing.rows.map((row) => row.classification)).toEqual(["allowlisted", "allowlisted"]);
    expect(log).toHaveBeenCalledWith("real-clock elapsed bounds: 2/2 test files scanned, 2 allowlisted");

    const ratchet = await fixtureRepo(files, [
      { id, reason: justified },
      { id, reason: justified },
      { id: alsoId, reason: "too short" },
      { id: `${base}/gone.test.ts::test:removed::1::1`, reason: justified },
    ]);
    const failing = await validateRealClockElapsedBounds({ repoRoot: ratchet, allowlistPath });
    expect(failing.violations).toEqual([
      `${allowlistPath}: duplicate allowlist entry '${id}'.`,
      `${allowlistPath}: '${alsoId}' needs a one-line justification of at least 20 characters.`,
      `${allowlistPath}: stale allowlist entry '${base}/gone.test.ts::test:removed::1::1'.`,
    ]);
  });

  it("rejects the historical freshness-wait bound at its real path while a real allowlisted site passes", async () => {
    const mutantFile = "infrastructure/bounded-context-runtime/projection-freshness-wait.test.ts";
    const allowedFile = "scripts/dev-system-launch.test.mjs";
    const anchor = "    const outcome = await wait;\n";
    const original = (await readFile(mutantFile, "utf8")).replaceAll("\r\n", "\n");
    expect(original).toContain(anchor);
    const mutant = original.replace(anchor, `${anchor}    expect(performance.now() - startedAt).toBeLessThan(250);\n`);
    const realAllowlist = JSON.parse(await readFile(allowlistPath, "utf8"));
    const allowedEntries = realAllowlist.filter((entry) => entry.id.startsWith(`${allowedFile}::`));
    expect(allowedEntries.length).toBeGreaterThan(0);

    const root = await fixtureRepo(
      { [mutantFile]: original, [allowedFile]: await readFile(allowedFile, "utf8") },
      allowedEntries,
    );
    await expect(validateRealClockElapsedBounds({ repoRoot: root, allowlistPath })).resolves.toMatchObject({
      violations: [],
    });

    await writeFile(path.join(root, mutantFile), mutant);
    const result = await validateRealClockElapsedBounds({ repoRoot: root, allowlistPath });
    expect(result.violations).toEqual([
      expect.stringContaining(
        `${mutantFile}::test:rechecks freshness immediately when checkpoint readiness is notified before the poll interval::1::1: real-clock elapsed upper bound`,
      ),
    ]);
  });
});

async function fixtureRepo(files, allowlist = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "real-clock-elapsed-bounds-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), content, "utf8");
  }
  await mkdir(path.join(root, path.dirname(allowlistPath)), { recursive: true });
  await writeFile(path.join(root, allowlistPath), JSON.stringify(allowlist), "utf8");
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "add", "-A"]);
  return root;
}
