import { expect, test as base } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";

const artifactRoot = path.resolve(import.meta.dirname, "../../artifacts/playwright-evidence-authority");
const designSystemRequire = createRequire(path.resolve(import.meta.dirname, "../../packages/design-system/package.json"));
const fontPackage = designSystemRequire.resolve("@fontsource/space-grotesk/package.json");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
let runtimeState: null | { events: Array<{ kind: string; monotonicMs: number; digest: string }>; reporterStates: Array<{ classification: string; status: string; expectedStatus: string; annotations: Array<{ type: string; description: string }> }>; observe: (kind: string) => void } = null;
const test = base.extend<{ authorityTeardown: void }>({
  authorityTeardown: [async ({}, use) => {
    await use();
    if (!runtimeState) return;
    runtimeState.observe("teardown");
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(path.join(artifactRoot, "runtime-receipt.json"), `${JSON.stringify({ schema: "runtime-witness/v1", capturedAt: new Date().toISOString(), retry: 1, events: runtimeState.events, reporterStates: runtimeState.reporterStates })}\n`);
    runtimeState = null;
  }, { auto: true }],
});

test("ordinary pass", async () => expect(1).toBe(1));

test("expected failure", async () => {
  test.fail(true, "declared expected-failure reporter state");
  expect("actual-failure").toBe("expected-control");
});

test("skipped", async () => test.skip(true, "declared skipped reporter state"));

test("retry-1 retained evidence corpus", async ({ page, context, request }, testInfo) => {
  testInfo.annotations.push({ type: "authority", description: "bounded synthetic corpus" });
  if (testInfo.retry === 0) expect("retry-control").toBe("retry-1");

  const events: Array<{ kind: string; monotonicMs: number; digest: string }> = [];
  let registeredValue = "";
  let woff2Bytes = await readFile(path.join(path.dirname(fontPackage), "files/space-grotesk-latin-400-normal.woff2"));
  let opaqueBytes = Buffer.alloc(0);
  const observe = (kind: string) => {
    const monotonicMs = performance.now();
    events.push({ kind, monotonicMs, digest: digest(`${kind}:${monotonicMs}`) });
  };
  const server = createServer((incoming, response) => {
    if (!registeredValue) {
      observe("request");
      registeredValue = `SYNTHETIC_REGISTERED_PROBE_VALUE_${digest(String(performance.now())).slice(0, 20)}`;
      observe("mint");
      observe("register");
    }
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/font.woff2") {
      response.writeHead(200, { "content-type": "font/woff2", "x-probe": registeredValue });
      response.end(woff2Bytes);
    } else if (url.pathname === "/opaque") {
      opaqueBytes = Buffer.concat([Buffer.from([0, 255, 1, 254]), Buffer.from(registeredValue)]);
      response.writeHead(200, { "content-type": "application/octet-stream", "x-probe": registeredValue });
      response.end(opaqueBytes);
    } else if (url.pathname === "/api") {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => {
        response.writeHead(200, { "content-type": "application/json", "set-cookie": `probe=${registeredValue}` });
        response.end(JSON.stringify({ echoedBytes: Buffer.concat(chunks).length, registeredValue }));
      });
    } else {
      response.writeHead(201, { "content-type": "text/html", "x-probe": registeredValue });
      response.end(`<style>@font-face{font-family:p;src:url('/font.woff2')}body{font-family:p}</style><main>${registeredValue}</main>`);
      observe("response");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("capture server address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;

  await page.goto(origin);
  await context.addCookies([{ name: "authority", value: registeredValue, url: origin }]);
  await page.evaluate((value) => {
    localStorage.setItem("authority", value);
    return fetch("/api", { method: "POST", headers: { "x-probe": value }, body: JSON.stringify({ value, nested: { value } }) });
  }, registeredValue);
  await Promise.all([page.evaluate(() => fetch("/font.woff2")), page.evaluate(() => fetch("/opaque"))]);
  await request.post(`${origin}/api`, { headers: { "x-probe": registeredValue }, data: { registeredValue } });
  await context.storageState({ path: path.join(artifactRoot, "storage-state.json") });
  await testInfo.attach("registered-shapes", {
    body: Buffer.from(JSON.stringify({ exact: registeredValue, url: encodeURIComponent(registeredValue), base64: Buffer.from(registeredValue).toString("base64") })),
    contentType: "application/json",
  });
  await testInfo.attach("opaque-attachment", { body: Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from(registeredValue)]), contentType: "application/octet-stream" });
  await page.screenshot({ path: testInfo.outputPath("rendered-value.png") });
  process.stdout.write("authority-corpus-stdout\n");
  process.stderr.write("authority-corpus-stderr\n");
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const reporterStates = [
    ["ordinary-pass", "passed", "passed"], ["ordinary-fail", "failed", "passed"],
    ["skip", "skipped", "skipped"], ["expected-failure", "failed", "failed"],
    ["unexpected-pass", "passed", "failed"], ["retry-pass", "passed", "passed"],
    ["timed-out", "timedOut", "passed"], ["interrupted", "interrupted", "passed"],
  ].map(([classification, status, expectedStatus]) => ({ classification, status, expectedStatus, annotations: [{ type: "control", description: "declared reporter shape" }] }));
  runtimeState = { events, reporterStates, observe };
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(artifactRoot, "font.woff2"), woff2Bytes);
  await writeFile(path.join(artifactRoot, "opaque-body.bin"), opaqueBytes);
});
