import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConnectorManifest } from "@chase-sets/channels";
import type { composeConnectorBackground } from "../src/compose";
import { connectorExecutors } from "../src/executors";
import { exportSentinel, startLoopback } from "../__tests__/harness/loopback";
import { syntheticLiveExportClaim } from "../__tests__/harness/claim";
import { portalOrigin } from "../__tests__/harness/origins";
import { manifestInput } from "../vite.config";
import { compose, journal } from "./connector-composition-support";

type Registration = Parameters<typeof composeConnectorBackground>[0]["executors"];
/** The product registration against the labelled synthetic loopback provider. */
const liveExport: Registration = (ports) => connectorExecutors({ ...ports, providerOrigin: portalOrigin });

let server: Awaited<ReturnType<typeof startLoopback>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock("../src/host-registry");
});

async function paired(registration: Registration) {
  server = await startLoopback();
  const f = await compose(registration);
  await f.fixture.click();
  expect((await f.product.background.status()).state).toBe("paired-idle");
  return f;
}
async function rawCount(indexedDB: IDBFactory) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("connector-raw-exports");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<number>((resolve, reject) => {
      const request = db.transaction("raw-exports").objectStore("raw-exports").count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
type Call = readonly [RequestInfo | URL, RequestInit?];
function transport(calls: readonly Call[]) {
  const routes = calls.map(([input, init]) =>
    input instanceof Request
      ? `${input.method} ${new URL(input.url).pathname}`
      : `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`,
  );
  return {
    exports: routes.filter((route) => route === "GET /Admin/Pricing/DownloadMyExportCSV").length,
    ingests: routes.filter((route) => route.endsWith("/ingest")).length,
    reports: routes.filter((route) => route.endsWith("/report")).length,
  };
}

describe("tcgplayer-live-export-loopback-production-path", () => {
  it("claim, fetch, ciphertext write, parse, one export post, 202, raw removed, complete reported and acked", async () => {
    const f = await paired(liveExport);
    server!.claims.push(syntheticLiveExportClaim());
    await f.fixture.alarm("connector-work");
    expect(server!.claimBodies).toContainEqual({ capabilities: ["tcgplayer-live-export"] });
    expect(transport(f.fixture.request.mock.calls)).toEqual({ exports: 1, ingests: 1, reports: 1 });
    expect(server!.provider.exports).toBe(1);
    const posted = JSON.parse(server!.ingests[0]!);
    expect(posted).toMatchObject({ inboundKind: "export", payload: { parsed: { kind: "parsed", parsedRowCount: 3 } } });
    expect(posted.externalReference).toMatch(/^tcgx\.v1:[a-f0-9]{64}$/);
    expect(server!.report().outcomes[0]).toMatchObject({
      operationKind: "tcgplayer-live-export",
      outcome: { kind: "live-export-complete", parsedRowCount: 3, externalReference: posted.externalReference },
    });
    expect((await journal(f.indexedDB)).reservations.map(({ phase }) => phase)).toEqual(["acked"]);
    expect(await rawCount(f.indexedDB)).toBe(0);
    await f.fixture.alarm("connector-work");
    expect(transport(f.fixture.request.mock.calls)).toEqual({ exports: 1, ingests: 1, reports: 1 });
  });
  it("a capability-omitted claim gets no member and no post, failing the end-to-end witness", async () => {
    const f = await paired(liveExport);
    const network = f.fixture.request.getMockImplementation()!;
    // Wire-level mutant: the registered executor's capability never reaches the platform.
    f.fixture.request.mockImplementation(async (...args) => {
      const [input] = args;
      return input instanceof Request && input.url.endsWith("/claim")
        ? network(new Request(input, { body: "{}" }))
        : network(...args);
    });
    server!.claims.push(syntheticLiveExportClaim());
    await f.fixture.alarm("connector-work");
    expect(server!.withheld()).toBeGreaterThan(0);
    expect(transport(f.fixture.request.mock.calls)).toEqual({ exports: 0, ingests: 0, reports: 0 });
    expect(() => expect(server!.ingests).toHaveLength(1)).toThrow();
  });
  it("an unregistered client advertises nothing and receives no export member", async () => {
    const f = await paired(() => []);
    server!.claims.push(syntheticLiveExportClaim());
    await f.fixture.alarm("connector-work");
    expect(server!.claimBodies).toEqual(expect.arrayContaining([{}]));
    expect(server!.withheld()).toBeGreaterThan(0);
    expect(transport(f.fixture.request.mock.calls)).toEqual({ exports: 0, ingests: 0, reports: 0 });
  });
  it("a manual redirect through the real adapter is session-lost with zero target requests and no raw", async () => {
    const f = await paired(liveExport);
    server!.provider.reply = "redirect";
    server!.claims.push(syntheticLiveExportClaim());
    await f.fixture.alarm("connector-work");
    expect(server!.provider).toMatchObject({ exports: 1, signins: 0 });
    expect(server!.ingests).toEqual([]);
    expect(server!.report().outcomes[0]?.outcome).toMatchObject({
      kind: "live-export-unknown",
      reason: "session-lost",
    });
    expect(await rawCount(f.indexedDB)).toBe(0);
  });
  it("replay after a lost 202 reposts the identical reference once from the restarted worker", async () => {
    const f = await paired(liveExport);
    server!.loseNextIngest();
    server!.claims.push(syntheticLiveExportClaim());
    const lostWorker = f.fixture.alarm("connector-work");
    await vi.waitFor(() => expect(server!.ingests).toHaveLength(1), { timeout: 10_000 });
    // Worker restart: a fresh production composition over the same IndexedDB, profile and session-only keys.
    const restarted = await compose(liveExport, f.indexedDB, f.fixture.local.rows, f.fixture.session.rows);
    await restarted.fixture.alarm("connector-work");
    server!.dropLostIngests();
    await lostWorker;
    expect(server!.provider.exports).toBe(1);
    expect(server!.ingests).toHaveLength(2);
    expect(server!.ingests[1]).toBe(server!.ingests[0]);
    expect(server!.reports).toHaveLength(1);
    expect(server!.report().outcomes[0]?.outcome.kind).toBe("live-export-complete");
    expect((await journal(f.indexedDB)).reservations.map(({ phase }) => phase)).toEqual(["acked"]);
    expect(await rawCount(f.indexedDB)).toBe(0);
  });
  it("custody: permissions stay identity, storage, alarms and hosts equal the registry plus the platform", () => {
    const manifest = buildConnectorManifest(manifestInput);
    expect(manifest.permissions).toEqual(["identity", "storage", "alarms"]);
    expect(manifest.host_permissions).toEqual(
      [`${manifestInput.platformOrigin}/*`, "https://store.tcgplayer.com/*"].sort(),
    );
    expect(JSON.stringify(manifest)).not.toMatch(/downloads|cookies|<all_urls>|\*:\/\//);
    expect(exportSentinel).toMatch(/^SYNTHETIC_/);
  });
});
