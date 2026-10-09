import { vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TCGPLAYER_CONNECTOR_EXTENSION_ID, TCGPLAYER_CONNECTOR_REDIRECT_URI } from "@chase-sets/channels";

export const platformOrigin = "https://platform.example";
export const profileKey = "channel-connector-profile";
export const credentialKey = "channel-connector-credential";

export function retained(state: string, revision = 7) {
  const credential = ["paired-idle", "paused", "unpairing"].includes(state);
  return {
    [profileKey]: {
      schemaVersion: 1,
      revision,
      state,
      connectionId: credential ? "connection_A" : null,
      servedPollWindowSeconds: credential ? 60 : null,
      pauseReason: state === "paused" ? "operator" : null,
    },
    ...(credential
      ? {
          [credentialKey]: {
            schemaVersion: 1,
            issuer: platformOrigin,
            clientId: "cc_client_synthetic",
            connectionId: "connection_A",
            accessToken: "cc_at_synthetic-access-marker",
            refreshToken: "cc_rt_synthetic-refresh-marker",
            accessExpiresAt: "2099-01-01T00:00:00.000Z",
            rotatedAt: "2026-10-08T00:00:00.000Z",
            boundProfileRevision: revision,
            boundProfileState: state,
          },
        }
      : {}),
  };
}

export function chromeFixture(initial: Record<string, unknown> = {}) {
  const calls: string[] = [];
  function area(name: string, initialRows: Record<string, unknown>) {
    let trusted = false;
    const rows = structuredClone(initialRows);
    function use(operation: string) {
      calls.push(`${name}:${operation}`);
      if (!trusted) throw new Error(`${name}-untrusted`);
    }
    return {
      rows,
      setAccessLevel: vi.fn(async ({ accessLevel }: { accessLevel: string }) => {
        trusted = accessLevel === "TRUSTED_CONTEXTS";
        calls.push(`${name}:trusted`);
      }),
      get: vi.fn(async (keys: string[]) => {
        use("get");
        return structuredClone(Object.fromEntries(keys.filter((key) => key in rows).map((key) => [key, rows[key]])));
      }),
      set: vi.fn(async (values: Record<string, unknown>) => {
        use("set");
        Object.assign(rows, structuredClone(values));
      }),
      remove: vi.fn(async (keys: string[]) => {
        use("remove");
        for (const key of keys) delete rows[key];
      }),
    };
  }
  function event<T extends (...args: never[]) => unknown>() {
    const listeners: T[] = [];
    return {
      listeners,
      addListener: vi.fn((listener: T) => {
        listeners.push(listener);
      }),
    };
  }
  const local = area("local", initial);
  const session = area("session", {});
  const alarmRows = new Map<string, unknown>();
  const chrome = {
    storage: { local, session },
    runtime: {
      id: TCGPLAYER_CONNECTOR_EXTENSION_ID,
      onInstalled: event<(details: { reason: string }) => Promise<void>>(),
      onStartup: event<() => Promise<void>>(),
      onMessage: { addListener: vi.fn() },
    },
    action: {
      onClicked: event<() => Promise<void>>(),
      setBadgeText: vi.fn(async (_input: unknown) => {}),
      setTitle: vi.fn(async (_input: unknown) => {}),
    },
    tabs: { create: vi.fn(async (_input: unknown) => ({})) },
    alarms: {
      get: vi.fn(async (name: string) => alarmRows.get(name)),
      onAlarm: event<(alarm: { name: string }) => Promise<void>>(),
      create: vi.fn(async (name: string, schedule: unknown) => {
        calls.push("alarm:create");
        alarmRows.set(name, schedule);
      }),
      clear: vi.fn(async (name: string) => {
        calls.push("alarm:clear");
        return alarmRows.delete(name);
      }),
    },
    identity: {
      launchWebAuthFlow: vi.fn(
        async ({ url }: { url: string; interactive: boolean }) =>
          `${TCGPLAYER_CONNECTOR_REDIRECT_URI}?${new URLSearchParams({ code: "synthetic-code", state: new URL(url).searchParams.get("state")! })}`,
      ),
    },
  };
  const request = vi.fn(async (_request: Request) => Response.json({ error: "unavailable" }, { status: 503 }));
  return {
    chrome,
    local,
    session,
    calls,
    alarmRows,
    request,
    click: () => chrome.action.onClicked.listeners[0]!(),
    installed: (reason: string) => chrome.runtime.onInstalled.listeners[0]!({ reason }),
    startup: () => chrome.runtime.onStartup.listeners[0]!(),
    alarm: (name: string) => chrome.alarms.onAlarm.listeners[0]!({ name }),
  };
}

export async function loadBackground(fixture: ReturnType<typeof chromeFixture>) {
  vi.resetModules();
  vi.stubGlobal("chrome", fixture.chrome);
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("fetch", fixture.request);
  vi.stubEnv("VITE_PLATFORM_API_URL", platformOrigin);
  vi.stubEnv("VITE_CONNECTOR_CLIENT_ID", "cc_client_synthetic");
  const module = await import("../src/background");
  await module.boot;
  return module.background;
}
