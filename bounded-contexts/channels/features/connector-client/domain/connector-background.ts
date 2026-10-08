import {
  acceptsConnectorSender,
  parseConnectorCommand,
  type ConnectorBackgroundPorts,
  type ConnectorCommand,
  type ConnectorStatus,
} from "./connector-background-contract";
import {
  createExtensionCredentialCustody,
  extensionProfileKey,
  extensionCredentialKey,
  type ExtensionFence,
} from "./extension-credential-custody";
import {
  boundCredential,
  credentialState,
  parseExtensionProfile,
  type ExtensionProfile,
  type ExtensionProfileState,
} from "./extension-records";
import {
  createPairingSession,
  pairingCode,
  pairingSessionKey,
  parsePairingSession,
  pollWindow,
} from "./connector-pairing";
import { TCGPLAYER_CONNECTOR_EXTENSION_ID, TCGPLAYER_CONNECTOR_REDIRECT_URI } from "./identity";

const workAlarm = "connector-work";
const retryAlarm = "connector-revocation-retry";
const retentionAlarm = "connector-retention-deadline";
const pairingStates = ["unpaired", "re-pair-required", "revoked"];

export function createConnectorBackground(ports: ConnectorBackgroundPorts) {
  const origin = new URL(ports.transport.platformOrigin);
  if (
    origin.origin !== ports.transport.platformOrigin ||
    origin.username ||
    origin.password ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) ||
    ports.runtime.id !== TCGPLAYER_CONNECTOR_EXTENSION_ID
  )
    throw new Error("connector-configuration-refused");
  const custody = createExtensionCredentialCustody({ local: ports.storage, session: ports.session });
  let tail: Promise<unknown> = Promise.resolve();
  let trusted = false;
  let clamped = false;
  let retrySeconds = 30;
  let retentionDeadline: number | null = null;
  let revoking = false;
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  }
  async function read(): Promise<ExtensionProfile | null> {
    if (!trusted) {
      await ports.storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      await ports.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      trusted = true;
    }
    const rows = await ports.storage.get([extensionProfileKey, extensionCredentialKey]);
    const retained = Object.values(rows).filter((value) => value != null);
    if (retained.some((value) => typeof value !== "object" || !("schemaVersion" in value) || value.schemaVersion !== 1))
      return null;
    if (!retained.length) return empty("unpaired");
    try {
      const profile = parseExtensionProfile(rows[extensionProfileKey]);
      if (profile.state === "upgrade-required") return null;
      if (credentialState(profile.state)) boundCredential(profile, rows[extensionCredentialKey]);
      else if (rows[extensionCredentialKey] != null) return empty("re-pair-required");
      return profile;
    } catch {
      return empty("re-pair-required");
    }
  }
  function empty(state: ExtensionProfileState): ExtensionProfile {
    return {
      schemaVersion: 1,
      revision: 0,
      state,
      connectionId: null,
      servedPollWindowSeconds: null,
      pauseReason: null,
    };
  }
  function dto(profile: ExtensionProfile | null): ConnectorStatus {
    return {
      state: profile?.state ?? "upgrade-required",
      connectionId: profile?.connectionId ?? null,
      pauseReason: profile?.pauseReason ?? null,
      pollWindowSeconds: profile?.servedPollWindowSeconds ?? null,
      pollWindowClamped: clamped && !!profile && credentialState(profile.state),
    };
  }
  async function status() {
    return dto(await read());
  }
  async function display() {
    const value = await status();
    await ports.action.setBadge(value);
    await ports.action.setTitle(value);
    return value;
  }
  async function current(fence: ExtensionFence) {
    const profile = await read();
    return profile &&
      profile.revision === fence.revision &&
      profile.state === fence.state &&
      profile.connectionId === fence.connectionId
      ? profile
      : null;
  }
  async function advance(
    profile: ExtensionProfile,
    state: ExtensionProfileState,
    pauseReason: ExtensionProfile["pauseReason"] = null,
  ) {
    return custody.advance(profile, credentialState(state) ? { ...profile, state, pauseReason } : empty(state));
  }
  async function work(profile: ExtensionProfile) {
    await ports.alarms.create(workAlarm, { periodInMinutes: (profile.servedPollWindowSeconds ?? 60) / 60 });
  }
  async function retention(next: number | null, failed: boolean) {
    const now = ports.clock.now();
    if (next !== null && (!Number.isFinite(next) || next < 0)) next = now + 30_000;
    if (failed) next = Math.min(next ?? Infinity, now + 30_000);
    if (retentionDeadline !== null && retentionDeadline > now) next = Math.min(next ?? Infinity, retentionDeadline);
    retentionDeadline = next;
    if (next === null) await ports.alarms.clear(retentionAlarm);
    else await ports.alarms.create(retentionAlarm, { when: Math.max(now, next) });
  }
  async function sweep(profile: ExtensionProfile, reason: "boot" | "work" | "unpair" | "retention", deleteAll = false) {
    let result: { ok: boolean; nextDeadline: number | null };
    try {
      result = await ports.sweep.run({ reason, deleteAll });
    } catch {
      result = { ok: false, nextDeadline: null };
    }
    if (!(await current(profile))) return false;
    if (deleteAll && result.ok) retentionDeadline = null;
    await retention(result.nextDeadline, !result.ok);
    if (!result.ok && ["paired-idle", "paused"].includes(profile.state)) {
      // An operator pause remains operator-owned even if cleanup also fails.
      await advance(profile, "paused", profile.pauseReason === "operator" ? "operator" : "cleanup-failed");
      await ports.alarms.clear(workAlarm);
    } else if (result.ok && profile.state === "paused" && profile.pauseReason === "cleanup-failed") {
      if ((await advance(profile, "paired-idle")) === "committed") await work((await read())!);
    }
    return result.ok;
  }
  async function cleanup(
    profile: ExtensionProfile,
    destination: "unpaired" | "revoked",
    reason: "boot" | "unpair" | "retention",
  ) {
    if (!(await current(profile))) return;
    let deletionFailed = false;
    if (profile.state !== "cleanup-pending") {
      try {
        if ((await advance(profile, "cleanup-pending")) !== "committed") return;
      } catch {
        deletionFailed = true;
      }
      const retained = await read();
      if (retained?.state !== "cleanup-pending") throw new Error("cleanup-unavailable");
      profile = retained;
    }
    await ports.alarms.clear(workAlarm);
    await ports.alarms.clear(retryAlarm);
    if (deletionFailed) {
      await retention(null, true);
      return;
    }
    try {
      // Custody removes a failed deletion's null tombstone without restoring authority.
      await custody.inspect();
      await ports.session.remove([pairingSessionKey]);
    } catch {
      await retention(null, true);
      return;
    }
    if (await sweep(profile, reason, true)) await advance(profile, destination);
  }
  async function revoke() {
    if (revoking) return;
    revoking = true;
    try {
      const captured = await serial(async () => {
        const profile = await read();
        if (!profile || profile.state !== "unpairing") return null;
        await ports.alarms.clear(workAlarm);
        return custody.capture(profile.connectionId);
      });
      if (!captured?.credential) return;
      let acknowledged = false;
      try {
        const response = await ports.transport.request(
          new Request(`${origin.origin}/channel-connector/oauth/revoke`, {
            method: "POST",
            redirect: "error",
            headers: {
              "Content-Type": "application/json",
              "X-Channel-Connection-Id": captured.credential.connectionId,
            },
            body: JSON.stringify({ token: captured.credential.accessToken }),
          }),
        );
        const body: unknown = await response.json();
        acknowledged = response.ok && !!body && typeof body === "object" && "revoked" in body && body.revoked === true;
        if (!response.ok && body && typeof body === "object" && "error" in body)
          acknowledged = body.error === "revoked" || body.error === "invalid-credential";
      } catch {
        /* A transport failure retains the credential for fenced revocation only. */
      }
      await serial(async () => {
        const profile = await current(captured.fence);
        if (!profile) return;
        if (acknowledged) {
          retrySeconds = 30;
          await cleanup(profile, "unpaired", "unpair");
        } else {
          await ports.alarms.create(retryAlarm, { when: ports.clock.now() + retrySeconds * 1000 });
          retrySeconds = Math.min(3600, retrySeconds * 2);
        }
        await display();
      });
    } finally {
      revoking = false;
    }
  }
  async function pair() {
    const pending = await serial(async () => {
      const profile = await read();
      if (!profile || !pairingStates.includes(profile.state)) return null;
      if ((await advance(profile, "pairing-pending")) !== "committed") return null;
      await ports.alarms.clear(workAlarm);
      const fence = (await custody.capture(null)).fence;
      try {
        const session = await createPairingSession(ports.clock.now());
        await ports.session.set({ [pairingSessionKey]: session });
        await display();
        return { fence, session };
      } catch {
        const pending = await current(fence);
        if (pending) await cleanup(pending, "unpaired", "unpair");
        await display();
        return null;
      }
    });
    if (!pending) return;
    try {
      const query = new URLSearchParams({
        response_type: "code",
        client_id: ports.transport.clientId,
        redirect_uri: TCGPLAYER_CONNECTOR_REDIRECT_URI,
        code_challenge: pending.session.challenge,
        code_challenge_method: "S256",
        state: pending.session.state,
      });
      const callback = await ports.identity.launchWebAuthFlow({
        url: `${origin.origin}/channel-connector/oauth/authorize?${query}`,
        interactive: true,
      });
      const input = await serial(async () => {
        if (!(await current(pending.fence))) return null;
        const session = parsePairingSession((await ports.session.get([pairingSessionKey]))[pairingSessionKey]);
        if (session.state !== pending.session.state || session.verifier !== pending.session.verifier)
          throw new Error("pairing-refused");
        const code = pairingCode(callback, session, ports.clock.now());
        await ports.session.remove([pairingSessionKey]);
        return {
          grant_type: "authorization_code",
          client_id: ports.transport.clientId,
          redirect_uri: TCGPLAYER_CONNECTOR_REDIRECT_URI,
          code,
          code_verifier: session.verifier,
        };
      });
      if (!input) return;
      const response = await ports.transport.request(
        new Request(`${origin.origin}/channel-connector/oauth/token`, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
      );
      if (!response.ok) throw new Error("pairing-refused");
      const tokens: unknown = await response.json();
      await serial(async () => {
        if (!(await current(pending.fence))) return;
        if (ports.clock.now() >= pending.session.expiresAt) throw new Error("pairing-refused");
        const result = await custody.exchange(pending.fence, tokens, {
          issuer: origin.origin,
          clientId: ports.transport.clientId,
          now: new Date(ports.clock.now()).toISOString(),
          servedPollWindowSeconds: pollWindow().seconds,
        });
        if (result !== "committed") throw new Error("pairing-refused");
        clamped = false;
        await work((await read())!);
        await display();
      });
    } catch {
      await serial(async () => {
        const profile = await current(pending.fence);
        if (!profile) return;
        await cleanup(profile, "unpaired", "unpair");
        await display();
      });
    }
  }
  async function command(command: ConnectorCommand) {
    if (command.type === "status") return status();
    if (command.type === "start-pairing") {
      await pair();
      return status();
    }
    await serial(async () => {
      const profile = await read();
      if (!profile) return;
      if (command.type === "pause" && profile.state === "paired-idle") {
        await advance(profile, "paused", "operator");
        await ports.alarms.clear(workAlarm);
      } else if (command.type === "resume" && profile.state === "paused") {
        if (!(await sweep(profile, "work"))) return;
        const next = await read();
        if (next?.state === "paused" && (await advance(next, "paired-idle")) === "committed")
          await work((await read())!);
      } else if (command.type === "unpair" && ["paired-idle", "paused"].includes(profile.state)) {
        await advance(profile, "unpairing");
        await ports.alarms.clear(workAlarm);
      }
      await display();
    });
    if (command.type === "unpair") await revoke();
    return status();
  }
  async function boot() {
    await serial(async () => {
      const retained = await read();
      if (retained?.state === "cleanup-pending") {
        await cleanup(retained, "unpaired", "boot");
        await display();
        return;
      }
      const inspected = await custody.inspect();
      if (inspected.kind === "upgrade-required") {
        await display();
        return;
      }
      const profile = (await read())!;
      if (!profile) {
        await display();
        return;
      }
      if (profile.state === "pairing-pending") {
        await cleanup(profile, "unpaired", "boot");
        await display();
        return;
      }
      if (profile.state === "cleanup-pending") await cleanup(profile, "unpaired", "boot");
      else {
        if (profile.state !== "paired-idle") await ports.alarms.clear(workAlarm);
        if (profile.state !== "unpairing") await ports.alarms.clear(retryAlarm);
        await sweep(profile, "boot", !credentialState(profile.state));
      }
      await display();
    });
    await revoke();
    return status();
  }
  async function alarm({ name }: Readonly<{ name: string }>) {
    if (name === retryAlarm) {
      await revoke();
      return;
    }
    const captured = await serial(async () => {
      const profile = await read();
      if (!profile || ![workAlarm, retentionAlarm].includes(name)) return null;
      if (name === retentionAlarm) {
        retentionDeadline = null;
        if (profile.state === "cleanup-pending") await cleanup(profile, "unpaired", "retention");
        else await sweep(profile, "retention", !credentialState(profile.state));
        await display();
        return null;
      }
      if (profile.state !== "paired-idle" || !(await sweep(profile, "work"))) return null;
      return custody.capture(profile.connectionId);
    });
    if (!captured?.credential || !ports.transport.coordinate) return;
    const result = await ports.transport.coordinate({
      connectionId: captured.credential.connectionId,
      accessToken: captured.credential.accessToken,
    });
    await serial(async () => {
      const profile = await current(captured.fence);
      if (!profile) return;
      if (result.outcome === "revoked" || result.outcome === "invalid-credential") {
        await cleanup(profile, "revoked", "unpair");
      } else if (result.outcome === "ok" && result.pollWindowSeconds !== undefined) {
        const window = pollWindow(result.pollWindowSeconds);
        if ((await custody.advance(profile, { ...profile, servedPollWindowSeconds: window.seconds })) === "committed") {
          clamped = window.clamped;
          await work((await read())!);
        }
      }
      await display();
    });
  }
  async function actionClick() {
    const profile = await read();
    if (profile && pairingStates.includes(profile.state)) await pair();
    else if (profile?.state !== "pairing-pending")
      await ports.action.openPage(
        `${origin.origin}/account/channels${profile?.connectionId ? `/${encodeURIComponent(profile.connectionId)}` : ""}`,
      );
  }
  ports.runtime.onInstalled(async () => {
    await boot();
  });
  ports.runtime.onStartup(async () => {
    await boot();
  });
  ports.runtime.onMessage(async (message, sender) => {
    const parsed = parseConnectorCommand(message);
    if (!parsed || !acceptsConnectorSender(sender, ports.runtime.id)) return { ok: false, error: "message-refused" };
    return { ok: true, status: await command(parsed) };
  });
  ports.alarms.onAlarm(alarm);
  ports.action.onClicked(actionClick);
  return { boot, status };
}
