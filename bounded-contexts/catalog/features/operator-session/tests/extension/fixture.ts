import { vi } from "vitest";
import { createOperatorBackground, type OperatorAdapters } from "../../domain/extension/background";
import {
  operatorCookieName,
  type OperatorCommand,
  type OperatorCookie,
  type OperatorEnvironment,
} from "../../domain/extension/protocol";
import { isOperatorRecord, operatorRecordKey } from "../../domain/extension/record";

// Synthetic only. Values are never real browser/account credentials.
export const syntheticGrant = "A".repeat(43);
export const syntheticGrantB = "B".repeat(42) + "A";
export const syntheticCookie = "SYNTHETIC_OPERATOR_COOKIE_CANARY";
export const extensionId = "ghemdloifdkoadnapmigabiekchlholm";
export const sender = {
  id: extensionId,
  origin: `chrome-extension://${extensionId}`,
  url: `chrome-extension://${extensionId}/popup.html`,
  hasTab: false,
};
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function fixture() {
  let now = Date.parse("2026-10-02T12:00:00.000Z");
  const data = new Map<string, unknown>();
  let cookie: OperatorCookie | null = {
    name: operatorCookieName,
    value: syntheticCookie,
    domain: ".tcgplayer.com",
    path: "/admin",
    storeId: "0",
  };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ outcome: "stored", revision: 1 }));
  const adapters: OperatorAdapters = {
    storage: {
      trust: vi.fn(async () => undefined),
      read: vi.fn(async (key) => data.get(key)),
      write: vi.fn(async (key, value) => {
        data.set(key, structuredClone(value));
      }),
    },
    readCookie: vi.fn(async () => cookie),
    schedule: vi.fn(async () => undefined),
    badge: vi.fn(async () => undefined),
    fetch: fetcher,
    now: () => now,
  };
  let background = createOperatorBackground(adapters);
  return {
    adapters,
    data,
    fetcher,
    get background() {
      return background;
    },
    command: (command: OperatorCommand) => background.receive(command, sender, extensionId),
    pair: (grant = syntheticGrant, environment: OperatorEnvironment = "staging") =>
      background.receive({ action: "pair", environment, grant }, sender, extensionId),
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    cookie: (next: OperatorCookie | null) => {
      cookie = next;
    },
    change: () => background.cookieChanged({ removed: false, cookie: cookie! }),
    restart: () => {
      background = createOperatorBackground(adapters);
      return background.resume();
    },
    record: (environment: OperatorEnvironment = "staging") => {
      const value = data.get(operatorRecordKey(environment));
      if (!isOperatorRecord(value, environment)) throw new Error("Expected owned test record");
      return value;
    },
  };
}
