import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { captureResponsiveEvidence, responsiveEvidenceArtifactPaths } from "@chase-sets/playwright-evidence";

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
