import { expect, test, type BrowserContext } from "@playwright/test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { startLoopback } from "../__tests__/harness/loopback";
import { syntheticClaim } from "../__tests__/harness/claim";
import { journalPhases } from "../__tests__/harness/journal-boundaries";
import { observeUntil } from "../__tests__/support/browser-observation";
import { scanRetainedArtifacts } from "./retained-artifacts";
import { installationDiagnostics } from "./extension-installation";
import {
  buildHarness,
  launchCoordinator,
  pair,
  proofRoot,
  qualifiedWindowMs,
  retain,
  snapshot,
  wake,
} from "./coordinator-observation";

test.use({ trace: "off", screenshot: "off" });
let server: Awaited<ReturnType<typeof startLoopback>>;
const bundles = new Map<string, string>();
const active = new Set<BrowserContext>();
let retainedSession = false;
test.beforeAll(async () => {
  server = await startLoopback();
  for (const unit of ["operation", "reservation"] as const) bundles.set(unit, await buildHarness(unit));
  bundles.set("replay-mutant", await buildHarness("operation", true));
  bundles.set("replay-mutant-suppressed", await buildHarness("operation", true, true));
  const bytes = (name: string, file: string) => readFileSync(join(bundles.get(name)!, file), "utf8");
  expect(bytes("replay-mutant", "execution-identity.json")).not.toBe(bytes("operation", "execution-identity.json"));
  expect(bytes("replay-mutant-suppressed", "background.js")).toBe(bytes("operation", "background.js"));
  for (const arm of ["replay-mutant", "replay-mutant-suppressed"])
    expect(bytes(arm, "manifest.json")).toBe(bytes("operation", "manifest.json"));
});
test.beforeEach(() => {
  if (!retainedSession) server.reset();
});
test.afterEach(async ({}, info) => {
  if (retainedSession && info.status === info.expectedStatus) return;
  for (const context of active) await context.close();
  active.clear();
});
test.afterAll(async () => {
  for (const context of active) await context.close();
  await server?.close();
});

test("connector-coordinator-loopback-production-path-chromium @tcgplayer-connector-extension-authority", async () => {
  const f = await launchCoordinator(bundles.get("operation")!);
  active.add(f.context);
  await pair(f.context, f.worker);
  const before = server.portalCalls.length;
  server.claims.push(syntheticClaim());
  await f.context.tracing.start({ snapshots: false, screenshots: false, sources: false });
  await wake(f.worker);
  await expect.poll(async () => (await snapshot(f.worker)).reservations[0]?.phase).toBe("acked");
  expect(server.portalCalls.length - before).toBe(1);
  await expect(f.context.pages()[0]!.locator("#synthetic-absent-control").click({ timeout: 50 })).rejects.toThrow();
  const path = join(proofRoot, "traces", "synthetic-retained-failure-trace.zip");
  await f.context.tracing.stop({ path });
  const evidence = await snapshot(f.worker);
  retain("connector-coordinator-loopback-production-path-chromium", evidence);
  const inspected = scanRetainedArtifacts(join(proofRoot, "traces"), server.platform.forbidden());
  expect(inspected).toBeGreaterThan(0);
  retain("extension-retained-artifact-scan", { inspected, zipBase64: readFileSync(path).toString("base64") });
});

for (const arm of ["operation", "replay-mutant", "replay-mutant-suppressed"] as const)
  test(`connector-coordinator-replay-guard-removed ${arm} commit-before-receipt @tcgplayer-connector-extension-authority`, async () => {
    const evidence: Record<string, unknown> = { arm };
    try {
      const first = await launchCoordinator(bundles.get("operation")!);
      active.add(first.context);
      await pair(first.context, first.worker);
      server.hold("portal");
      server.claims.push(syntheticClaim());
      await wake(first.worker);
      await expect.poll(() => server.portalCalls.length).toBe(1);
      const before = await snapshot(first.worker);
      evidence.before = before;
      evidence.profile = first.profile;
      evidence.installation = first.directory;
      expect(before.members[0]?.state).toBe("dispatched");
      expect(before.reservations[0]?.phase).toBe("dispatched");
      expect(Date.parse(String(before.reservations[0]?.leaseExpiresAt))).toBeGreaterThan(Date.now());
      await first.context.close();
      active.delete(first.context);
      server.release("portal");
      const second = await launchCoordinator(bundles.get(arm)!, first.profile);
      active.add(second.context);
      expect(second.directory).toBe(first.directory);
      evidence.reentry = await snapshot(second.worker);
      if (arm === "replay-mutant") {
        await expect.poll(() => server.portalCalls.length).toBe(2);
        expect(() => expect(server.portalCalls.length).toBe(1)).toThrow();
        evidence.singleDispatchWitness = "FAIL";
      } else {
        if (arm === "replay-mutant-suppressed") {
          const witnessError = await expect
            .poll(() => server.portalCalls.length)
            .toBe(2)
            .then(
              () => null,
              (error: unknown) => String(error),
            );
          evidence.mutantWitnessError = witnessError;
          expect(witnessError).not.toBeNull();
        }
        await expect.poll(async () => (await snapshot(second.worker)).reservations[0]?.phase).toBe("acked");
        expect(server.report(0).outcomes[0]?.outcome.kind).toBe("outcome-unknown");
        expect(server.portalCalls.length).toBe(1);
        evidence.singleDispatchWitness = "PASS";
      }
      evidence.after = await snapshot(second.worker);
    } catch (error) {
      evidence.error = String(error);
      throw error;
    } finally {
      evidence.portalCalls = server.portalCalls.length;
      evidence.workers = await Promise.all([...active].map(installationDiagnostics));
      retain(`replay-guard-${arm}`, evidence);
    }
  });

for (const boundary of ["portal-held", "receipt-before-report", "report-held"] as const) {
  test.describe(`connector-coordinator-restart-chromium ${boundary} @tcgplayer-connector-extension-authority`, () => {
    test.describe.configure({ mode: "serial" });
    let second: Awaited<ReturnType<typeof launchCoordinator>>;
    let before: Awaited<ReturnType<typeof snapshot>>;
    let relaunchedAt: number;
    let calls: number;
    test.afterAll(async () => {
      retainedSession = false;
      for (const context of active) await context.close();
      active.clear();
      server.release("portal");
      server.release("report");
    });
    test("capture the boundary and relaunch the same profile", async () => {
      retainedSession = true;
      const first = await launchCoordinator(bundles.get("operation")!);
      active.add(first.context);
      await pair(first.context, first.worker);
      calls = server.portalCalls.length;
      const reports = server.reports.length;
      if (boundary === "portal-held") server.hold("portal");
      if (boundary === "report-held") server.hold("report");
      if (boundary === "receipt-before-report")
        await first.worker.evaluate(() => {
          globalThis.__connectorHarness.observation.arm({ phase: "receipt-captured", side: "committed" });
        });
      server.claims.push(syntheticClaim());
      await wake(first.worker);
      await expect.poll(() => server.portalCalls.length).toBe(calls + 1);
      if (boundary !== "portal-held")
        await expect
          .poll(async () => (await snapshot(first.worker)).members[0]?.state)
          .toBe(boundary === "report-held" ? "reported" : "receipt-captured");
      before = await snapshot(first.worker);
      await first.context.close();
      active.delete(first.context);
      server.release("portal");
      server.release("report");
      relaunchedAt = Date.now();
      second = await launchCoordinator(bundles.get("operation")!, first.profile);
      active.add(second.context);
      retain(`restart-${boundary}-initial`, { before, after: await snapshot(second.worker) });
      await expect.poll(async () => (await snapshot(second.worker)).reservations[0]?.phase).toBe("acked");
      expect(server.portalCalls.length).toBe(calls + 1);
      if (boundary === "portal-held") expect(server.report(reports).outcomes[0]?.outcome.kind).toBe("outcome-unknown");
      if (boundary === "report-held") expect(server.reports[reports + 1]).toBe(server.reports[reports]);
    });
    for (let segment = 1; segment <= 4; segment++)
      test(`observe qualified alarm window segment ${segment}`, async () => {
        await observeUntil(() => false, Math.max(1, Math.min(20000, qualifiedWindowMs - (Date.now() - relaunchedAt))));
        expect(server.portalCalls.length).toBe(calls + 1);
      });
    test("record actual install reasons, retained journal and re-created alarm fire", async () => {
      const after = await snapshot(second.worker);
      const alarmRefired = after.observation.alarmFires.some(
        (alarm) => alarm.name === "connector-work" && alarm.at >= relaunchedAt,
      );
      expect(alarmRefired).toBe(true);
      expect(Date.now() - relaunchedAt).toBeGreaterThanOrEqual(qualifiedWindowMs);
      retain(`connector-coordinator-restart-${boundary}`, {
        before,
        after,
        relaunchedAt,
        alarmRefired,
        installReasons: after.observation.reasons,
      });
      expect(after.observation.reasons.length).toBeGreaterThan(0);
    });
  });
}

for (const unit of ["operation", "reservation"] as const) {
  for (const side of ["pending", "committed"] as const) {
    test(`connector-coordinator-proof-to-receipt-chromium ${unit} ${side} @tcgplayer-connector-extension-authority`, async () => {
      const f = await launchCoordinator(bundles.get(unit)!);
      active.add(f.context);
      await pair(f.context, f.worker);
      await f.worker.evaluate(() => Reflect.set(globalThis, "__connectorSyntheticReceiptLoss", true));
      server.claims.push(syntheticClaim());
      await wake(f.worker);
      await expect.poll(async () => (await snapshot(f.worker)).members[0]?.state).toBe("outcome-unknown");
      const before = await snapshot(f.worker);
      await f.worker.evaluate((side) => {
        Reflect.set(globalThis, "__connectorSyntheticReceiptLoss", false);
        Reflect.set(globalThis, "__connectorSyntheticProof", true);
        globalThis.__connectorHarness.observation.arm({ phase: "receipt-captured", side });
      }, side);
      await wake(f.worker);
      await expect.poll(async () => (await snapshot(f.worker)).observation.interrupted).toBe(true);
      const interrupted = await snapshot(f.worker);
      await wake(f.worker);
      await expect.poll(async () => (await snapshot(f.worker)).members[0]?.state).toBe("acked");
      expect(server.portalCalls).toHaveLength(1);
      retain(`proof-to-receipt-${unit}-${side}`, { before, interrupted, after: await snapshot(f.worker) });
    });
    for (const transition of ["redelivery-retirement", "acked-compaction"] as const) {
      test(`connector-coordinator-day-after-chromium ${unit} ${transition} ${side} @tcgplayer-connector-extension-authority`, async () => {
        const f = await launchCoordinator(bundles.get(unit)!);
        active.add(f.context);
        await pair(f.context, f.worker);
        if (transition === "redelivery-retirement")
          await f.worker.evaluate(() =>
            globalThis.__connectorHarness.observation.arm({ phase: "dispatched", side: "pending" }),
          );
        const claim = syntheticClaim();
        server.claims.push(claim);
        await wake(f.worker);
        await expect
          .poll(async () => (await snapshot(f.worker)).members[0]?.state)
          .toBe(transition === "acked-compaction" ? "acked" : "prepared");
        const before = await snapshot(f.worker);
        const future = Date.now() + (transition === "acked-compaction" ? 86400001 : 1800001);
        const next = syntheticClaim(future);
        const newer = {
          ...next,
          reservationId: "synthetic-next-reservation",
          operations: next.operations.map((member) => ({
            ...member,
            attemptId: "synthetic-next-attempt",
            claimGeneration: 2,
          })),
        };
        if (transition === "redelivery-retirement") server.claims.push(newer);
        await f.worker.evaluate(
          ({ future, side }) => {
            Date.now = () => future;
            globalThis.__connectorHarness.observation.arm({ phase: "delete", side });
          },
          { future, side },
        );
        await wake(f.worker);
        await expect.poll(async () => (await snapshot(f.worker)).observation.interrupted).toBe(true);
        const interrupted = await snapshot(f.worker);
        if (transition === "redelivery-retirement" && side === "pending") server.claims.push(newer);
        await wake(f.worker);
        await expect
          .poll(async () => {
            const state = await snapshot(f.worker);
            return transition === "acked-compaction"
              ? state.members.length === 0
              : state.members[0]?.attemptId === "synthetic-next-attempt" && state.members[0]?.state === "acked";
          })
          .toBe(true);
        expect(server.portalCalls).toHaveLength(1);
        retain(`day-after-${unit}-${transition}-${side}`, { before, interrupted, after: await snapshot(f.worker) });
      });
    }
  }
  for (const phase of journalPhases) {
    for (const side of ["pending", "committed"] as const) {
      test(`connector-coordinator-boundary-inventory-chromium ${unit} ${phase} ${side} @tcgplayer-connector-extension-authority`, async () => {
        const f = await launchCoordinator(bundles.get(unit)!);
        active.add(f.context);
        await pair(f.context, f.worker);
        if (phase === "outcome-unknown")
          await f.worker.evaluate(() => Reflect.set(globalThis, "__connectorSyntheticReceiptLoss", true));
        await f.worker.evaluate((boundary) => globalThis.__connectorHarness.observation.arm(boundary), { phase, side });
        const calls = server.portalCalls.length;
        const claim = syntheticClaim();
        server.claims.push(claim);
        await wake(f.worker);
        await expect.poll(async () => (await snapshot(f.worker)).observation.interrupted).toBe(true);
        const before = await snapshot(f.worker);
        await f.worker.evaluate(() => Reflect.set(globalThis, "__connectorSyntheticReceiptLoss", false));
        if (!before.reservations.length) server.claims.push(claim);
        await wake(f.worker);
        await expect
          .poll(async () => (await snapshot(f.worker)).members[0]?.state)
          .toMatch(/^(acked|outcome-unknown)$/);
        const after = await snapshot(f.worker);
        expect(server.portalCalls.length - calls).toBeLessThanOrEqual(1);
        retain(`inventory-${unit}-${phase}-${side}`, { before, after });
      });
    }
  }
}
