import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateResponsiveEvidenceGuard } from "./responsive-evidence-guard.mjs";

const roots = [];
const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
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

  it("rejects a gap-above measurement without relativeToSelector", async () => {
    const root = await fixture(`
      test("${designatedTitle}", async ({ page }, testInfo) => {
        await captureResponsiveEvidence({ page, testInfo, claimId: "scope-cards-mobile" });
      });
    `);
    const manifestFile = path.join(root, "infrastructure/playwright-evidence/responsive-evidence-manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.claims[0].measurements[0].property = "gap-above";
    await writeFile(manifestFile, JSON.stringify(manifest), "utf8");

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toContainEqual(expect.stringContaining("requires relativeToSelector for 'gap-above'"));
  });

  it("rejects relativeToSelector set on a property that does not use it", async () => {
    const root = await fixture(`
      test("${designatedTitle}", async ({ page }, testInfo) => {
        await captureResponsiveEvidence({ page, testInfo, claimId: "scope-cards-mobile" });
      });
    `);
    const manifestFile = path.join(root, "infrastructure/playwright-evidence/responsive-evidence-manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.claims[0].measurements[0].relativeToSelector = "[data-evidence-dock]";
    await writeFile(manifestFile, JSON.stringify(manifest), "utf8");

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toContainEqual(
      expect.stringContaining("sets relativeToSelector for a property that does not use it"),
    );
  });

  it("rejects a css-custom-property measurement without customProperty", async () => {
    const root = await fixture(`
      test("${designatedTitle}", async ({ page }, testInfo) => {
        await captureResponsiveEvidence({ page, testInfo, claimId: "scope-cards-mobile" });
      });
    `);
    const manifestFile = path.join(root, "infrastructure/playwright-evidence/responsive-evidence-manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.claims[0].measurements[0].property = "css-custom-property";
    await writeFile(manifestFile, JSON.stringify(manifest), "utf8");

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toContainEqual(
      expect.stringContaining("requires customProperty for 'css-custom-property'"),
    );
  });
});

describe("responsive evidence real-tree reviewer mutations", () => {
  it("rejects a claim omitted from the manifest while its capture remains", async () => {
    const root = await realFixture();
    await mutateManifest(root, (manifest) => {
      manifest.claims = manifest.claims.filter((claim) => claim.id !== "fixture-scope-cards-mobile");
    });

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toEqual([
      expect.stringContaining(
        "claim 'fixture-scope-cards-mobile' must have exactly one source-manifest claim (found 0)",
      ),
    ]);
  });

  it("rejects disabled test registration for a real claim", async () => {
    const root = await realFixture();
    await mutateFile(root, "deployables/marketplace/e2e/responsive-evidence-contract.spec.ts", (source) =>
      source.replace(
        'test("records exact mobile card evidence at 390px @marketplace-browse"',
        'test.skip("records exact mobile card evidence at 390px @marketplace-browse"',
      ),
    );

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toContainEqual(expect.stringContaining("must use an active test(...) registration"));
  });

  it("rejects weakening the real 44px assertion to 1", async () => {
    const root = await realFixture();
    await mutateManifest(root, (manifest) => {
      const claim = manifest.claims.find((candidate) => candidate.id === "fixture-scope-cards-mobile");
      const measurement = claim.measurements.find((candidate) => candidate.property === "height");
      measurement.assertion = { minimum: 1 };
    });

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toContainEqual(expect.stringContaining("independently guarantee the 44px minimum"));
  });

  it("rejects capture hidden behind locator all length", async () => {
    const root = await realFixture();
    await mutateFile(root, "deployables/marketplace/e2e/responsive-evidence-contract.spec.ts", (source) =>
      source.replace(
        '    await captureResponsiveEvidence({ page, testInfo, claimId: "fixture-scope-cards-mobile" });',
        `    if ((await page.locator("body").all()).length) {
      await captureResponsiveEvidence({ page, testInfo, claimId: "fixture-scope-cards-mobile" });
    }`,
      ),
    );

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toContainEqual(expect.stringContaining("may not condition capture"));
  });

  it("rejects a local no-op substituted for the canonical helper", async () => {
    const root = await realFixture();
    await mutateFile(root, "deployables/marketplace/e2e/responsive-evidence-contract.spec.ts", (source) =>
      source
        .replace(
          "import { captureResponsiveEvidence, responsiveEvidenceArtifactPaths } from",
          "import { responsiveEvidenceArtifactPaths } from",
        )
        .replace(
          'test.describe("responsive evidence fail-closed contract"',
          'const captureResponsiveEvidence = async (_input: unknown) => {};\n\ntest.describe("responsive evidence fail-closed contract"',
        ),
    );

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toContainEqual(expect.stringContaining("must call the canonical"));
    expect(result.violations).toContainEqual(expect.stringContaining("locally shadowed or substituted"));
  });

  it("rejects duplicate route fixture viewport target identity under another claim and artifact", async () => {
    const root = await realFixture();
    await mutateManifest(root, (manifest) => {
      const duplicate = structuredClone(
        manifest.claims.find((candidate) => candidate.id === "fixture-scope-cards-mobile"),
      );
      duplicate.id = "fixture-scope-cards-mobile-copy";
      duplicate.artifact = "fixture-scope-cards-mobile-copy";
      manifest.claims.push(duplicate);
    });

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toContainEqual(
      expect.stringContaining("duplicates route+fixture+viewport+target identity"),
    );
  });

  it("rejects a top-level unknown source-manifest field", async () => {
    const root = await realFixture();
    await mutateManifest(root, (manifest) => {
      manifest.unknown = true;
    });

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toContainEqual(expect.stringContaining("closed object"));
  });

  it("rejects a nested unknown source-manifest field", async () => {
    const root = await realFixture();
    await mutateManifest(root, (manifest) => {
      manifest.claims[0].target.unknown = true;
    });

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toContainEqual(expect.stringContaining("every nested object must use the closed schema"));
  });

  it.each([
    ["package alias", 'import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";'],
    [
      "direct infrastructure path",
      'import { captureResponsiveEvidence } from "../../../../infrastructure/playwright-evidence/index.ts";',
    ],
  ])("rejects %s imports from a deployable runtime route", async (_label, source) => {
    const root = await realFixture();
    await write(
      root,
      "deployables/admin-web/app/routes/review-probe.tsx",
      `${source}\nexport default function Route() {}`,
    );

    const result = await validateResponsiveEvidenceGuard({ repoRoot: root });

    expect(result.violations).toContainEqual(expect.stringContaining("runtime source may not import"));
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

async function realFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "responsive-evidence-real-"));
  roots.push(root);
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, "infrastructure/playwright-evidence/responsive-evidence-manifest.json"), "utf8"),
  );
  const files = [
    "infrastructure/playwright-evidence/responsive-evidence-manifest.json",
    ...new Set(manifest.claims.map((claim) => claim.file)),
  ];
  for (const relativeFile of files) {
    const target = path.join(root, relativeFile);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(repoRoot, relativeFile), target);
  }
  return root;
}

async function mutateManifest(root, callback) {
  const relativeFile = "infrastructure/playwright-evidence/responsive-evidence-manifest.json";
  const file = path.join(root, relativeFile);
  const manifest = JSON.parse(await readFile(file, "utf8"));
  callback(manifest);
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function mutateFile(root, relativeFile, callback) {
  const file = path.join(root, relativeFile);
  await writeFile(file, callback(await readFile(file, "utf8")), "utf8");
}
