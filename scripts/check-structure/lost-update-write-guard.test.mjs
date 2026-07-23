import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateLostUpdateWriteGuard } from "./lost-update-write-guard.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("lost update write guard", () => {
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
