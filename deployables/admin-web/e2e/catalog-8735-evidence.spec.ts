import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function capture({ sandbox, out, head, save, deadline, root, hosted = false }) {
  const require = createRequire(path.join(root, "package.json"));
  const { chromium, expect } = require("@playwright/test");
  const { Pool } = require("pg");
  const { browserE2ePlatformAdminEnv } = await import(
    pathToFileURL(path.join(root, "scripts/dev-system-config.mjs")).href
  );
  const id = "tcgdex_en_base2_60";
  const receipt = {
    head,
    seat: root,
    sandboxId: sandbox.id,
    origin: sandbox.urls.adminWeb,
    fixtureKind: "existing isolated scenario fixture, not live-provider fact",
    startedAt: new Date().toISOString(),
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    timezoneId: "America/Chicago",
    assertions: {
      fixture: "NOT_EXECUTED",
      populatedFirstLoad: "NOT_EXECUTED",
      sheetLoading: "NOT_EXECUTED",
      sheetLoadedIdentity: "NOT_EXECUTED",
      narrowedEmpty: "NOT_EXECUTED",
      allRestore: "NOT_EXECUTED",
      reload: "NOT_EXECUTED",
      backForward: "NOT_EXECUTED",
      otherScope: "NOT_EXECUTED",
    },
    screenshots: [],
  };
  const persist = () => save("capture-receipt.json", receipt);
  const pass = (name, evidence) => {
    receipt.assertions[name] = { result: "PASS", evidence };
    persist();
  };
  let active = "fixture";
  let browser;
  let context;
  persist();
  try {
    const pool = new Pool({
      connectionString: sandbox.contextDatabaseUrls.catalog,
      max: 1,
      statement_timeout: 10000,
      connectionTimeoutMillis: 10000,
    });
    try {
      const rows = await pool.query(
        "SELECT observation_id, provider_key, external_key, language_code, status, normalized->>'name' AS name, normalized->>'setId' AS set_id, normalized->>'expansionName' AS expansion_name FROM catalog_source_observations WHERE observation_id=$1",
        [id],
      );
      const counts = await pool.query(
        "SELECT provider_key,language_code,expansion_id,expansion_name,total_observations,promoted_observations,rejected_observations FROM catalog_source_observation_integration_scope_summaries WHERE provider_key='tcgdex' AND language_code='en' ORDER BY expansion_id LIMIT 50",
      );
      save("fixture-readback.json", {
        kind: receipt.fixtureKind,
        at: new Date().toISOString(),
        rows: rows.rows,
        counts: counts.rows,
      });
      assert.equal(rows.rows.length, 1, "FIXTURE_GAP: exact persisted observation missing");
      assert.equal(rows.rows[0].status, "promoted");
      assert.equal(rows.rows[0].provider_key, "tcgdex");
      assert.equal(rows.rows[0].name, "Pikachu");
      assert.equal(rows.rows[0].set_id.toLowerCase(), "base2");
      assert.ok(
        counts.rows.some((r) => Number(r.promoted_observations) === 1 && r.expansion_id.toLowerCase() === "base2"),
        "FIXTURE_GAP: Jungle promoted projection not 1",
      );
      pass("fixture", { observationId: id, rows: rows.rows, counts: counts.rows });
    } finally {
      await pool.end();
    }
    browser = await chromium.launch({ headless: true, timeout: 30000 });
    context = await browser.newContext({
      viewport: receipt.viewport,
      locale: receipt.locale,
      timezoneId: receipt.timezoneId,
    });
    const blocked = [];
    await context.route("**/*", async (route) => {
      const u = new URL(route.request().url());
      if (u.origin === sandbox.urls.adminWeb || ["data:", "blob:"].includes(u.protocol)) return route.continue();
      blocked.push({ origin: u.origin, type: route.request().resourceType() });
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(30000);
    const timer = setTimeout(() => context.close().catch(() => {}), Math.max(1, deadline - Date.now()));
    try {
      const snap = async (name) => {
        const p = path.join(out, "capture", name);
        await page.screenshot({ path: p, fullPage: true });
        const bytes = readFileSync(p);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        receipt.screenshots.push({ path: p, sha256, at: new Date().toISOString() });
        persist();
        if (hosted) {
          const encoded = bytes.toString("base64");
          for (let offset = 0; offset < encoded.length; offset += 12000)
            console.log(
              "8735_CAPTURE_PNG " +
                JSON.stringify({
                  name,
                  sha256,
                  offset,
                  total: encoded.length,
                  data: encoded.slice(offset, offset + 12000),
                }),
            );
        }
      };
      const inspect = async (name) =>
        save(name, {
          url: page.url(),
          text: await page.locator("body").innerText(),
          selects: await page
            .locator("select")
            .evaluateAll((es) =>
              es.map((e) => ({
                name: e.name,
                value: e.value,
                options: [...e.options].map((o) => ({ value: o.value, label: o.label })),
              })),
            ),
        });
      const origin = sandbox.urls.adminWeb;
      const auth = await context.request.post(`${origin}/api/auth/password-sign-in`, {
        data: {
          email: browserE2ePlatformAdminEnv.PLATFORM_ADMIN_EMAIL,
          password: browserE2ePlatformAdminEnv.PLATFORM_ADMIN_PASSWORD,
        },
        timeout: 30000,
      });
      assert.equal(auth.status(), 200, "Supported synthetic operator sign-in failed");
      const authBody = await auth.json();
      assert.ok(authBody.sessionToken);
      await context.addCookies([
        { name: "chase_sets_session", value: authBody.sessionToken, url: origin, httpOnly: true, sameSite: "Lax" },
      ]);
      active = "populatedFirstLoad";
      await page.goto(`${origin}/catalog/integrations`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true");
      receipt.initialUrl = page.url();
      await inspect("initial-dom.json");
      const bar = page.locator('[data-catalog-import-context-bar="true"]');
      const openBar = async () => {
        const trigger = bar.getByRole("button", { name: /Step 0.*Choose import scope/ });
        if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
      };
      await openBar();
      await bar.locator('select[name="providerKey"]').selectOption("tcgdex");
      await expect(page).toHaveURL(/providerKey=tcgdex/);
      await openBar();
      const unit = bar.locator('select[name="unitKey"]');
      const units = await unit
        .locator("option")
        .evaluateAll((es) => es.map((e) => ({ value: e.value, label: e.label })));
      const cardUnit = units.find((o) => o.value === "tcgdex:pokemon:card:import");
      assert.ok(cardUnit, "FIXTURE_GAP: TCGdex Pokemon card unit missing");
      await unit.selectOption(cardUnit.value);
      await expect(unit).toHaveValue(cardUnit.value);
      await openBar();
      const language = bar.locator('select[name="languageCode"]');
      await expect(language).toBeEnabled();
      await language.selectOption("en");
      await expect(page).toHaveURL(/languageCode=en/);
      await openBar();
      const expansion = bar.locator('select[name="expansionId"]');
      await expect(expansion).toBeEnabled();
      await expect
        .poll(
          async () =>
            expansion
              .locator("option")
              .evaluateAll((es) => es.some((e) => e.value.toLowerCase() === "base2" || /jungle/i.test(e.label))),
          { timeout: 30000 },
        )
        .toBe(true);
      const sets = await expansion
        .locator("option")
        .evaluateAll((es) => es.map((e) => ({ value: e.value, label: e.label })));
      const jungle = sets.find((o) => o.value.toLowerCase() === "base2" || /jungle/i.test(o.label));
      assert.ok(jungle);
      await expansion.selectOption(jungle.value);
      await expect(page).toHaveURL(/expansionId=(base2|Jungle)/i);
      receipt.selectedUrl = page.url();
      receipt.selectedControl = { provider: "tcgdex", unit: cardUnit, language: "en", expansion: jungle };
      await page.goto(receipt.selectedUrl, { waitUntil: "domcontentloaded" });
      await expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true");
      await expect(page.locator("[data-catalog-source-scope-workset]")).toContainText("Jungle");
      const review = () => page.getByRole("table", { name: "Source Observation review" });
      const showReview = async () => {
        const stage = page.locator('[data-catalog-import-workflow-stage="review-changes"]');
        if ((await stage.getAttribute("aria-expanded")) !== "true") await stage.click();
        const disclosure = page.getByRole("button", { name: "Source Observation evidence", exact: true });
        if ((await disclosure.count()) && (await disclosure.getAttribute("aria-expanded")) !== "true")
          await disclosure.click();
      };
      const all = () => page.getByRole("radio", { name: /^All \(/ });
      await expect(all()).toBeChecked();
      await expect(page.getByRole("radio", { name: "Promoted (1)", exact: true })).toBeVisible();
      const row = review().getByRole("row").filter({ hasText: "Pikachu" });
      await expect(row).toHaveCount(1);
      await expect(row).toBeVisible();
      receipt.rowIdentity = {
        observationId: id,
        rowText: await row.innerText(),
        allLabel: await all().getAttribute("aria-label"),
        selectedUrl: page.url(),
      };
      await snap("01-populated-first-load.png");
      await inspect("populated-dom.json");
      pass("populatedFirstLoad", { ...receipt.rowIdentity, openSourceScopeClicked: false });
      active = "sheetLoading";
      const resourcePath = `/catalog/integrations/observation-evidence/${encodeURIComponent(id)}`;
      let release;
      const hold = new Promise((resolve) => {
        release = resolve;
      });
      let heldResolve;
      const held = new Promise((resolve) => {
        heldResolve = resolve;
      });
      const matching = (u) => {
        const p = new URL(u).pathname;
        return p === resourcePath || p === `${resourcePath}.data`;
      };
      const requests = [];
      page.on("request", (request) => {
        if (matching(request.url()))
          requests.push({ method: request.method(), url: request.url(), at: new Date().toISOString() });
      });
      await page.route(
        (u) => matching(u.href),
        async (route) => {
          heldResolve();
          await hold;
          await route.continue();
        },
        { times: 1 },
      );
      const responseWait = page.waitForResponse((r) => matching(r.url()), { timeout: 30000 });
      await row.getByRole("button", { name: "Evidence", exact: true }).click();
      await Promise.race([
        held,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Evidence request was not intercepted")), 20000)),
      ]);
      try {
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("Pikachu");
        await expect(dialog.locator('[data-catalog-observation-evidence="loading"]')).toBeVisible();
        await snap("02-sheet-loading.png");
        pass("sheetLoading", {
          resourcePath,
          dialogTitleNames: "Pikachu",
          state: "loading",
          requestHeldAndForwardedUnchanged: true,
        });
      } finally {
        release();
      }
      active = "sheetLoadedIdentity";
      const response = await responseWait;
      const bytes = await response.body();
      let payload;
      if ((response.headers()["content-type"] ?? "").includes("text/x-script")) {
        const { UNSAFE_decodeViaTurboStream } = require("react-router");
        const decoded = await UNSAFE_decodeViaTurboStream(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          globalThis,
        );
        const candidates =
          decoded.value?.observationId === id
            ? [decoded.value]
            : Object.values(decoded.value)
                .map((value) => value?.data)
                .filter((value) => value?.observationId === id);
        assert.equal(candidates.length, 1, "Single owning route response required");
        payload = candidates[0];
      } else payload = JSON.parse(bytes.toString("utf8"));
      assert.equal(requests.length, 1, "Exactly one evidence browser GET required");
      assert.equal(requests[0].method, "GET");
      assert.equal(response.status(), 200);
      assert.equal(payload.observationId, id);
      assert.ok(payload.detail);
      assert.equal(payload.detail.observationId, id);
      const detail = payload.detail;
      const network = {
        resourceUrl: response.url(),
        status: response.status(),
        requestCount: requests.length,
        requests,
        observationId: payload.observationId,
        detail: {
          observationId: detail.observationId,
          providerKey: detail.providerKey,
          externalKey: detail.externalKey,
          sourceUrl: detail.sourceUrl,
          sourceRecordHash: detail.sourceRecordHash,
          observedAt: detail.observedAt,
          sourceProfileVersion: detail.sourceProfileVersion,
        },
      };
      save("network-identity-receipt.json", network);
      receipt.network = network;
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('[data-catalog-observation-evidence="loaded"]')).toBeVisible();
      await expect(dialog).toContainText("Pikachu");
      await expect(dialog).toContainText(detail.providerKey);
      await expect(dialog).toContainText(detail.externalKey);
      await expect(dialog).toContainText(detail.sourceRecordHash);
      await expect(page.locator('[data-catalog-observation-evidence="error"]')).toHaveCount(0);
      await expect(review()).toBeAttached();
      save("loaded-dom.json", {
        url: page.url(),
        dialogText: await dialog.innerText(),
        reviewMounted: await review().count(),
        errorBannerCount: await page.locator('[data-catalog-observation-evidence="error"]').count(),
      });
      await snap("03-sheet-loaded.png");
      pass("sheetLoadedIdentity", network);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      active = "narrowedEmpty";
      const rejected = page.getByRole("radio", { name: "Rejected (0)", exact: true });
      await expect(rejected).toBeVisible();
      await rejected.click();
      await expect(page).toHaveURL(/filter.status=rejected/);
      await showReview();
      await expect(rejected).toBeChecked();
      await expect(row).toHaveCount(0);
      const bodyText = await page.locator("body").innerText();
      assert.match(
        bodyText,
        /No rejected observations in Jungle.*1/i,
        "Narrowed-empty copy must name rejected/Jungle/positive total",
      );
      await snap("04-narrowed-empty.png");
      await inspect("narrowed-dom.json");
      const rejectedUrl = page.url();
      pass("narrowedEmpty", {
        url: rejectedUrl,
        status: "rejected",
        total: 1,
        copy: bodyText.match(/No rejected observations[^\n]*/i)?.[0],
      });
      active = "allRestore";
      await all().click();
      await expect(all()).toBeChecked();
      await expect(row).toBeVisible();
      const allUrl = page.url();
      pass("allRestore", { url: allUrl, rowId: id });
      active = "reload";
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(all()).toBeChecked();
      await expect(row).toBeVisible();
      assert.equal(page.url(), allUrl);
      pass("reload", { url: page.url() });
      active = "backForward";
      await page.goBack({ waitUntil: "domcontentloaded" });
      await showReview();
      await expect(rejected).toBeChecked();
      assert.equal(page.url(), rejectedUrl);
      await expect(row).toHaveCount(0);
      await page.goForward({ waitUntil: "domcontentloaded" });
      await showReview();
      await expect(all()).toBeChecked();
      await expect(row).toBeVisible();
      assert.equal(page.url(), allUrl);
      pass("backForward", { backUrl: rejectedUrl, forwardUrl: allUrl });
      active = "otherScope";
      await openBar();
      const others = await expansion
        .locator("option")
        .evaluateAll((es) =>
          es
            .map((e) => ({ value: e.value, label: e.label }))
            .filter((o) => o.value && !/base2|jungle/i.test(o.value + " " + o.label)),
        );
      assert.ok(others.length, "FIXTURE_GAP: no other existing seeded scope control available");
      const other = others[0];
      await expansion.selectOption(other.value);
      await expect(expansion).toHaveValue(other.value);
      await expect(page).not.toHaveURL(allUrl);
      await showReview();
      await expect(review().getByRole("row").filter({ hasText: "Pikachu" })).toHaveCount(0);
      await expect(page.locator("[data-catalog-source-scope-workset]")).toContainText(other.label);
      await snap("05-other-scope.png");
      await inspect("other-scope-dom.json");
      pass("otherScope", { url: page.url(), scope: other, jungleRowCount: 0 });
      receipt.outcome = "CAPTURE_COMPLETE";
      receipt.blockedOrigins = blocked;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    receipt.outcome = "CAPTURE_INCOMPLETE";
    receipt.error = String(e?.message ?? e);
    receipt.assertions[active] = { result: "FAIL", error: receipt.error };
    throw e;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    persist();
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

import { test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolveWorktreeSandbox } from "../../../scripts/lib/sandbox.mjs";

test("8735 exact-head evidence-only capture @catalog-admin-integrations", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const root = process.cwd();
  const head = "cca3018639b28bc2bd69384396fb81fd0b51f1e2";
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 15000 }).trim();
  const allowed = "deployables/admin-web/e2e/catalog-8735-evidence.spec.ts";
  const changed = git("diff", "--name-only", head, "HEAD", "--").split(/\r?\n/).filter(Boolean);
  assert.deepEqual(
    changed,
    [allowed],
    "Hosted executed tree must differ from the immutable head only by this capture spec",
  );
  const out = testInfo.outputPath("8735-evidence-g1");
  mkdirSync(path.join(out, "capture"), { recursive: true });
  const save = (name, value) => {
    writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + "\n");
    if (
      [
        "capture-receipt.json",
        "network-identity-receipt.json",
        "fixture-readback.json",
        "build-identity.json",
      ].includes(name)
    )
      console.log("8735_CAPTURE_JSON " + JSON.stringify({ name, value }));
  };
  const sandbox = resolveWorktreeSandbox({ rootDir: root });
  save("build-identity.json", {
    immutableProductHead: head,
    executedCheckout: git("rev-parse", "HEAD"),
    checkoutParents: git("show", "-s", "--format=%P", "HEAD"),
    executedTree: git("rev-parse", "HEAD^{tree}"),
    productTree: git("rev-parse", `${head}^{tree}`),
    sourceHead: process.env.OPERATOR_EVIDENCE_SOURCE_HEAD,
    changedPaths: changed,
    captureSpecSha256: createHash("sha256")
      .update(readFileSync(path.join(root, allowed)))
      .digest("hex"),
    sandboxId: sandbox.id,
    composeProject: sandbox.composeProjectName,
    origin: sandbox.urls.adminWeb,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    readiness:
      "normal unchanged Playwright webServer and projection-readiness prerequisites completed before test body",
    at: new Date().toISOString(),
  });
  await capture({ sandbox, out, head, save, deadline: Date.now() + 115000, root, hosted: true });
});
