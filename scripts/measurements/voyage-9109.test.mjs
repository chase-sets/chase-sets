import assert from "node:assert/strict";
import { test } from "vitest";
import { createBudget, distribution, PIN, ATTEMPTS } from "./voyage-9109.mjs";
test("fixed measurement identity", () => {
  assert.equal(PIN, "5177c88d76eceab88ebcb9b21a1088664ef1ff66");
  assert.equal(ATTEMPTS, 30);
});
test("budget charges attempts before execution and refuses overflow", () => {
  const budget = createBudget({ rate: 1, otherCosts: 19.95 });
  budget.reserve(["charizard"]);
  assert.throws(() => budget.reserve(["charizard"]), /Budget exhausted/);
  assert.ok(budget.summary().estimatedUpperUsd <= 20);
});
test("Full model context reserved for every input", () => {
  const budget = createBudget({ rate: 1, otherCosts: 1 });
  budget.reserve(["é", "x"]);
  assert.equal(budget.summary().reservedTokens, 64000);
});
test("invalid pricing cannot run", () => {
  for (const rate of [0, -1, NaN, Infinity, 101]) assert.throws(() => createBudget({ rate, otherCosts: 1 }));
  for (const otherCosts of [-1, NaN, Infinity, 20]) assert.throws(() => createBudget({ rate: 1, otherCosts }));
});
test("nearest rank percentiles include all provided outcomes", () => {
  assert.deepEqual(distribution([]), { count: 0, p50Ms: null, p95Ms: null });
  assert.deepEqual(distribution([{ ms: 900 }, { ms: 10 }, { ms: 50 }]), { count: 3, p50Ms: 50, p95Ms: 900 });
});
import { spawnSync } from "node:child_process";
test("CLI fails closed without operator approval, before loading credentials", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("./voyage-9109.mjs", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")],
    { env: {}, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Measurement stopped/);
});
