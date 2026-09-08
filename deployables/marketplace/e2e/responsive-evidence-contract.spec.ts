import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { captureResponsiveEvidence, responsiveEvidenceArtifactPaths } from "@chase-sets/playwright-evidence";

const POPULATION_CONTROL_ROW_COUNT = 2_049;
const POPULATION_CONTROL_LATE_INDEX = 2_048;

test.describe("responsive evidence fail-closed contract", () => {
  test("fails before capture when the exact accordion target is hidden @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await serveFixture(
      page,
      "/responsive-evidence/hidden-accordion",
      fixtureDocument(`
        <button aria-expanded="false">Responsive layout</button>
        <section hidden>
          <div data-evidence-target="changed-grid">
            <article data-evidence-row>Changed row</article>
          </div>
        </section>
      `),
    );

    await expect(captureResponsiveEvidence({ page, testInfo, claimId: "hidden-accordion-target" })).rejects.toThrow(
      /route=hidden accordion fixture:\/responsive-evidence\/hidden-accordion viewport=390x844 target=changed-grid-inside-accordion .*reason=target-hidden-or-collapsed/,
    );
    expectResponsiveEvidenceArtifactsAbsent(testInfo, "hidden-accordion-target");
  });

  test("fails before capture when the exact table is empty despite an unrelated list item @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await serveFixture(
      page,
      "/responsive-evidence/empty-table",
      fixtureDocument(`
        <table data-evidence-target="scope-table">
          <thead><tr><th>Scope</th></tr></thead>
          <tbody></tbody>
        </table>
        <ul><li>Unrelated visible item</li></ul>
      `),
    );

    await expect(
      captureResponsiveEvidence({ page, testInfo, claimId: "zero-table-unrelated-list-item" }),
    ).rejects.toThrow(
      /route=empty scoped table fixture:\/responsive-evidence\/empty-table viewport=820x900 target=scoped-catalog-table .*reason=target-population-empty/,
    );
    expectResponsiveEvidenceArtifactsAbsent(testInfo, "zero-table-unrelated-list-item");
  });

  // #5963 AC12: the three measurement properties added for the compact mobile
  // action dock (gap-above, scroll-margin-bottom, css-custom-property) are
  // additive to the closed-schema, fail-closed contract. Each gets its own
  // negative control proving it fails closed rather than silently passing.
  test("fails before capture when the gap-above reference element is absent @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await serveFixture(
      page,
      "/responsive-evidence/gap-above-missing-reference",
      fixtureDocument(`
        <div data-evidence-target="gap-target">
          <article data-evidence-row>Row</article>
        </div>
      `),
    );

    await expect(captureResponsiveEvidence({ page, testInfo, claimId: "gap-above-missing-reference" })).rejects.toThrow(
      /route=gap-above missing reference fixture:\/responsive-evidence\/gap-above-missing-reference viewport=390x844 target=gap-above-target .*reason=measurement-relative-to-not-exact\(gap-above-missing-reference, count=0\)/,
    );
    expectResponsiveEvidenceArtifactsAbsent(testInfo, "gap-above-missing-reference");
  });

  test("fails before capture when the scroll-margin-bottom measurement target is hidden @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await serveFixture(
      page,
      "/responsive-evidence/scroll-margin-bottom-hidden-target",
      fixtureDocument(`
        <div data-evidence-target="clearance-target">
          <article data-evidence-row>Visible row</article>
          <button data-hidden-clearance-target hidden>Hidden focus control</button>
        </div>
      `),
    );

    await expect(
      captureResponsiveEvidence({ page, testInfo, claimId: "scroll-margin-bottom-hidden-target" }),
    ).rejects.toThrow(
      /route=scroll-margin-bottom hidden target fixture:\/responsive-evidence\/scroll-margin-bottom-hidden-target viewport=390x844 target=clearance-target .*reason=measurement-target-hidden\(scroll-margin-bottom-hidden-target\)/,
    );
    expectResponsiveEvidenceArtifactsAbsent(testInfo, "scroll-margin-bottom-hidden-target");
  });

  test("fails before capture when the css-custom-property observation is non-numeric @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await serveFixture(
      page,
      "/responsive-evidence/css-custom-property-non-numeric",
      fixtureDocument(`
        <style>
          [data-evidence-target="nonnumeric-target"] { --nonnumeric-test-var: not-a-number; }
        </style>
        <div data-evidence-target="nonnumeric-target">
          <article data-evidence-row>Row</article>
        </div>
      `),
    );

    await expect(
      captureResponsiveEvidence({ page, testInfo, claimId: "css-custom-property-non-numeric" }),
    ).rejects.toThrow(
      /route=css-custom-property non-numeric fixture:\/responsive-evidence\/css-custom-property-non-numeric viewport=390x844 target=nonnumeric-target .*reason=measurement-not-numeric\(css-custom-property-non-numeric, actual=not-a-number\)/,
    );
    expectResponsiveEvidenceArtifactsAbsent(testInfo, "css-custom-property-non-numeric");
  });

  // An unregistered custom property computes to its authored token, so a naive
  // Number.parseFloat turns "5.25em" into 5.25 and compares a font-relative count
  // against a pixel bound without ever failing. This control pins the fail-closed
  // behavior for every length unit the contract does not resolve: the assertion below
  // would have *passed* at 84 +/- 0.5 only if the reader silently accepted 5.25.
  test("fails before capture when the css-custom-property observation carries an unsupported length unit @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await serveFixture(
      page,
      "/responsive-evidence/css-custom-property-unsupported-unit",
      fixtureDocument(`
        <style>
          [data-evidence-target="unsupported-unit-target"] { --unsupported-unit-test-var: 5.25em; }
        </style>
        <div data-evidence-target="unsupported-unit-target">
          <article data-evidence-row>Row</article>
        </div>
      `),
    );

    await expect(
      captureResponsiveEvidence({ page, testInfo, claimId: "css-custom-property-unsupported-unit" }),
    ).rejects.toThrow(
      /route=css-custom-property unsupported unit fixture:\/responsive-evidence\/css-custom-property-unsupported-unit viewport=390x844 target=unsupported-unit-target .*reason=measurement-not-numeric\(css-custom-property-unsupported-unit, actual=5\.25em\)/,
    );
    expectResponsiveEvidenceArtifactsAbsent(testInfo, "css-custom-property-unsupported-unit");
  });

  test("fails before capture when an element-scoped label is clipped @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await serveFixture(
      page,
      "/responsive-evidence/clipped-label",
      fixtureDocument(`
        <div data-evidence-target="label-clip-target">
          <article data-evidence-row>
            <span
              data-evidence-label
              style="display:inline-block;width:20px;overflow:hidden;white-space:nowrap;"
            >A very long label text</span>
          </article>
        </div>
      `),
    );

    await expect(
      captureResponsiveEvidence({ page, testInfo, claimId: "horizontal-overflow-clipped-label" }),
    ).rejects.toThrow(
      /route=clipped label fixture:\/responsive-evidence\/clipped-label viewport=390x844 target=label-clip-target .*reason=measurement-failed\(horizontal-overflow-clipped-label, expected=\{"maximum":0\}, actual=\d+\)/,
    );
    expectResponsiveEvidenceArtifactsAbsent(testInfo, "horizontal-overflow-clipped-label");
  });

  test("records every row in a high-cardinality population @marketplace-browse", async ({ page }, testInfo) => {
    await serveFixture(
      page,
      "/responsive-evidence/population-bulk-positive",
      populationFixture({ targetIdentity: "population-bulk-positive" }),
    );

    await captureResponsiveEvidence({ page, testInfo, claimId: "population-bulk-positive" });

    const entry = await readResponsiveEvidenceManifest(testInfo, "population-bulk-positive");
    expect(entry).toMatchObject({
      claimId: "population-bulk-positive",
      route: {
        name: "high-cardinality populated target fixture",
        observed: "/responsive-evidence/population-bulk-positive",
      },
      fixture: { identity: "responsive-evidence:population-bulk-positive:v1" },
      viewport: { width: 820, height: 900 },
      target: { identity: "population-bulk-positive" },
      assertions: expect.arrayContaining([
        expect.objectContaining({ identity: "population-bulk-positive-width", actual: 820 }),
      ]),
      artifacts: {
        screenshot: expect.objectContaining({ path: expect.stringMatching(/\.png$/), sha256: expect.any(String) }),
        sourceClaimSha256: expect.any(String),
        playwrightConfig: expect.objectContaining({ path: "playwright.config.ts", sha256: expect.any(String) }),
      },
    });
  });

  test("fails before capture when a late population row is hidden @marketplace-browse", async ({ page }, testInfo) => {
    await serveFixture(
      page,
      "/responsive-evidence/population-bulk-hidden-late",
      populationFixture({
        targetIdentity: "population-bulk-hidden-late",
        hiddenIndex: POPULATION_CONTROL_LATE_INDEX,
      }),
    );

    await expect(captureResponsiveEvidence({ page, testInfo, claimId: "population-bulk-hidden-late" })).rejects.toThrow(
      new RegExp(`reason=target-population-hidden\\(index=${POPULATION_CONTROL_LATE_INDEX}\\)`),
    );
    expectResponsiveEvidenceArtifactsAbsent(testInfo, "population-bulk-hidden-late");
  });

  test("fails before capture when a late population row has zero layout @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await serveFixture(
      page,
      "/responsive-evidence/population-bulk-zero-layout-late",
      populationFixture({
        targetIdentity: "population-bulk-zero-layout-late",
        zeroLayoutIndex: POPULATION_CONTROL_LATE_INDEX,
      }),
    );

    await expect(
      captureResponsiveEvidence({ page, testInfo, claimId: "population-bulk-zero-layout-late" }),
    ).rejects.toThrow(new RegExp(`reason=target-population-hidden\\(index=${POPULATION_CONTROL_LATE_INDEX}\\)`));
    expectResponsiveEvidenceArtifactsAbsent(testInfo, "population-bulk-zero-layout-late");
  });

  test("fails before capture when a high-cardinality fixture has no matching population @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await serveFixture(
      page,
      "/responsive-evidence/population-bulk-absent",
      populationFixture({ targetIdentity: "population-bulk-absent", matchRows: false }),
    );

    await expect(captureResponsiveEvidence({ page, testInfo, claimId: "population-bulk-absent" })).rejects.toThrow(
      /reason=target-population-empty/,
    );
    expectResponsiveEvidenceArtifactsAbsent(testInfo, "population-bulk-absent");
  });

  test("records exact mobile card evidence at 390px @marketplace-browse", async ({ page }, testInfo) => {
    await serveFixture(page, "/responsive-evidence/scope-transition", responsiveTransitionFixture());

    await captureResponsiveEvidence({ page, testInfo, claimId: "fixture-scope-cards-mobile" });

    const entry = await readResponsiveEvidenceManifest(testInfo, "fixture-scope-cards-mobile");
    expect(entry).toMatchObject({
      claimId: "fixture-scope-cards-mobile",
      route: {
        name: "populated responsive scope fixture",
        observed: "/responsive-evidence/scope-transition",
      },
      fixture: { identity: "responsive-evidence:populated-scope-transition:v1" },
      viewport: { width: 390, height: 844 },
      target: { identity: "scoped-catalog-cards" },
      assertions: expect.arrayContaining([
        expect.objectContaining({ identity: "mobile-primary-action-height", actual: 44 }),
        expect.objectContaining({ identity: "tablet-table-is-hidden", actual: false }),
      ]),
      artifacts: {
        screenshot: expect.objectContaining({ path: expect.stringMatching(/\.png$/), sha256: expect.any(String) }),
        sourceClaimSha256: expect.any(String),
        playwrightConfig: expect.objectContaining({ path: "playwright.config.ts", sha256: expect.any(String) }),
      },
    });
  });

  test("records exact tablet table evidence at 820px @marketplace-browse", async ({ page }, testInfo) => {
    await serveFixture(page, "/responsive-evidence/scope-transition", responsiveTransitionFixture());

    await captureResponsiveEvidence({ page, testInfo, claimId: "fixture-scope-table-tablet" });

    const entry = await readResponsiveEvidenceManifest(testInfo, "fixture-scope-table-tablet");
    expect(entry).toMatchObject({
      claimId: "fixture-scope-table-tablet",
      route: {
        name: "populated responsive scope fixture",
        observed: "/responsive-evidence/scope-transition",
      },
      fixture: { identity: "responsive-evidence:populated-scope-transition:v1" },
      viewport: { width: 820, height: 900 },
      target: { identity: "scoped-catalog-table" },
      assertions: expect.arrayContaining([
        expect.objectContaining({ identity: "tablet-primary-action-height", actual: 44 }),
        expect.objectContaining({ identity: "mobile-cards-are-hidden", actual: false }),
      ]),
      artifacts: {
        screenshot: expect.objectContaining({ path: expect.stringMatching(/\.png$/), sha256: expect.any(String) }),
        sourceClaimSha256: expect.any(String),
        playwrightConfig: expect.objectContaining({ path: "playwright.config.ts", sha256: expect.any(String) }),
      },
    });
  });
});

async function serveFixture(page: Page, routePath: string, body: string) {
  const url = `http://responsive-evidence.test${routePath}`;
  await page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html", body }));
  await page.goto(url, { waitUntil: "domcontentloaded" });
}

function fixtureDocument(body: string) {
  return `<!doctype html><html><head><style>html,body{margin:0;padding:0}</style></head><body>${body}</body></html>`;
}

function populationFixture(input: {
  targetIdentity: string;
  hiddenIndex?: number;
  zeroLayoutIndex?: number;
  matchRows?: boolean;
}) {
  const rowAttribute = input.matchRows === false ? "data-evidence-nonmatching-row" : "data-evidence-row";
  const rows = Array.from({ length: POPULATION_CONTROL_ROW_COUNT }, (_, index) => {
    const style =
      index === input.hiddenIndex
        ? ' style="visibility:hidden"'
        : index === input.zeroLayoutIndex
          ? ' style="width:0;height:0"'
          : "";
    return `<article ${rowAttribute}${style}>Synthetic population row ${index}</article>`;
  }).join("");
  return fixtureDocument(`
    <style>
      [data-evidence-target] { position: relative; width: 100%; height: 100px; }
      [data-evidence-row], [data-evidence-nonmatching-row] {
        position: absolute;
        inset: 0 auto auto 0;
        box-sizing: border-box;
        width: 1px;
        height: 1px;
        overflow: hidden;
      }
    </style>
    <main data-evidence-target="${input.targetIdentity}">${rows}</main>
  `);
}

function responsiveTransitionFixture() {
  return fixtureDocument(`
    <style>
      [data-evidence-target="scope-cards"] { display: block; width: 100%; }
      [data-evidence-target="scope-table"] { display: none; width: 100%; border-collapse: collapse; }
      [data-primary-action] { display: inline-flex; box-sizing: border-box; height: 44px; align-items: center; }
      @media (min-width: 768px) {
        [data-evidence-target="scope-cards"] { display: none; }
        [data-evidence-target="scope-table"] { display: table; }
      }
    </style>
    <div data-evidence-target="scope-cards" role="list">
      <article role="listitem">
        <span>Paldean Fates</span>
        <button data-primary-action>View scope</button>
      </article>
    </div>
    <table data-evidence-target="scope-table">
      <thead><tr><th>Scope</th><th>Action</th></tr></thead>
      <tbody>
        <tr><td>Paldean Fates</td><td><button data-primary-action>View scope</button></td></tr>
      </tbody>
    </table>
  `);
}

function expectResponsiveEvidenceArtifactsAbsent(
  testInfo: Parameters<typeof responsiveEvidenceArtifactPaths>[0],
  claimId: string,
) {
  const paths = responsiveEvidenceArtifactPaths(testInfo, claimId);
  expect(existsSync(paths.screenshot), `${claimId} must fail before screenshot capture`).toBe(false);
  expect(existsSync(paths.manifest), `${claimId} must fail before manifest emission`).toBe(false);
}

async function readResponsiveEvidenceManifest(
  testInfo: Parameters<typeof responsiveEvidenceArtifactPaths>[0],
  claimId: string,
) {
  const paths = responsiveEvidenceArtifactPaths(testInfo, claimId);
  expect(existsSync(paths.screenshot), `${claimId} must produce its screenshot`).toBe(true);
  expect(existsSync(paths.manifest), `${claimId} must produce its runtime manifest`).toBe(true);
  return JSON.parse(await readFile(paths.manifest, "utf8")) as unknown;
}
