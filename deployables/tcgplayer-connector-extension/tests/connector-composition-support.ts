import { vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { composeConnectorBackground } from "../src/compose";
import { chromeFixture } from "./chrome-test-support";
import { connectorHostRegistry, platformOrigin } from "../__tests__/harness/origins";
import { createSyntheticPairingCode, synthetic } from "../e2e/loopback-platform";

type Registration = Parameters<typeof composeConnectorBackground>[0]["executors"];
type ConnectorExecutor = ReturnType<Registration>[number];
type OperationUnit = Parameters<ConnectorExecutor["dispatchOnce"]>[0];

const network = globalThis.fetch;
export async function compose(
  executors: readonly ConnectorExecutor[] | Registration,
  indexedDB = new IDBFactory(),
  initial: Record<string, unknown> = {},
  session: Record<string, unknown> = {},
) {
  return composeWith(
    async () => (typeof executors === "function" ? executors : () => executors),
    indexedDB,
    initial,
    session,
  );
}

/**
 * The product registration against a labelled synthetic provider origin. It is loaded after the module reset,
 * so the executor shares the composition's module graph (and its error classes) exactly as one bundle does.
 */
export function composeProduct(
  providerOrigin: string,
  indexedDB = new IDBFactory(),
  initial: Record<string, unknown> = {},
  session: Record<string, unknown> = {},
) {
  return composeWith(
    async () => {
      const { connectorExecutors } = await import("../src/executors");
      return (ports) => connectorExecutors({ ...ports, providerOrigin });
    },
    indexedDB,
    initial,
    session,
  );
}

async function composeWith(
  registration: () => Promise<Registration>,
  indexedDB: IDBFactory,
  initial: Record<string, unknown>,
  session: Record<string, unknown>,
) {
  vi.resetModules();
  vi.doMock("../src/host-registry", () => ({ connectorHostRegistry }));
  const fixture = chromeFixture(initial, session);
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
  const product = composeConnectorBackground({ executors: await registration() });
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
