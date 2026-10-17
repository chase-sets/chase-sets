import { randomUUID } from "node:crypto";
import { CHANNEL_CONNECTOR_SCOPE_FAMILY } from "@chase-sets/auth-context";
import { vi } from "vitest";
import {
  createExtensionCredentialCustody,
  extensionCredentialKey,
  extensionProfileKey,
  type ExtensionStoragePorts,
  type TrustedStorageArea,
} from "../domain/extension-credential-custody";
import { type ExtensionProfile, type ExtensionProfileState, credentialState } from "../domain/extension-records";

export const now = "2026-10-07T12:00:00.000Z";
export const binding = {
  issuer: "https://chase.example",
  clientId: "cc_client_synthetic",
  now,
  servedPollWindowSeconds: 30,
};
export function wire(connectionId = "connection_A") {
  return {
    access_token: `cc_at_synthetic_${randomUUID()}`,
    refresh_token: `cc_rt_synthetic_${randomUUID()}`,
    token_type: "Bearer",
    expires_in: 3600,
    scope: CHANNEL_CONNECTOR_SCOPE_FAMILY.scopes.join(" "),
    connection_id: connectionId,
  };
}
export function profile(state: ExtensionProfileState = "paired-idle", revision = 1): ExtensionProfile {
  return {
    schemaVersion: 1,
    revision,
    state,
    connectionId: credentialState(state) ? "connection_A" : null,
    servedPollWindowSeconds: credentialState(state) ? 30 : null,
    pauseReason: state === "paused" ? "operator" : null,
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
export function storage(initial: Record<string, unknown> = {}) {
  let rows = structuredClone(initial);
  const calls: string[] = [];
  let beforeSet: (() => Promise<void>) | null = null;
  const local: TrustedStorageArea = {
    setAccessLevel: vi.fn(async (options) => {
      if (options.accessLevel !== "TRUSTED_CONTEXTS") throw new Error("untrusted-access");
      calls.push("local:trusted");
    }),
    get: vi.fn(async (keys: readonly string[]) => {
      calls.push("local:get");
      const snapshot = structuredClone(
        Object.fromEntries(keys.filter((key) => Object.hasOwn(rows, key)).map((key) => [key, rows[key]])),
      );
      await new Promise<void>((done) => setImmediate(done));
      return snapshot;
    }),
    set: vi.fn(async (values) => {
      calls.push("local:set");
      await beforeSet?.();
      await new Promise<void>((done) => setImmediate(done));
      rows = { ...rows, ...structuredClone(values) };
    }),
    remove: vi.fn(async (keys) => {
      calls.push("local:remove");
      await new Promise<void>((done) => setImmediate(done));
      for (const key of keys) delete rows[key];
    }),
  };
  const session = {
    setAccessLevel: vi.fn(async () => {
      calls.push("session:trusted");
    }),
  };
  const ports: ExtensionStoragePorts = { local, session };
  const log = vi.fn<(code: "stale-response-discarded") => void>();
  const custody = createExtensionCredentialCustody(ports, log);
  return {
    ports,
    custody,
    log,
    calls,
    rows: () => structuredClone(rows),
    writes: () => vi.mocked(local.set).mock.calls.length,
    deletes: () => vi.mocked(local.remove).mock.calls.length,
    pauseSet: (hook: (() => Promise<void>) | null) => {
      beforeSet = hook;
    },
  };
}
export async function paired() {
  const fake = storage();
  await fake.custody.inspect();
  const start = await fake.custody.capture(null);
  await fake.custody.advance(start.fence, profile("pairing-pending"));
  const pending = await fake.custody.capture(null);
  await fake.custody.exchange(pending.fence, wire(), binding);
  return fake;
}
export { extensionCredentialKey, extensionProfileKey };
