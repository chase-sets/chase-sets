import { describe, expect, it, vi } from "vitest";
import { backgroundFixture } from "./connector-background-test-support";
import { extensionProfileStates } from "../domain/extension-records";
import { extensionCredentialKey, extensionProfileKey, profile, deferred, now, wire } from "./extension-test-support";
import { pairingSessionKey, pollWindow } from "../domain/connector-pairing";
import { TCGPLAYER_CONNECTOR_REDIRECT_URI } from "../domain/identity";

describe("extension-security-day-after", () => {
  it("pairing session-write failure ends pairing without opening authorization", async () => {
    const f = backgroundFixture("unpaired");
    vi.mocked(f.session.ports.local.set).mockRejectedValueOnce(new Error("session write failed"));
    await f.command("start-pairing");
    expect((await f.background.status()).state).toBe("unpaired");
    expect(f.ports.identity.launchWebAuthFlow).not.toHaveBeenCalled();
    expect(f.ports.transport.request).not.toHaveBeenCalled();
    expect(f.session.rows()[pairingSessionKey]).toBeUndefined();
  });
  it("credential transport refuses redirects rather than forwarding credentials", async () => {
    const f = backgroundFixture("unpaired");
    await f.command("start-pairing");
    await f.command("unpair");
    const requests = vi.mocked(f.ports.transport.request).mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.redirect).toBe("error");
  });
  it("pending action is a no-op and restart fences a late successful authorization", async () => {
    const f = backgroundFixture("unpaired");
    const callback = deferred<string>();
    let state = "";
    vi.mocked(f.ports.identity.launchWebAuthFlow).mockImplementation(({ url }) => {
      state = new URL(url).searchParams.get("state")!;
      return callback.promise;
    });
    const pairing = f.click();
    await vi.waitFor(() => expect(f.ports.identity.launchWebAuthFlow).toHaveBeenCalledTimes(1));
    await f.click();
    expect(f.ports.identity.launchWebAuthFlow).toHaveBeenCalledTimes(1);
    await f.startup();
    callback.resolve(`${TCGPLAYER_CONNECTOR_REDIRECT_URI}?code=late&state=${state}`);
    await pairing;
    expect((await f.background.status()).state).toBe("unpaired");
    expect(f.ports.transport.request).not.toHaveBeenCalled();
    expect(f.session.rows()[pairingSessionKey]).toBeUndefined();
  });
  it("session cleanup failure stays non-paired with retention, never revocation retry", async () => {
    const f = backgroundFixture("paired-idle");
    vi.mocked(f.session.ports.local.remove).mockRejectedValueOnce(new Error("session failure"));
    await f.command("unpair");
    expect((await f.background.status()).state).toBe("cleanup-pending");
    expect(f.fake.rows()[extensionCredentialKey]).toBeUndefined();
    expect(f.alarms.has("connector-revocation-retry")).toBe(false);
    expect(f.alarms.has("connector-retention-deadline")).toBe(true);
    await f.alarm("connector-retention-deadline");
    expect((await f.background.status()).state).toBe("unpaired");
    expect(f.ports.transport.request).toHaveBeenCalledTimes(1);
  });
  it("failed credential-key deletion stays cleanup-pending and retries without network", async () => {
    const f = backgroundFixture("paired-idle");
    vi.mocked(f.fake.ports.local.remove).mockRejectedValueOnce(new Error("disk failure"));
    await f.command("unpair");
    expect((await f.background.status()).state).toBe("cleanup-pending");
    expect(f.fake.rows()[extensionCredentialKey]).toBeNull();
    expect(f.alarms.has("connector-retention-deadline")).toBe(true);
    await f.alarm("connector-retention-deadline");
    expect((await f.background.status()).state).toBe("unpaired");
    expect(f.fake.rows()[extensionCredentialKey]).toBeUndefined();
    expect(f.ports.transport.request).toHaveBeenCalledTimes(1);
  });
  it("callback pin is byte-exact, not URL-normalized", async () => {
    const f = backgroundFixture("unpaired");
    vi.mocked(f.ports.identity.launchWebAuthFlow).mockImplementation(
      async ({ url }) =>
        `${TCGPLAYER_CONNECTOR_REDIRECT_URI.replace(".org/", ".org:443/")}?code=x&state=${new URL(url).searchParams.get("state")}`,
    );
    await f.command("start-pairing");
    expect((await f.background.status()).state).toBe("unpaired");
    expect(f.ports.transport.request).not.toHaveBeenCalled();
  });
  it("first install is unpaired with no credential or work alarm", async () => {
    const f = backgroundFixture();
    await f.installed();
    expect((await f.background.status()).state).toBe("unpaired");
    expect(f.fake.rows()[extensionCredentialKey]).toBeUndefined();
    expect(f.alarms.has("connector-work")).toBe(false);
  });
  for (const entry of ["install", "update", "startup"] as const) {
    it.each(extensionProfileStates)(`${entry} retains or reconciles %s without reset`, async (state) => {
      const f = backgroundFixture(state);
      if (state === "unpairing") vi.mocked(f.ports.transport.request).mockRejectedValue(new Error("offline"));
      const before = f.fake.rows();
      if (entry === "startup") await f.startup();
      else await f.installed(entry);
      const after = await f.background.status();
      const expected = state === "pairing-pending" || state === "cleanup-pending" ? "unpaired" : state;
      expect(after.state).toBe(expected);
      if (["paired-idle", "paused", "unpairing", "upgrade-required"].includes(state))
        expect(f.fake.rows()).toEqual(before);
      expect(f.ports.transport.coordinate).not.toHaveBeenCalled();
      expect(f.ports.transport.request).toHaveBeenCalledTimes(state === "unpairing" ? 1 : 0);
      if (state === "unpairing") expect(f.alarms.has("connector-revocation-retry")).toBe(true);
      if (state === "upgrade-required") {
        expect(f.fake.deletes()).toBe(0);
        expect(f.ports.alarms.clear).not.toHaveBeenCalled();
        expect(f.ports.alarms.create).not.toHaveBeenCalled();
      }
    });
  }
  for (const name of ["connector-work", "connector-revocation-retry", "connector-retention-deadline"]) {
    it.each(extensionProfileStates)(`${name} admits only its own work in %s`, async (state) => {
      const f = backgroundFixture(state);
      vi.mocked(f.ports.transport.request).mockRejectedValue(new Error("offline"));
      await f.alarm(name);
      expect(f.ports.transport.coordinate).toHaveBeenCalledTimes(
        name === "connector-work" && state === "paired-idle" ? 1 : 0,
      );
      expect(f.ports.transport.request).toHaveBeenCalledTimes(
        name === "connector-revocation-retry" && state === "unpairing" ? 1 : 0,
      );
      if (state === "upgrade-required") {
        expect(f.fake.writes()).toBe(0);
        expect(f.fake.deletes()).toBe(0);
        expect(f.ports.sweep.run).not.toHaveBeenCalled();
        expect(f.ports.alarms.create).not.toHaveBeenCalled();
        expect(f.ports.alarms.clear).not.toHaveBeenCalled();
      }
    });
  }
  it.each(extensionProfileStates)("action follows the closed click row for %s", async (state) => {
    const f = backgroundFixture(state);
    await f.click();
    if (["unpaired", "re-pair-required", "revoked"].includes(state)) {
      expect(f.ports.identity.launchWebAuthFlow).toHaveBeenCalledTimes(1);
      expect((await f.background.status()).state).toBe("paired-idle");
    } else {
      expect(f.ports.identity.launchWebAuthFlow).not.toHaveBeenCalled();
      expect(f.ports.action.openPage).toHaveBeenCalledTimes(state === "pairing-pending" ? 0 : 1);
      if (state !== "pairing-pending")
        expect(f.ports.action.openPage).toHaveBeenCalledWith(
          `https://chase.example/account/channels${["paired-idle", "paused", "unpairing"].includes(state) ? "/connection_A" : ""}`,
        );
      expect(f.fake.writes()).toBe(0);
      expect(f.fake.deletes()).toBe(0);
      expect(f.ports.alarms.clear).not.toHaveBeenCalled();
      expect(f.ports.alarms.create).not.toHaveBeenCalled();
      expect(f.ports.transport.request).not.toHaveBeenCalled();
    }
  });
  it("pause clears only work; retention sweeps cannot undo operator pause; resume recreates work", async () => {
    const f = backgroundFixture("paired-idle");
    const deadline = Date.parse(now) + 90_000;
    vi.mocked(f.ports.sweep.run).mockResolvedValue({ ok: true, nextDeadline: deadline });
    await f.alarm("connector-work");
    await f.command("pause");
    expect(f.alarms.get("connector-retention-deadline")).toEqual({ when: deadline });
    await f.alarm("connector-retention-deadline");
    expect((await f.background.status()).pauseReason).toBe("operator");
    await f.command("resume");
    expect((await f.background.status()).state).toBe("paired-idle");
    expect(f.alarms.get("connector-work")).toEqual({ periodInMinutes: 0.5 });
  });
  it("sweep failure pauses before coordinator and successful cleanup recovers only cleanup-failed", async () => {
    const f = backgroundFixture("paired-idle");
    vi.mocked(f.ports.sweep.run).mockResolvedValueOnce({ ok: false, nextDeadline: null });
    await f.alarm("connector-work");
    expect(await f.background.status()).toMatchObject({ state: "paused", pauseReason: "cleanup-failed" });
    expect(f.ports.transport.coordinate).not.toHaveBeenCalled();
    await f.alarm("connector-retention-deadline");
    expect((await f.background.status()).state).toBe("paired-idle");
    expect(f.alarms.has("connector-work")).toBe(true);
  });
  it("unpair advances revision and clears work before revoke; retry is bounded and never coordinates", async () => {
    const f = backgroundFixture("paired-idle");
    const response = deferred<Response>();
    const atRevoke: { profile: unknown; workScheduled: boolean }[] = [];
    vi.mocked(f.ports.transport.request).mockImplementation(async () => {
      atRevoke.push({ profile: f.fake.rows()[extensionProfileKey], workScheduled: f.alarms.has("connector-work") });
      return response.promise;
    });
    const pending = f.command("unpair");
    await vi.waitFor(() => expect(f.ports.transport.request).toHaveBeenCalledTimes(1));
    expect(atRevoke).toMatchObject([{ profile: { state: "unpairing", revision: 2 }, workScheduled: false }]);
    response.reject(new Error("offline"));
    await pending;
    expect((await f.background.status()).state).toBe("unpairing");
    vi.mocked(f.ports.transport.request).mockRejectedValue(new Error("offline"));
    for (let i = 0; i < 10; i++) await f.alarm("connector-revocation-retry");
    expect(f.alarms.get("connector-revocation-retry")).toEqual({ when: Date.parse(now) + 3_600_000 });
    expect(f.ports.transport.coordinate).not.toHaveBeenCalled();
    vi.mocked(f.ports.transport.request).mockResolvedValue(Response.json({ revoked: true }));
    await f.alarm("connector-revocation-retry");
    expect((await f.background.status()).state).toBe("unpaired");
    expect(f.fake.rows()[extensionCredentialKey]).toBeUndefined();
    expect(f.alarms.has("connector-revocation-retry")).toBe(false);
  });
  it.each(["revoked", "invalid-credential"] as const)(
    "%s deletes credential before raw sweep, cleanup never regains authority",
    async (outcome) => {
      const f = backgroundFixture("paired-idle");
      const credentialsAtSweep: unknown[] = [];
      vi.mocked(f.ports.transport.coordinate!).mockResolvedValue({ outcome });
      vi.mocked(f.ports.sweep.run).mockImplementation(async ({ deleteAll }) => {
        if (deleteAll) credentialsAtSweep.push(f.fake.rows()[extensionCredentialKey]);
        return { ok: !deleteAll, nextDeadline: null };
      });
      await f.alarm("connector-work");
      expect(credentialsAtSweep).toEqual([undefined]);
      expect((await f.background.status()).state).toBe("cleanup-pending");
      await f.command("resume");
      await f.command("start-pairing");
      expect(f.ports.identity.launchWebAuthFlow).not.toHaveBeenCalled();
      vi.mocked(f.ports.sweep.run).mockResolvedValue({ ok: true, nextDeadline: null });
      await f.startup();
      expect((await f.background.status()).state).toBe("unpaired");
      expect(f.ports.transport.coordinate).toHaveBeenCalledTimes(1);
    },
  );
  it("membership refusal is not revocation", async () => {
    const f = backgroundFixture("paired-idle");
    const before = f.fake.rows();
    vi.mocked(f.ports.transport.coordinate!).mockResolvedValue({ outcome: "authorization-refused" });
    await f.alarm("connector-work");
    expect(f.fake.rows()).toEqual(before);
  });
  it("late work and revoke responses cannot cross the revision/version fence", async () => {
    const f = backgroundFixture("paired-idle");
    const response = deferred<{ outcome: "revoked" }>();
    vi.mocked(f.ports.transport.coordinate!).mockReturnValue(response.promise);
    const pending = f.alarm("connector-work");
    await vi.waitFor(() => expect(f.ports.transport.coordinate).toHaveBeenCalled());
    await f.command("pause");
    response.resolve({ outcome: "revoked" });
    await pending;
    expect((await f.background.status()).state).toBe("paused");
    const revoke = deferred<Response>();
    vi.mocked(f.ports.transport.request).mockReturnValue(revoke.promise);
    const unpair = f.command("unpair");
    await vi.waitFor(() => expect(f.ports.transport.request).toHaveBeenCalled());
    await f.fake.ports.local.set({ [extensionProfileKey]: { schemaVersion: 2 } });
    const writes = f.fake.writes(),
      deletes = f.fake.deletes();
    vi.mocked(f.ports.alarms.clear).mockClear();
    revoke.resolve(Response.json({ revoked: true }));
    await unpair;
    expect(f.fake.writes()).toBe(writes);
    expect(f.fake.deletes()).toBe(deletes);
    expect(f.ports.alarms.clear).not.toHaveBeenCalled();
  });
  it("newer records freeze every entry, command and alarm, and update rechecks the version", async () => {
    const f = backgroundFixture("paired-idle");
    await f.fake.ports.local.set({ [extensionCredentialKey]: { schemaVersion: 2, secret: "do-not-delete" } });
    const writes = f.fake.writes();
    await f.installed();
    await f.installed("update");
    await f.startup();
    for (const type of ["start-pairing", "pause", "resume", "unpair", "status"] as const) await f.command(type);
    for (const name of ["connector-work", "connector-revocation-retry", "connector-retention-deadline"])
      await f.alarm(name);
    expect((await f.background.status()).state).toBe("upgrade-required");
    expect(f.fake.writes()).toBe(writes);
    expect(f.fake.deletes()).toBe(0);
    expect(f.ports.alarms.create).not.toHaveBeenCalled();
    expect(f.ports.alarms.clear).not.toHaveBeenCalled();
    expect(f.ports.transport.request).not.toHaveBeenCalled();
    expect(f.ports.sweep.run).not.toHaveBeenCalled();
    await f.fake.ports.local.set({ [extensionProfileKey]: profile("unpaired"), [extensionCredentialKey]: null });
    await f.installed("update");
    expect((await f.background.status()).state).toBe("unpaired");
  });
  it("malformed owned v1 migrates locally, drops credential and keeps only retention", async () => {
    const f = backgroundFixture("paired-idle");
    await f.fake.ports.local.set({ [extensionProfileKey]: { ...profile(), extra: true } });
    await f.installed("update");
    expect((await f.background.status()).state).toBe("re-pair-required");
    expect(f.fake.rows()[extensionCredentialKey]).toBeUndefined();
    expect(f.ports.transport.request).not.toHaveBeenCalled();
  });
  it.each([1, 29, 30, 60, 3600])("served window %i uses only an upward Chrome clamp", async (seconds) => {
    const f = backgroundFixture("paired-idle");
    vi.mocked(f.ports.transport.coordinate!).mockResolvedValue({ outcome: "ok", pollWindowSeconds: seconds });
    await f.alarm("connector-work");
    expect(await f.background.status()).toMatchObject({
      pollWindowSeconds: Math.max(30, seconds),
      pollWindowClamped: seconds < 30,
    });
    expect(f.alarms.get("connector-work")?.periodInMinutes).toBe(Math.max(30, seconds) / 60);
  });
  it("#7994-default parity is sixty seconds and wire bounds are unchanged", () => {
    // #7994 binding r2 annex, issuecomment-5979025305: 60 default, wire 1..3600.
    expect(pollWindow()).toEqual({ seconds: 60, clamped: false });
    for (const value of [0, 3601, 1.5, NaN]) expect(() => pollWindow(value)).toThrow();
  });
  it("successful unpair clears an earlier retained deadline as well as work and retry", async () => {
    const f = backgroundFixture("paired-idle");
    vi.mocked(f.ports.sweep.run).mockResolvedValueOnce({ ok: true, nextDeadline: Date.parse(now) + 90_000 });
    await f.alarm("connector-work");
    expect(f.alarms.has("connector-retention-deadline")).toBe(true);
    await f.command("unpair");
    expect(f.alarms.size).toBe(0);
  });
  it.each([
    "state",
    "redirect",
    "expiry",
    "identity",
    "second-connection",
    "pairing_code_missing",
    "pairing_code_ambiguous",
    "authorization_refused",
  ])("pairing %s refusal leaves no credential or ephemera", async (failure) => {
    const f = backgroundFixture("unpaired");
    vi.mocked(f.ports.identity.launchWebAuthFlow).mockImplementation(async ({ url }) => {
      const state = new URL(url).searchParams.get("state")!;
      if (failure === "expiry") f.setTime(Date.parse(now) + 600_000);
      if (failure === "redirect") return `https://evil.example/?code=x&state=${state}`;
      if (failure === "state") return `${TCGPLAYER_CONNECTOR_REDIRECT_URI}?code=x&state=wrong`;
      if (["pairing_code_missing", "pairing_code_ambiguous", "authorization_refused"].includes(failure))
        return `${TCGPLAYER_CONNECTOR_REDIRECT_URI}?${new URLSearchParams({ error: "access_denied", error_description: failure, state })}`;
      return `${TCGPLAYER_CONNECTOR_REDIRECT_URI}?code=x&state=${state}`;
    });
    if (failure === "identity" || failure === "second-connection") {
      const tokens: Record<string, unknown> = wire();
      if (failure === "identity") delete tokens.connection_id;
      else tokens.connection_id = ["connection_A", "connection_B"];
      vi.mocked(f.ports.transport.request).mockResolvedValue(Response.json(tokens));
    }
    await f.command("start-pairing");
    expect((await f.background.status()).state).toBe("unpaired");
    expect(f.fake.rows()[extensionCredentialKey]).toBeUndefined();
    expect(f.session.rows()[pairingSessionKey]).toBeUndefined();
    expect(f.alarms.has("connector-work")).toBe(false);
  });
});
