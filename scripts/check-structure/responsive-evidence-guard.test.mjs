import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateResponsiveEvidenceGuard } from "./responsive-evidence-guard.mjs";

const roots = [];
const designatedFile = "deployables/admin-web/e2e/responsive.spec.ts";
const designatedTitle = "responsive claim";

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("responsive evidence structural guard", () => {
  it("accepts a manifest-designated claim that uses the shared contract", async () => {
    const root = await fixture(`
      test("${designatedTitle}", async ({ page }, testInfo) => {
        await captureResponsiveEvidence({ page, testInfo, claimId: "scope-cards-mobile" });
      });
    `);

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toEqual([]);
    expect(result.hits).toEqual([expect.objectContaining({ id: "scope-cards-mobile", contractCalls: 1 })]);
  });

  it("rejects the exact optional count gate around designated evidence", async () => {
    const root = await fixture(`
      test("${designatedTitle}", async ({ page }, testInfo) => {
        const target = page.getByRole("table", { name: "Scopes" });
        if (await target.count()) {
          await captureResponsiveEvidence({ page, testInfo, claimId: "scope-cards-mobile" });
        }
      });
    `);

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toEqual([
      expect.stringContaining("may not condition capture on locator count/visibility"),
    ]);
  });

  it("rejects a catch-and-log replacement for the target assertion", async () => {
    const root = await fixture(`
      test("${designatedTitle}", async ({ page }, testInfo) => {
        const target = page.getByRole("table", { name: "Scopes" });
        try {
          await expect(target).toBeVisible();
        } catch (error) {
          console.log(error);
        }
        await captureResponsiveEvidence({ page, testInfo, claimId: "scope-cards-mobile" });
      });
    `);

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toEqual([expect.stringContaining("may not catch-and-log a target assertion or capture")]);
  });

  it("rejects a promise catch-and-log replacement for the target assertion", async () => {
    const root = await fixture(`
      test("${designatedTitle}", async ({ page }, testInfo) => {
        const target = page.getByRole("table", { name: "Scopes" });
        await expect(target).toBeVisible().catch((error) => console.log(error));
        await captureResponsiveEvidence({ page, testInfo, claimId: "scope-cards-mobile" });
      });
    `);

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toEqual([expect.stringContaining("may not catch-and-log a target assertion or capture")]);
  });

  it("leaves ordinary nondesignated conditional Playwright tests alone", async () => {
    const root = await fixture(`
      test("${designatedTitle}", async ({ page }, testInfo) => {
        await captureResponsiveEvidence({ page, testInfo, claimId: "scope-cards-mobile" });
      });
      test("ordinary conditional behavior", async ({ page }) => {
        const optionalPager = page.getByRole("link", { name: "Previous page" });
        if (await optionalPager.count()) {
          await expect(optionalPager).toBeVisible();
        } else {
          console.log("fixture has one page");
        }
      });
    `);

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toEqual([]);
  });

  it("requires the contract instead of a direct screenshot for designated claims", async () => {
    const root = await fixture(`
      test("${designatedTitle}", async ({ page }) => {
        await expect(page.getByRole("table", { name: "Scopes" })).toBeVisible();
        await page.screenshot({ path: "scopes.png" });
      });
    `);

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toEqual([
      expect.stringContaining("must call captureResponsiveEvidence exactly once"),
      expect.stringContaining("may not call screenshot directly"),
    ]);
  });

  it("rejects a manifest measurement without an executable assertion", async () => {
    const root = await fixture(`
      test("${designatedTitle}", async ({ page }, testInfo) => {
        await captureResponsiveEvidence({ page, testInfo, claimId: "scope-cards-mobile" });
      });
    `);
    const manifestFile = path.join(root, "infrastructure/playwright-evidence/responsive-evidence-manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.claims[0].measurements[0].assertion = {};
    await writeFile(manifestFile, JSON.stringify(manifest), "utf8");

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toEqual([expect.stringContaining("requires an equality or bound assertion")]);
  });
});

async function fixture(testBody) {
  const root = await mkdtemp(path.join(os.tmpdir(), "responsive-evidence-guard-"));
  roots.push(root);
  await write(
    root,
    "infrastructure/playwright-evidence/responsive-evidence-manifest.json",
    JSON.stringify({
      contract: "fail-closed-responsive-evidence",
      schemaVersion: 1,
      claims: [
        {
          kind: "claim",
          id: "scope-cards-mobile",
          file: designatedFile,
          testTitle: designatedTitle,
          route: { name: "scope list", path: "/catalog/scopes" },
          fixture: { identity: "scope-fixture" },
          viewport: { width: 390, height: 844 },
          target: {
            identity: "scope cards",
            selector: "main [role='list']",
            populatedSelector: ":scope > [role='listitem']",
          },
          measurements: [
            {
              identity: "width",
              scope: "target",
              selector: ":scope",
              property: "width",
              assertion: { maximum: 390 },
            },
          ],
          artifact: "scope-cards-mobile",
        },
      ],
    }),
  );
  await write(
    root,
    designatedFile,
    `
      import { expect, test } from "@playwright/test";
      import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
      ${testBody}
    `,
  );
  return root;
}

async function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}
