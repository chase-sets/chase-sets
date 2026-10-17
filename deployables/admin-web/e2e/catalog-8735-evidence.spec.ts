import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const productHead = "cca3018639b28bc2bd69384396fb81fd0b51f1e2";
const observationId = "tcgdex_en_base2_60";
const specPath = "deployables/admin-web/e2e/catalog-8735-evidence.spec.ts";
type Assertion = { result: "PASS" | "FAIL" | "NOT_EXECUTED"; evidence?: unknown };
type RpcResponse = {
  id?: number;
  error?: unknown;
  result?: { result?: { value?: unknown }; exceptionDetails?: unknown };
};
type ProviderRequest = { origin: string; path: string; method: string; stack: string; at: string };
type MonitorState = { pid: number; observed: number; providers: ProviderRequest[] };
type EvidencePayload = {
  observationId: string;
  detail: null | {
    observationId: string;
    providerKey: string;
    externalKey: string;
    sourceRecordHash: string;
    sourceUrl: string | null;
    observedAt: string;
    sourceProfileVersion: string;
  };
};

async function observeApi(port: number, save: (name: string, value: unknown) => void) {
  const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
    timeout: 15000,
  })
    .trim()
    .split(/\s+/);
  assert.equal(pids.length, 1, "One owned API listener required");
  const pid = Number(pids[0]);
  process.kill(pid, "SIGUSR1");
  let endpoint = "";
  await expect
    .poll(
      async () => {
        try {
          const response = await fetch("http://127.0.0.1:9229/json/list", { signal: AbortSignal.timeout(1000) });
          const targets = (await response.json()) as { webSocketDebuggerUrl: string }[];
          endpoint = targets[0]?.webSocketDebuggerUrl ?? "";
          return Boolean(endpoint);
        } catch {
          return false;
        }
      },
      { timeout: 10000 },
    )
    .toBe(true);
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("API inspector connection failed")), { once: true });
  });
  let sequence = 0;
  const evaluate = (expression: string) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        socket.removeEventListener("message", receive);
        reject(new Error("Inspector observation deadline"));
      }, 10000);
      const receive = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as RpcResponse;
        if (message.id !== id) return;
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
        if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message)));
        else resolve(message.result?.result?.value);
      };
      socket.addEventListener("message", receive);
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
  assert.equal(await evaluate("process.pid"), pid, "Inspector must belong to exact API listener");
  await evaluate(`(async () => {
    const dc = process.getBuiltinModule('node:diagnostics_channel');
    const state = {pid: process.pid, observed: 0, providers: []};
    const listener = ({request}) => {
      state.observed++;
      const origin = String(request.origin);
      const hostname = new URL(origin).hostname;
      if (!['localhost','127.0.0.1','[::1]'].includes(hostname)) {
        state.providers.push({origin, path: request.path.split('?')[0], method: request.method,
          stack: new Error('passive provider request observation').stack, at: new Date().toISOString()});
      }
    };
    dc.subscribe('undici:request:create', listener);
    globalThis.__capture8735 = {state, listener, dc};
    return true;
  })()`);
  save("provider-monitor-binding.json", {
    pid,
    apiPort: port,
    diagnosticDiscoveryUrl: "http://127.0.0.1:9229/json/list",
    channel: "undici:request:create",
    transportUnchanged: true,
  });
  return {
    read: async () => {
      const state = (await evaluate("globalThis.__capture8735.state")) as MonitorState;
      assert.equal(state.pid, pid);
      save("provider-requests.json", state);
      return state;
    },
    close: async () => {
      await evaluate(
        "globalThis.__capture8735.dc.unsubscribe('undici:request:create', globalThis.__capture8735.listener); delete globalThis.__capture8735; true",
      );
      socket.close();
    },
  };
}

test("8735 exact-head review-only evidence capture @catalog-admin-integrations", async ({ browser }, testInfo) => {
  test.setTimeout(120000);
  const root = process.cwd();
  const require = createRequire(path.join(root, "package.json"));
  const { Pool } = require("pg") as {
    Pool: new (options: object) => {
      query: (sql: string, values?: string[]) => Promise<{ rows: Record<string, string>[] }>;
      end: () => Promise<void>;
    };
  };
  const { resolveWorktreeSandbox } = await import(pathToFileURL(path.join(root, "scripts/lib/sandbox.mjs")).href);
  const sandbox = resolveWorktreeSandbox({ rootDir: root }) as {
    id: string;
    composeProjectName: string;
    urls: { adminWeb: string };
    ports: { platformApi: number };
    contextDatabaseUrls: { catalog: string };
  };
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", timeout: 15000 }).trim();
  const changed = git("diff", "--name-only", productHead, "HEAD", "--").split(/\r?\n/).filter(Boolean);
  assert.deepEqual(changed, [specPath], "Only capture spec may differ from immutable product tree");
  const out = testInfo.outputPath("8735-evidence-g2");
  mkdirSync(out, { recursive: true });
  const save = (name: string, value: unknown) => {
    writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + "\n");
    console.log("8735_CAPTURE_JSON " + JSON.stringify({ name, value }));
  };
  const names = [
    "fixture",
    "reviewOnlyPath",
    "populatedFirstLoad",
    "sheetLoading",
    "oneResourceGet",
    "sheetLoadedIdentity",
    "narrowedEmpty",
    "allRestore",
    "reload",
    "backForward",
    "otherScope",
    "providerFree",
  ];
  const assertions: Record<string, Assertion> = Object.fromEntries(
    names.map((name) => [name, { result: "NOT_EXECUTED" }]),
  );
  const receipt: Record<string, unknown> = {
    head: productHead,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    seat: root,
    sandboxId: sandbox.id,
    origin: sandbox.urls.adminWeb,
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    timezoneId: "America/Chicago",
    fixtureKind: "existing isolated scenario fixture, not live-provider fact",
    assertions,
    screenshots: [],
    startedAt: new Date().toISOString(),
  };
  const persist = () => save("capture-receipt.json", receipt);
  const pass = (name: string, evidence: unknown) => {
    assertions[name] = { result: "PASS", evidence };
    persist();
  };
  let active = "fixture";
  let monitor: Awaited<ReturnType<typeof observeApi>> | undefined;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    timezoneId: "America/Chicago",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const screenshots: { name: string; sha256: string }[] = [];
  receipt.screenshots = screenshots;
  const snap = async (name: string) => {
    if (["01-populated-first-load.png", "04-narrowed-empty.png", "05-other-scope.png"].includes(name)) {
      await page.getByRole("radio", { name: /^All \(/ }).evaluate((element) => {
        element.scrollIntoView({ block: "start" });
        window.scrollBy(0, -240);
      });
    }
    const bytes = await page.screenshot({ path: path.join(out, name), fullPage: false });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    screenshots.push({ name, sha256 });
    persist();
    const data = bytes.toString("base64");
    for (let offset = 0; offset < data.length; offset += 12000)
      console.log(
        "8735_CAPTURE_PNG " +
          JSON.stringify({ name, sha256, offset, total: data.length, data: data.slice(offset, offset + 12000) }),
      );
  };
  const checkProvider = async () => {
    assert.ok(monitor);
    const state = await monitor.read();
    receipt.providerRequests = state;
    if (state.providers.length) {
      assertions.providerFree = { result: "FAIL", evidence: state };
      throw new Error("PRODUCT_FINDING: review-only route triggered server-side provider request; capture stopped");
    }
  };
  const assertReviewPath = () => {
    assert.equal(new URL(page.url()).searchParams.get("section"), "source-observation-review");
  };
  try {
    const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 15000 }).trim();
    const ids = docker("ps", "-q", "--filter", `label=com.docker.compose.project=${sandbox.composeProjectName}`)
      .split(/\s+/)
      .filter(Boolean);
    assert.ok(ids.length);
    const containers = ids.map((id) => {
      const labels = JSON.parse(docker("inspect", "--format", "{{json .Config.Labels}}", id)) as Record<string, string>;
      assert.equal(labels["com.chase-sets.sandbox.id"], sandbox.id);
      assert.equal(
        labels["com.chase-sets.sandbox.worktree"].replaceAll("\\", "/").toLowerCase(),
        root.replaceAll("\\", "/").toLowerCase(),
      );
      return {
        id,
        sandboxId: labels["com.chase-sets.sandbox.id"],
        worktree: labels["com.chase-sets.sandbox.worktree"],
      };
    });
    save("build-identity.json", {
      immutableProductHead: productHead,
      executedCheckout: git("rev-parse", "HEAD"),
      checkoutParents: git("show", "-s", "--format=%P", "HEAD"),
      sourceHead: process.env.OPERATOR_EVIDENCE_SOURCE_HEAD,
      changedPaths: changed,
      captureSpecSha256: createHash("sha256")
        .update(readFileSync(path.join(root, specPath)))
        .digest("hex"),
      containers,
      readiness: "normal unchanged hosted webServer/projection prerequisites completed",
      at: new Date().toISOString(),
    });
    const apiRoot = "bounded-contexts/catalog/features/source-observations/api";
    const adapter = readFileSync(path.join(root, apiRoot, "providers/tcgdex/adapter.ts"), "utf8");
    const definition = adapter.match(
      /export const TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY = defineCatalogIntegrationUnitKey\(\{([\s\S]*?)\}\);/,
    );
    assert.ok(definition, "Production unit definition required");
    const identity = Object.fromEntries(
      [...definition[1].matchAll(/(\w+):\s*"([^"]+)"/g)].map((match) => [match[1], match[2]]),
    );
    const factorySource = readFileSync(path.join(root, apiRoot, "governance/integration-unit.ts"), "utf8");
    const factory = (await import(
      "data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(factorySource)).toString("base64")
    )) as { defineCatalogIntegrationUnitKey: (identity: Record<string, string>) => string };
    const unitKey = factory.defineCatalogIntegrationUnitKey(identity);
    receipt.unitDefinition = {
      unitKey,
      identity,
      path: `${apiRoot}/providers/tcgdex/adapter.ts`,
      factoryPath: `${apiRoot}/governance/integration-unit.ts`,
      adapterSha256: createHash("sha256").update(adapter).digest("hex"),
    };
    const pool = new Pool({
      connectionString: sandbox.contextDatabaseUrls.catalog,
      max: 1,
      statement_timeout: 10000,
      connectionTimeoutMillis: 10000,
    });
    try {
      const fixture = await pool.query(
        "SELECT observation_id,provider_key,external_key,language_code,status,normalized->>'name' AS name,normalized->>'setId' AS set_id,normalized->>'expansionName' AS expansion_name FROM catalog_source_observations WHERE observation_id=$1",
        [observationId],
      );
      const counts = await pool.query(
        "SELECT expansion_id,expansion_name,total_observations,promoted_observations,rejected_observations FROM catalog_source_observation_integration_scope_summaries WHERE provider_key='tcgdex' AND language_code='en' ORDER BY expansion_id LIMIT 50",
      );
      save("fixture-readback.json", { rows: fixture.rows, counts: counts.rows, kind: receipt.fixtureKind });
      assert.equal(fixture.rows.length, 1);
      assert.equal(fixture.rows[0].status, "promoted");
      assert.equal(fixture.rows[0].provider_key, "tcgdex");
      assert.equal(fixture.rows[0].external_key, "base2-60");
      assert.equal(fixture.rows[0].language_code, "en");
      assert.equal(fixture.rows[0].name, "Pikachu");
      assert.equal(fixture.rows[0].set_id.toLowerCase(), "base2");
      assert.ok(
        counts.rows.some(
          (row) => row.expansion_id.toLowerCase() === "base2" && Number(row.promoted_observations) === 1,
        ),
      );
      pass("fixture", { observationId, rows: fixture.rows, counts: counts.rows });
    } finally {
      await pool.end();
    }
    monitor = await observeApi(sandbox.ports.platformApi, save);
    const browserExternal: { origin: string; path: string }[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!["data:", "blob:"].includes(url.protocol) && url.origin !== sandbox.urls.adminWeb)
        browserExternal.push({ origin: url.origin, path: url.pathname });
    });
    const { browserE2ePlatformAdminEnv } = await import(
      pathToFileURL(path.join(root, "scripts/dev-system-config.mjs")).href
    );
    const auth = await context.request.post(`${sandbox.urls.adminWeb}/api/auth/password-sign-in`, {
      data: {
        email: browserE2ePlatformAdminEnv.PLATFORM_ADMIN_EMAIL,
        password: browserE2ePlatformAdminEnv.PLATFORM_ADMIN_PASSWORD,
      },
    });
    assert.equal(auth.status(), 200);
    const authBody = (await auth.json()) as { sessionToken: string };
    await context.addCookies([
      {
        name: "chase_sets_session",
        value: authBody.sessionToken,
        url: sandbox.urls.adminWeb,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    active = "reviewOnlyPath";
    receipt.initialUrl = `${sandbox.urls.adminWeb}/catalog/integrations?section=source-observation-review`;
    await page.goto(String(receipt.initialUrl), { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true");
    await checkProvider();
    assertReviewPath();
    // Select the review route directly. Never open Run sync, import preview, or Open source scope.
    const selected = new URL("/catalog/integrations", sandbox.urls.adminWeb);
    selected.search = new URLSearchParams({
      section: "source-observation-review",
      providerKey: identity.providerKey,
      unitKey,
      languageCode: "en",
      expansionId: "base2",
      expansionName: "Jungle",
    }).toString();
    receipt.selectedUrl = selected.href;
    await page.goto(selected.href, { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true");
    receipt.selectedDomText = await page.locator("body").innerText();
    await checkProvider();
    assertReviewPath();
    pass("reviewOnlyPath", {
      initialUrl: receipt.initialUrl,
      selectedUrl: page.url(),
      importPreviewOpened: false,
      openSourceScopeClicked: false,
    });
    active = "populatedFirstLoad";
    const review = page.getByRole("table", { name: "Source Observation review" });
    const showReview = async () => {
      const disclosure = page.getByRole("button", { name: "Source Observation evidence", exact: true });
      if ((await disclosure.count()) && (await disclosure.getAttribute("aria-expanded")) !== "true")
        await disclosure.click();
    };
    await showReview();
    const row = review.getByRole("row").filter({ hasText: "Pikachu" });
    const all = page.getByRole("radio", { name: /^All \(/ });
    await expect(all).toBeChecked();
    await expect(page.getByRole("radio", { name: "Promoted (1)", exact: true })).toBeVisible();
    await expect(row).toBeVisible();
    await expect(page.locator("[data-catalog-source-scope-workset]")).toContainText("Jungle");
    await checkProvider();
    await snap("01-populated-first-load.png");
    pass("populatedFirstLoad", {
      observationId,
      url: page.url(),
      rowText: await row.innerText(),
      allChecked: true,
      promoted: 1,
    });
    active = "sheetLoading";
    const resourcePath = `/catalog/integrations/observation-evidence/${encodeURIComponent(observationId)}`;
    const matches = (url: string) => [resourcePath, `${resourcePath}.data`].includes(new URL(url).pathname);
    let release: () => void = () => {};
    let markHeld: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    const requests: { method: string; url: string }[] = [];
    page.on("request", (request) => {
      if (matches(request.url())) requests.push({ method: request.method(), url: request.url() });
    });
    await page.route(
      (url) => matches(url.href),
      async (route) => {
        markHeld();
        await hold;
        await route.continue();
      },
      { times: 1 },
    );
    const responseWait = page.waitForResponse((response) => matches(response.url()));
    try {
      await row.getByRole("button", { name: "Evidence", exact: true }).click();
      await held;
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Pikachu");
      await expect(dialog.locator('[data-catalog-observation-evidence="loading"]')).toBeVisible();
      await snap("02-sheet-loading.png");
      pass("sheetLoading", { resourcePath, heldThenForwardedUnchanged: true });
    } finally {
      release();
    }
    active = "oneResourceGet";
    const response = await responseWait;
    const bytes = await response.body();
    let payload: EvidencePayload;
    if ((response.headers()["content-type"] ?? "").includes("text/x-script")) {
      const { UNSAFE_decodeViaTurboStream } = require("react-router") as {
        UNSAFE_decodeViaTurboStream: (
          stream: ReadableStream,
          global: typeof globalThis,
        ) => Promise<{ value: Record<string, { data?: EvidencePayload }> }>;
      };
      const decoded = await UNSAFE_decodeViaTurboStream(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        globalThis,
      );
      const candidates = Object.values(decoded.value)
        .map((value) => value.data)
        .filter((value): value is EvidencePayload => value?.observationId === observationId);
      assert.equal(candidates.length, 1);
      payload = candidates[0];
    } else {
      payload = JSON.parse(bytes.toString("utf8")) as EvidencePayload;
    }
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
    assert.equal(response.status(), 200);
    assert.equal(payload.observationId, observationId);
    assert.ok(payload.detail);
    assert.equal(payload.detail.observationId, observationId);
    const network = {
      resourceUrl: response.url(),
      status: response.status(),
      requestCount: requests.length,
      requests,
      observationId: payload.observationId,
      detail: {
        observationId: payload.detail.observationId,
        providerKey: payload.detail.providerKey,
        externalKey: payload.detail.externalKey,
        sourceUrl: payload.detail.sourceUrl,
        sourceRecordHash: payload.detail.sourceRecordHash,
        observedAt: payload.detail.observedAt,
        sourceProfileVersion: payload.detail.sourceProfileVersion,
      },
    };
    save("network-identity-receipt.json", network);
    receipt.network = network;
    pass("oneResourceGet", network);
    active = "sheetLoadedIdentity";
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-catalog-observation-evidence="loaded"]')).toBeVisible();
    for (const text of [
      "Pikachu",
      payload.detail.providerKey,
      payload.detail.externalKey,
      payload.detail.sourceRecordHash,
    ])
      await expect(dialog).toContainText(text);
    await expect(page.locator('[data-catalog-observation-evidence="error"]')).toHaveCount(0);
    const mountedReview = page.locator("table").filter({
      has: page.locator("caption").filter({ hasText: /^Source Observation review$/ }),
    });
    await expect(mountedReview).toHaveCount(1);
    await expect(mountedReview).toBeAttached();
    await checkProvider();
    receipt.loadedDom = { url: page.url(), dialogText: await dialog.innerText(), reviewMounted: true, errorCount: 0 };
    await snap("03-sheet-loaded.png");
    pass("sheetLoadedIdentity", receipt.loadedDom);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    active = "narrowedEmpty";
    const rejected = page.getByRole("radio", { name: "Rejected (0)", exact: true });
    await rejected.click();
    await expect(page).toHaveURL(/filter.status=rejected/);
    await showReview();
    await expect(rejected).toBeChecked();
    await expect(row).toHaveCount(0);
    const text = await page.locator("body").innerText();
    assert.match(text, /No rejected observations in Jungle.*1/i);
    await checkProvider();
    await snap("04-narrowed-empty.png");
    const rejectedUrl = page.url();
    pass("narrowedEmpty", { url: rejectedUrl, copy: text.match(/No rejected observations[^\n]*/i)?.[0] });
    active = "allRestore";
    await all.click();
    await expect(all).toBeChecked();
    await expect(row).toBeVisible();
    const allUrl = page.url();
    await checkProvider();
    pass("allRestore", { url: allUrl });
    active = "reload";
    await page.reload();
    await showReview();
    await expect(all).toBeChecked();
    await expect(row).toBeVisible();
    assert.equal(page.url(), allUrl);
    await checkProvider();
    pass("reload", { url: page.url() });
    active = "backForward";
    await page.goBack();
    await showReview();
    await expect(rejected).toBeChecked();
    assert.equal(page.url(), rejectedUrl);
    await expect(row).toHaveCount(0);
    await page.goForward();
    await showReview();
    await expect(all).toBeChecked();
    await expect(row).toBeVisible();
    assert.equal(page.url(), allUrl);
    await checkProvider();
    pass("backForward", { backUrl: rejectedUrl, forwardUrl: allUrl });
    active = "otherScope";
    const bar = page.locator('[data-catalog-import-context-bar="true"]');
    const trigger = bar.getByRole("button", { name: /Step 0.*Choose import scope/ });
    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
    const expansion = bar.locator('select[name="expansionId"]');
    const others = await expansion.locator("option").evaluateAll((options) =>
      options
        .map((option) => {
          if (!(option instanceof HTMLOptionElement)) throw new Error("Expected an option element");
          return { value: option.value, label: option.label };
        })
        .filter((option) => option.value && !/base2|jungle/i.test(option.value + option.label)),
    );
    assert.ok(others.length, "FIXTURE_GAP: no other existing scope available");
    await expansion.selectOption(others[0].value);
    await showReview();
    await expect(row).toHaveCount(0);
    await checkProvider();
    assertReviewPath();
    await snap("05-other-scope.png");
    pass("otherScope", { scope: others[0], url: page.url(), jungleRowCount: 0 });
    active = "providerFree";
    await checkProvider();
    assert.deepEqual(browserExternal, []);
    pass("providerFree", { server: await monitor.read(), browserExternal, transportUnchanged: true });
    receipt.outcome = "CAPTURE_COMPLETE";
  } catch (error) {
    receipt.outcome = "CAPTURE_INCOMPLETE";
    receipt.error = error instanceof Error ? error.message : String(error);
    assertions[active] = { result: "FAIL", evidence: receipt.error };
    throw error;
  } finally {
    if (monitor) {
      try {
        receipt.providerRequests = await monitor.read();
      } finally {
        await monitor.close();
      }
    }
    receipt.finishedAt = new Date().toISOString();
    persist();
    await context.close();
  }
});
