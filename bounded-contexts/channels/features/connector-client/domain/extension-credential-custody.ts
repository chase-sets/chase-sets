import {
  boundCredential,
  connectorValue,
  credentialState,
  ExtensionCredentialError,
  parseExtensionProfile,
  safeRevision,
  type ExtensionCredential,
  type ExtensionProfile,
  type ExtensionProfileState,
} from "./extension-records";
import { admitConnectorTokens } from "./extension-token-codec";

export const extensionProfileKey = "channel-connector-profile";
export const extensionCredentialKey = "channel-connector-credential";
const keys = [extensionProfileKey, extensionCredentialKey];
export type TrustedStorageArea = Readonly<{
  setAccessLevel(options: Readonly<{ accessLevel: "TRUSTED_CONTEXTS" }>): Promise<void>;
  get(keys: readonly string[]): Promise<Record<string, unknown>>;
  set(values: Readonly<Record<string, unknown>>): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
}>;
export type ExtensionStoragePorts = Readonly<{
  local: TrustedStorageArea;
  session: Pick<TrustedStorageArea, "setAccessLevel">;
}>;
export type ExtensionFence = Pick<ExtensionProfile, "revision" | "state" | "connectionId">;
type Inspection =
  | Readonly<{ kind: "ready"; profile: ExtensionProfile }>
  | Readonly<{ kind: "upgrade-required" | "re-pair-required" }>;
type Stored = Readonly<{ profile: ExtensionProfile; credential: ExtensionCredential | null }>;
type CommitResult = "committed" | "stale-response-discarded" | "refused";
type Worker = { tail: Promise<void>; trusted: boolean };
const workers = new WeakMap<TrustedStorageArea, Worker>();

function nextRevision(revision: number): number {
  if (revision === Number.MAX_SAFE_INTEGER) throw new ExtensionCredentialError("revision-exhausted");
  return revision + 1;
}
function emptyProfile(state: ExtensionProfileState, revision: number): ExtensionProfile {
  return parseExtensionProfile({
    schemaVersion: 1,
    revision,
    state,
    connectionId: null,
    servedPollWindowSeconds: null,
    pauseReason: null,
  });
}
function sameFence(profile: ExtensionProfile, fence: ExtensionFence): boolean {
  return (
    profile.revision === fence.revision && profile.state === fence.state && profile.connectionId === fence.connectionId
  );
}
function ownedVersion(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "schemaVersion" in value &&
    value.schemaVersion === 1
  );
}
function stored(rows: Record<string, unknown>): Stored {
  const profile = parseExtensionProfile(rows[extensionProfileKey]);
  const value = rows[extensionCredentialKey];
  if (!credentialState(profile.state)) {
    if (value !== undefined && value !== null) throw new ExtensionCredentialError("invalid-record");
    return { profile, credential: null };
  }
  return { profile, credential: boundCredential(profile, value) };
}

// One worker owns the local area. All instances in that worker share this lock;
// the Chrome adapter must not introduce another writer to either owned key.
export function createExtensionCredentialCustody(
  ports: ExtensionStoragePorts,
  log: (code: "stale-response-discarded") => void = () => {},
) {
  let worker = workers.get(ports.local);
  if (!worker) {
    worker = { tail: Promise.resolve(), trusted: false };
    workers.set(ports.local, worker);
  }
  const owner = worker;
  function locked<T>(operation: () => Promise<T>): Promise<T> {
    const result = owner.tail.then(async () => {
      if (!owner.trusted) {
        await ports.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
        await ports.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
        owner.trusted = true;
      }
      return operation();
    });
    owner.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function publish(profile: ExtensionProfile, credential: ExtensionCredential | null) {
    // A single Chrome set publishes the pair. Null is a fail-closed transient
    // tombstone; successful terminal cleanup removes the credential key entirely.
    await ports.local.set({ [extensionProfileKey]: profile, [extensionCredentialKey]: credential });
    if (credential === null) await ports.local.remove([extensionCredentialKey]);
  }
  async function current(fence: ExtensionFence): Promise<Stored | null> {
    const rows = await ports.local.get(keys);
    let value: Stored;
    try {
      value = stored(rows);
    } catch {
      return null;
    }
    return sameFence(value.profile, fence) ? value : null;
  }
  function stale(): CommitResult {
    log("stale-response-discarded");
    return "stale-response-discarded";
  }
  return {
    inspect(): Promise<Inspection> {
      return locked(async () => {
        const rows = await ports.local.get(keys);
        const retained = keys.map((key) => rows[key]).filter((value) => value !== undefined && value !== null);
        if (retained.some((value) => !ownedVersion(value))) return { kind: "upgrade-required" };
        if (!retained.length) {
          const profile = emptyProfile("unpaired", 0);
          await publish(profile, null);
          return { kind: "ready", profile };
        }
        let value: Stored;
        try {
          value = stored(rows);
        } catch {
          const row = rows[extensionProfileKey];
          const revision =
            row && typeof row === "object" && "revision" in row && safeRevision(row.revision) ? row.revision : 0;
          const profile = {
            ...emptyProfile("re-pair-required", nextRevision(revision)),
            pauseReason:
              row && typeof row === "object" && "pauseReason" in row && row.pauseReason === "protocol-violation"
                ? ("protocol-violation" as const)
                : null,
          };
          await publish(profile, null);
          return { kind: "re-pair-required" };
        }
        if (rows[extensionCredentialKey] === null) await ports.local.remove([extensionCredentialKey]);
        return { kind: "ready", profile: value.profile };
      });
    },
    capture(
      connectionId: string | null,
    ): Promise<Readonly<{ fence: ExtensionFence; credential: ExtensionCredential | null }>> {
      return locked(async () => {
        const value = stored(await ports.local.get(keys));
        if (value.profile.connectionId !== connectionId) throw new ExtensionCredentialError("unavailable");
        return {
          fence: { revision: value.profile.revision, state: value.profile.state, connectionId },
          credential: value.credential,
        };
      });
    },
    advance(fence: ExtensionFence, next: Omit<ExtensionProfile, "schemaVersion" | "revision">): Promise<CommitResult> {
      return locked(async () => {
        const value = await current(fence);
        if (!value) return stale();
        const profile = parseExtensionProfile({
          ...next,
          schemaVersion: 1,
          revision: nextRevision(value.profile.revision),
        });
        const credential = credentialState(profile.state)
          ? value.credential &&
            boundCredential(profile, {
              ...value.credential,
              boundProfileRevision: profile.revision,
              boundProfileState: profile.state,
            })
          : null;
        if (credentialState(profile.state) && !credential) return "refused";
        await publish(profile, credential);
        return "committed";
      });
    },
    exchange(
      fence: ExtensionFence,
      response: unknown,
      binding: Readonly<{ issuer: string; clientId: string; now: string; servedPollWindowSeconds: number }>,
    ): Promise<CommitResult> {
      return locked(async () => {
        const value = await current(fence);
        if (!value) return stale();
        if (value.profile.state !== "pairing-pending" || value.credential) return "refused";
        let profile: ExtensionProfile;
        let credential: ExtensionCredential;
        try {
          const connectionId =
            response && typeof response === "object" && "connection_id" in response
              ? connectorValue(response.connection_id)
              : null;
          profile = parseExtensionProfile({
            schemaVersion: 1,
            revision: nextRevision(value.profile.revision),
            state: value.profile.pauseReason === "protocol-violation" ? "paused" : "paired-idle",
            connectionId,
            servedPollWindowSeconds: binding.servedPollWindowSeconds,
            pauseReason: value.profile.pauseReason === "protocol-violation" ? "protocol-violation" : null,
          });
          credential = admitConnectorTokens(response, profile, binding);
        } catch {
          return "refused";
        }
        await publish(profile, credential);
        return "committed";
      });
    },
    refresh(fence: ExtensionFence, response: unknown, now: string): Promise<CommitResult> {
      return locked(async () => {
        const value = await current(fence);
        if (!value) return stale();
        if (!value.credential) return "refused";
        let profile: ExtensionProfile;
        let credential: ExtensionCredential;
        try {
          profile = parseExtensionProfile({ ...value.profile, revision: nextRevision(value.profile.revision) });
          credential = admitConnectorTokens(response, profile, {
            issuer: value.credential.issuer,
            clientId: value.credential.clientId,
            previous: value.credential,
            now,
          });
        } catch {
          return "refused";
        }
        await publish(profile, credential);
        return "committed";
      });
    },
    // A transport refusal is not a revocation fact. In particular a concurrent
    // one-use refresh loser must never delete the winner's rotating credentials.
    refuse(fence: ExtensionFence): Promise<CommitResult> {
      return locked(async () => ((await current(fence)) ? "refused" : stale()));
    },
  };
}
