import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateLostUpdateWriteGuard } from "./lost-update-write-guard.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("lost update write guard", () => {
  it("fails the pre-fix expiry-sweep shape (negative control)", async () => {
    const root = await fixture(`UPDATE pricing_market_price_estimates SET fresh_until = $2 WHERE estimate_id = $1`);
    await expect(validateLostUpdateWriteGuard({ repoRoot: root })).resolves.toMatchObject({
      violations: [expect.stringContaining("key-only UPDATE")],
    });
  });
  it("accepts a predicate proving the read state is still current", async () => {
    const root = await fixture(
      `UPDATE pricing_market_price_estimates SET fresh_until = $2 WHERE estimate_id = $1 AND fresh_until = $3`,
    );
    await expect(validateLostUpdateWriteGuard({ repoRoot: root })).resolves.toEqual(
      expect.objectContaining({ violations: [] }),
    );
  });
});

async function fixture(sql) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lost-update-guard-"));
  roots.push(root);
  const target = path.join(root, "bounded-contexts/example/features/estimates/read-model/sweep.ts");
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(path.join(root, "scripts/check-structure"), { recursive: true });
  await writeFile(target, `const sql = \`${sql}\`;`, "utf8");
  await writeFile(path.join(root, "scripts/check-structure/lost-update-write-guard-allowlist.json"), "[]", "utf8");
  return root;
}
