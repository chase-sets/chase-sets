import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { composeConnectorBackground } from "../src/compose";
import { chromeFixture } from "./chrome-test-support";
import { startLoopback } from "../__tests__/harness/loopback";
import { syntheticClaim } from "../__tests__/harness/claim";
import { syntheticExecutor } from "../__tests__/harness/executors.harness";
import { connectorHostRegistry, platformOrigin } from "../__tests__/harness/origins";
import { createSyntheticPairingCode, synthetic } from "../e2e/loopback-platform";

type ConnectorExecutor = Parameters<typeof composeConnectorBackground>[0]["executors"][number];
type OperationUnit = Parameters<ConnectorExecutor["dispatchOnce"]>[0];
const composeWithoutCoordinatorPort = "../src/compose?coordinator-port-removed";

const network = globalThis.fetch;
let server: Awaited<ReturnType<typeof startLoopback>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock("../src/host-registry");
});

async function compose(
  executors: readonly ConnectorExecutor[],
  load: () => Promise<typeof import("../src/compose")> = () => import("../src/compose"),
) {
  vi.resetModules();
  vi.doMock("../src/host-registry", () => ({ connectorHostRegistry }));
  const fixture = chromeFixture();
  const indexedDB = new IDBFactory();
  vi.stubGlobal("indexedDB", indexedDB);
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("chrome", fixture.chrome);
  fixture.request.mockImplementation(network);
  vi.stubGlobal("fetch", fixture.request);
  vi.stubEnv("VITE_PLATFORM_API_URL", platformOrigin);
  vi.stubEnv("VITE_CONNECTOR_CLIENT_ID", synthetic.clientId);
  fixture.chrome.identity.launchWebAuthFlow.mockImplementation(async ({ url }) => {
    const reply = await network(url, {
      redirect: "manual",
      headers: { Cookie: `${synthetic.cookieName}=${synthetic.cookieValue}` },
    });
    return reply.headers.get("location")!;
  });
  const { composeConnectorBackground } = await load();
  const product = composeConnectorBackground({ executors });
  await product.background.boot();
  await createSyntheticPairingCode(platformOrigin);
  await fixture.click();
  expect((await product.background.status()).state).toBe("paired-idle");
  return { fixture, indexedDB, product };
}

async function reservations(indexedDB: IDBFactory): Promise<OperationUnit["reservation"][]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("connector-raw-exports");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("reservations").objectStore("reservations").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

describe("connector-coordinator-loopback-production-path", () => {
  it.each(["operation", "reservation"] as const)(
    "pairs then alarm/claim/%s portal/report/ack through production compose",
    async (unit) => {
      server = await startLoopback();
      const f = await compose([syntheticExecutor(unit)]);
      server.claims.push(syntheticClaim());
      await f.fixture.alarm("connector-work");
      expect(server.portalCalls).toHaveLength(1);
      expect(server.report().outcomes[0]?.outcome.kind).toBe("applied");
      expect((await reservations(f.indexedDB))[0]?.phase).toBe("acked");
      await f.fixture.alarm("connector-work");
      expect(server.portalCalls).toHaveLength(1);
      expect(server.platform.observation()).toMatchObject({
        authorizeCount: 1,
        tokenCount: 1,
        tokenClosed: true,
        queryClosed: true,
      });
    },
  );
  it("empty product executor registry abandons and pauses unsupported work", async () => {
    server = await startLoopback();
    const { connectorExecutors } = await import("../src/executors");
    const f = await compose(connectorExecutors);
    server.claims.push(syntheticClaim());
    await f.fixture.alarm("connector-work");
    expect(server.portalCalls).toHaveLength(0);
    expect(server.report().outcomes[0]?.outcome.kind).toBe("abandoned");
    expect(await f.product.background.status()).toMatchObject({
      state: "paused",
      pauseReason: "unsupported-operation",
    });
  });
  it("removed coordinator port has zero claims and kills the path witness", async () => {
    server = await startLoopback();
    const f = await compose(
      [syntheticExecutor("operation")],
      () => import(/* @vite-ignore */ composeWithoutCoordinatorPort),
    );
    server.claims.push(syntheticClaim());
    await f.fixture.alarm("connector-work");
    expect(server.claimCount()).toBe(0);
    expect(() => expect(server!.portalCalls).toHaveLength(1)).toThrow();
  });
});
