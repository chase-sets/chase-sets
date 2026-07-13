import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicHelpArticles } from "./article-catalog";

const launchCriticalArticles = [
  "frequently-asked-questions",
  "order-protection",
  "refunds-and-returns",
  "sales-fees",
] as const;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

describe.each(launchCriticalArticles)("%s public promise gate", (slug) => {
  const article = publicHelpArticles.find((candidate) => candidate.slug === slug && candidate.locale === "en");

  it("maps every published behavioral promise to a committed enforcing test", () => {
    expect(article, `${slug}.en.md must remain in the launch-critical corpus`).toBeDefined();
    expect(article!.promiseTable.length).toBeGreaterThan(0);

    for (const promise of article!.promiseTable) {
      expect(promise.claim).not.toMatch(/\b(?:planned|intended|expected)\b/i);
      expect(promise.tests.length, `${slug}: ${promise.claim}`).toBeGreaterThan(0);

      for (const testPath of promise.tests) {
        const absoluteTestPath = resolve(repoRoot, testPath);
        expect(existsSync(absoluteTestPath), `${promise.claim} -> ${testPath}`).toBe(true);
        expect(readFileSync(absoluteTestPath, "utf8"), `${testPath} must contain executable assertions`).toMatch(
          /\b(?:it|test)\s*\(/,
        );
      }
    }
  });
});
