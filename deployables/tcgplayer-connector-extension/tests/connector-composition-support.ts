import { vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { ConnectorExecutor, OperationUnit } from "@chase-sets/channels/client";
import { chromeFixture } from "./chrome-test-support";
import { connectorHostRegistry, platformOrigin } from "../__tests__/harness/origins";
import { createSyntheticPairingCode, synthetic } from "../e2e/loopback-platform";

const network = globalThis.fetch;
export async function compose(
  executors: readonly ConnectorExecutor[],
  indexedDB = new IDBFactory(),
  initial: Record<string, unknown> = {},
) {
  vi.resetModules();
  vi.doMock("../src/host-registry", () => ({ connectorHostRegistry }));
  const fixture = chromeFixture(initial);
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
  const { composeConnectorBackground } = await import("../src/compose");
  const product = composeConnectorBackground({ executors });
  await product.background.boot();
  if (Object.keys(initial).length === 0) await createSyntheticPairingCode(platformOrigin);
  return { fixture, indexedDB, product };
}

export async function journal(
  indexedDB: IDBFactory,
): Promise<{ reservations: OperationUnit["reservation"][]; members: OperationUnit["members"] }> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("connector-raw-exports");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const read = <T>(store: string): Promise<T[]> =>
      new Promise((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    return { reservations: await read("reservations"), members: await read("operation-attempts") };
  } finally {
    db.close();
  }
}
