import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { createServer, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import ts from "@chase-sets/typescript-compiler-api";
import { runBrowserProof } from "./browser-proof-resources";

const secretMarkers = ["PRIVATE_INVITATION_TOKEN", "PRIVATE_PASSWORD", "PRIVATE_SESSION_TOKEN", "PRIVATE_ERROR"];
const routePath = "/bounded-contexts/auth/routes/marketplace/invite.tsx";
const stateModule = `
  export const probe = { inspect: 0, writes: 0, reads: 0, completions: 0, accountLoads: 0, attempts: [],
    settleWrite: null, settleRead: null, settleInspect: null, scenario: new URL(location.href).searchParams.get('scenario') };
  export const token = 'PRIVATE_INVITATION_TOKEN';
  export const password = 'PRIVATE_PASSWORD';
  window.invitationProbe = probe;
`;
const apiModule = `
  import { probe, token, password } from 'virtual:invitation-state';
  import { AuthApiError } from '/bounded-contexts/auth/client.ts';
  export const createAuthRequestApiClient = () => ({
    inspectInvitation: async () => { probe.inspect++; const result = { status:'pending', invitationId:'ivt_browser',
      email:'recipient@example.invalid', accountName:'Invited Account', invitedByName:'Inviter', roleLabel:'Viewer' };
      return probe.inspect === 1 ? result : new Promise(resolve=>{probe.settleInspect=()=>resolve(result)}); },
    acceptInvitation: async (input) => {
      probe.writes++; probe.attempts.push(input.attemptId);
      if(input.token !== token || input.password !== password) throw new Error('fixture submission mismatch');
      return new Promise((resolve, reject) => { probe.settleWrite = () => {
        if(probe.scenario === 'success') resolve({ type:'session-started', sessionToken:'PRIVATE_SESSION_TOKEN' });
        else if(probe.scenario === 'conflict') reject(new AuthApiError(409,{error:{code:'invitation_attempt_conflict'}}));
        else if(probe.scenario === 'failed-safe') reject(new AuthApiError(400,{error:{code:'invitation_attempt_invalid'}}));
        else if(probe.scenario === 'route-denied') reject(new AuthApiError(403,{error:{code:'forbidden'}}));
        else reject(new AuthApiError(503,{error:{code:'invitation_attempt_ambiguous',message:'PRIVATE_ERROR'}}));
      }; });
    },
    getInvitationAcceptanceStatus: async (input) => {
      probe.reads++; probe.attempts.push(input.attemptId);
      if(input.token !== token) throw new Error('fixture lookup mismatch');
      return new Promise((resolve,reject) => { probe.settleRead = () => {
        if(probe.reads === 1) reject(new Error('PRIVATE_ERROR'));
        else resolve({type:'accepted-reauth-required',attemptId:input.attemptId});
      }; });
    }
  });
`;
const entryModule = `
  import { createElement } from 'react';
  import { createRoot } from 'react-dom/client';
  import { createMemoryRouter, RouterProvider } from 'react-router';
  import Invite, { loader, action } from '${routePath}';
  import { probe, token } from 'virtual:invitation-state';
  import '/packages/design-system/src/styles/styles.css';
  const router = createMemoryRouter([
    {path:'/invite/:invitationId',loader,action,Component:Invite},
    {path:'/account',loader:()=>{probe.accountLoads++;return null},Component:()=>createElement('h1',null,'Current Account')}
  ],{initialEntries:['/invite/ivt_browser?token='+token]});
  createRoot(document.getElementById('root')).render(createElement(RouterProvider,{router}));
`;

function browserFixturePlugin(): Plugin {
  const modules: Record<string, string> = {
    "virtual:invitation-state": stateModule,
    "virtual:invitation-api": apiModule,
    "virtual:invitation-entry": entryModule,
    "virtual:invitation-rollout": "export const invitationAttemptRollout={active:true,requireAttempt:true};",
    "virtual:invitation-meta": "export const buildOpenGraphMeta=()=>[];",
    "virtual:invitation-host": `import {redirect} from 'react-router'; import {probe} from 'virtual:invitation-state';
      export const marketplaceAuthHost={completeAuthentication:(_request,result,options)=>{
        if(options.freshWriteSource!==result)throw new Error('fixture fresh-write handoff mismatch');
        probe.completions++;return redirect('/account');}}; export const toAuthActionError=()=>({error:'classified'});`,
  };
  return {
    name: "invitation-browser-owner-adapters",
    enforce: "pre",
    resolveId(source, importer) {
      if (source in modules) return `\0${source}`;
      if (!importer?.replaceAll("\\", "/").endsWith(routePath)) return;
      if (source.endsWith("/api-client")) return "\0virtual:invitation-api";
      if (source.endsWith("/auth-host.server") || source.endsWith("/auth-host")) return "\0virtual:invitation-host";
      if (source.endsWith("/rollout")) return "\0virtual:invitation-rollout";
      if (source === "@chase-sets/platform-runtime/meta") return "\0virtual:invitation-meta";
    },
    load(id) {
      return modules[id.replace(/^\0/, "")];
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/invitation-proof")) return next();
        response.setHeader("Content-Type", "text/html");
        response.end(
          '<!doctype html><html lang="en"><head><title>Invitation browser fixture</title></head><body><div id="root"></div><script type="module" src="/@id/__x00__virtual:invitation-entry"></script></body></html>',
        );
      });
    },
  };
}

async function extractAndScan(archive: string, output: string) {
  const bytes = await readFile(archive);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65_557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  expect(end).toBeGreaterThanOrEqual(0);
  const entries = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const files: string[] = [];
  for (let index = 0; index < entries; index++) {
    expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
    const compression = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const length = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString("utf8");
    const local = bytes.readUInt32LE(offset + 42);
    expect(bytes.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + size);
    expect([0, 8]).toContain(compression);
    const content = compression === 8 ? inflateRawSync(compressed) : compressed;
    expect(content.length).toBe(bytes.readUInt32LE(offset + 24));
    for (const marker of secretMarkers)
      expect(content.includes(Buffer.from(marker)), `secret scan: ${name}`).toBe(false);
    const target = resolve(output, name);
    expect(target.startsWith(`${resolve(output)}${sep}`)).toBe(true);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    files.push(name);
    offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  expect(files.some((name) => name.endsWith(".trace"))).toBe(true);
  expect(files.some((name) => name.startsWith("resources/"))).toBe(true);
  return { extractedEntries: files.length, markersAbsent: secretMarkers.length };
}

test.use({ trace: "off" }); // Manual recovery traces exclude private setup, including on hosted retries.

test.describe("Invitation real browser route @marketplace-account", () => {
  for (const scenario of ["success", "retry-failure", "conflict", "failed-safe", "route-denied"]) {
    test(`${scenario} retains real route states, focus and secret-free recovery evidence`, async ({
      browser,
    }, testInfo) => {
      const started = performance.now();
      let documentNavigations = 0;
      const diagnostic = (phase: string) =>
        console.log(
          JSON.stringify({
            invitationDiagnostic: scenario,
            phase,
            utc: new Date().toISOString(),
            elapsedMs: Math.round(performance.now() - started),
          }),
        );
      diagnostic("allocation:start");
      await runBrowserProof(async (resources) => {
        const root = resolve(".");
        const config = ts.readConfigFile(resolve(root, "tsconfig.base.json"), ts.sys.readFile);
        expect(config.error).toBeUndefined();
        const paths = config.config.compilerOptions.paths as Record<string, string[]>;
        const alias = Object.entries(paths).map(([name, targets]) => ({
          find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\*", "(.*)")}$`),
          replacement: resolve(root, targets[0]).replace("*", "$1"),
        }));
        const server = await createServer({
          configFile: false,
          root,
          plugins: [browserFixturePlugin(), tailwindcss()],
          resolve: { alias },
          // The HTML and entry are virtual, so disk entry discovery cannot see
          // their imports. Optimize the real entry/route dependencies together.
          optimizeDeps: {
            entries: [],
            include: [
              "react",
              "react/jsx-dev-runtime",
              "react-dom/client",
              "react-router",
              "@chase-sets/design-system",
            ],
          },
          server: { host: "127.0.0.1", port: 0 },
        });
        diagnostic("server:allocated");
        resources.release(async () => {
          diagnostic("server-close:start");
          await server.close();
          diagnostic("server-close:complete");
        });
        server.httpServer?.on("close", () => diagnostic("server:closed"));
        const context = await browser.newContext();
        diagnostic("context:allocated");
        resources.release(async () => {
          diagnostic("context-close:start");
          await context.close();
          diagnostic("context-close:complete");
        });
        context.on("close", () => diagnostic("context:closed"));
        const archive = testInfo.outputPath(`${scenario}-trace.zip`);
        let tracing = false;
        resources.beforeDispose(async () => {
          diagnostic("disposal:start");
          if (tracing) {
            tracing = false;
            diagnostic("failure-trace-stop:start");
            await context.tracing.stop({ path: archive });
            diagnostic("failure-trace-stop:complete");
            diagnostic("failure-scan:start");
            await extractAndScan(archive, testInfo.outputPath(`${scenario}-failure-extracted`));
            diagnostic("failure-scan:complete");
          }
        });
        try {
          diagnostic("listen:start");
          await server.listen();
          diagnostic("listen:complete");
          const address = server.httpServer!.address();
          if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
          const page = await context.newPage();
          diagnostic("page:allocated");
          page.on("request", (request) => {
            if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
              documentNavigations++;
              diagnostic("navigation:document-request");
            }
          });
          page.on("framenavigated", (frame) =>
            diagnostic(frame === page.mainFrame() ? "navigation:main-frame" : "navigation:child-frame"),
          );
          page.on("close", () => diagnostic("page:closed"));
          diagnostic("navigation:start");
          await page.goto(`http://127.0.0.1:${address.port}/invitation-proof?scenario=${scenario}`);
          diagnostic("navigation:complete");
          await page.getByRole("radio", { name: "Password", exact: true }).click();
          diagnostic("readiness:complete");
          // Private setup is intentionally untraced. The actual route action still
          // receives and validates the synthetic bearer/password through its adapter.
          await page.getByLabel("Enter or create a password").fill(secretMarkers[1]);
          diagnostic("submit:start");
          await page.getByRole("button", { name: /Accept with password/i }).click();
          await expect(page.getByRole("status")).toContainText("Submitting your invitation acceptance");
          diagnostic("submit:complete");
          diagnostic("trace:start");
          await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
          diagnostic("trace:started");
          tracing = true;
          const phases: string[] = [];
          async function frame(phase: string, copy: string) {
            const status = page.getByRole("status");
            await expect(status).toContainText(copy);
            await expect(status).toBeFocused();
            await expect(status).toHaveAttribute("aria-live", "polite");
            for (const marker of secretMarkers) expect(await page.locator("body").innerHTML()).not.toContain(marker);
            await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) });
            phases.push(phase);
            diagnostic(`capture:${phase}`);
          }
          await frame("submitting", "Submitting your invitation acceptance");
          diagnostic("settlement:start");
          await page.evaluate("window.invitationProbe.settleWrite()");
          diagnostic("settlement:complete");
          if (scenario === "success") {
            await expect(page.getByRole("heading", { name: "Current Account" })).toBeVisible();
            await page.screenshot({ path: testInfo.outputPath("succeeded.png") });
            phases.push("succeeded");
            diagnostic("capture:succeeded");
          } else if (scenario === "retry-failure") {
            await expect.poll(() => page.evaluate("window.invitationProbe.reads")).toBe(1);
            await page.evaluate("window.invitationProbe.settleRead()");
            await expect.poll(() => page.evaluate("window.invitationProbe.inspect")).toBe(2);
            await frame("confirming", "Confirming invitation acceptance");
            await page.evaluate("window.invitationProbe.settleInspect()");
            await frame("ambiguous", "Invitation acceptance could not be confirmed.");
            await page.getByRole("button", { name: "Check status" }).click();
            await expect.poll(() => page.evaluate("window.invitationProbe.reads")).toBe(2);
            await page.evaluate("window.invitationProbe.settleRead()");
            await expect.poll(() => page.evaluate("window.invitationProbe.inspect")).toBe(3);
            await page.evaluate("window.invitationProbe.settleInspect()");
            await frame("accepted-reauth-required", "Invitation accepted. Sign in to continue.");
          } else {
            await expect.poll(() => page.evaluate("window.invitationProbe.inspect")).toBe(2);
            await page.evaluate("window.invitationProbe.settleInspect()");
            await frame(
              scenario,
              scenario === "conflict"
                ? "This invitation acceptance does not match the original attempt."
                : scenario === "failed-safe"
                  ? "Invitation could not be accepted"
                  : "This invitation is unavailable.",
            );
          }
          const counters = (await page.evaluate(
            "({...window.invitationProbe,settleWrite:undefined,settleRead:undefined,settleInspect:undefined})",
          )) as {
            writes: number;
            reads: number;
            completions: number;
            accountLoads: number;
            inspect: number;
            attempts: string[];
          };
          expect(counters.writes).toBe(1);
          expect(new Set(counters.attempts).size).toBe(1);
          expect(counters.completions).toBe(scenario === "success" ? 1 : 0);
          expect(counters.accountLoads).toBe(scenario === "success" ? 1 : 0);
          expect(counters.inspect).toBe(scenario === "success" ? 1 : scenario === "retry-failure" ? 3 : 2);
          diagnostic("proof:complete");
          diagnostic("trace-stop:start");
          tracing = false;
          await context.tracing.stop({ path: archive });
          diagnostic("trace-stop:complete");
          diagnostic("scan:start");
          const scan = await extractAndScan(archive, testInfo.outputPath(`${scenario}-extracted`));
          diagnostic("scan:complete");
          console.log(
            JSON.stringify({
              invitationRouteProof: scenario,
              phases,
              counters: {
                writes: counters.writes,
                reads: counters.reads,
                completions: counters.completions,
                accountLoads: counters.accountLoads,
                inspect: counters.inspect,
                attempts: counters.attempts.length,
                distinctAttempts: new Set(counters.attempts).size,
              },
              scan,
              documentNavigations,
            }),
          );
          await testInfo.attach("invitation-route-proof", {
            body: JSON.stringify({
              fixture: "test-only-owner-adapters; production route/action/loader/UI; rollout unchanged",
              phases,
              counters,
              scan,
              documentNavigations,
            }),
            contentType: "application/json",
          });
          diagnostic("attachment:complete");
        } catch (error) {
          diagnostic(`primary-error:${error instanceof Error ? error.name : "unknown"}`);
          throw error;
        }
      });
      expect(documentNavigations, "one initial document request; history.replaceState is not a reload").toBe(1);
      diagnostic("disposal:complete");
    });
  }

  test("already-closed context still releases the real fixture server", async ({ browser }) => {
    await runBrowserProof(async (resources) => {
      const server = await createServer({
        configFile: false,
        optimizeDeps: { entries: [] },
        server: { host: "127.0.0.1", port: 0 },
      });
      resources.release(() => server.close());
      await server.listen();
      const context = await browser.newContext();
      resources.release(() => context.close());
      await context.close();
      await resources.dispose();
      expect(server.httpServer?.listening).toBe(false);
      await resources.dispose();
    });
  });

  test("trace scanner rejects injected secret markers without publishing the archive", async ({
    browser,
  }, testInfo) => {
    await runBrowserProof(async (resources) => {
      const context = await browser.newContext();
      resources.release(() => context.close());
      const page = await context.newPage();
      for (const [index, marker] of secretMarkers.entries()) {
        const archive = resolve(tmpdir(), `invitation-scan-negative-${randomUUID()}.zip`);
        resources.release(async () => {
          try {
            await unlink(archive);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          }
        });
        await page.setContent("<div>Clean scanner control</div>");
        await context.tracing.start({ snapshots: true, screenshots: false, sources: false });
        await page.setContent(`<div>${marker}</div>`);
        await context.tracing.stop({ path: archive });
        await expect(extractAndScan(archive, testInfo.outputPath(`scanner-negative-${index}`))).rejects.toThrow(
          "secret scan:",
        );
      }
    });
  });
});
