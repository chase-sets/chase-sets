import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
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
