import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chromeFixture,
  credentialKey,
  loadBackground,
  platformOrigin,
  profileKey,
  retained,
} from "./chrome-test-support";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("../src/adapters/chrome-session");
});

describe("extension-production-bootstrap-day-after", () => {
  it.each([
    "unpaired",
    "pairing-pending",
    "paired-idle",
    "paused",
    "unpairing",
    "revoked",
    "cleanup-pending",
    "re-pair-required",
    "upgrade-required",
  ])("boots retained %s through all real adapters", async (state) => {
    const fixture = chromeFixture(retained(state));
    const background = await loadBackground(fixture);
    const expected = ["pairing-pending", "cleanup-pending"].includes(state) ? "unpaired" : state;
    expect((await background.status()).state).toBe(expected);
    expect(fixture.calls.slice(0, 2)).toEqual(["local:trusted", "session:trusted"]);
    expect(fixture.chrome.runtime.onMessage.addListener).not.toHaveBeenCalled();
    expect(fixture.chrome.action.setTitle).toHaveBeenLastCalledWith({ title: expected });
    expect(fixture.chrome.action.onClicked.listeners).toHaveLength(1);
    expect(fixture.chrome.alarms.onAlarm.listeners).toHaveLength(1);
    if (state === "unpairing") expect(fixture.alarmRows.has("connector-revocation-retry")).toBe(true);
  });

  it.each(["paired-idle", "paused"])("preserves %s through install, update, startup and every alarm", async (state) => {
    const initial = retained(state);
    const fixture = chromeFixture(initial);
    const background = await loadBackground(fixture);
    for (const entry of [
      () => fixture.installed("install"),
      () => fixture.installed("update"),
      fixture.startup,
      ...["connector-work", "connector-revocation-retry", "connector-retention-deadline", "foreign"].map(
        (name) => () => fixture.alarm(name),
      ),
    ]) {
      fixture.calls.length = 0;
      await entry();
      expect(fixture.local.rows).toEqual(initial);
      expect((await background.status()).state).toBe(state);
      expect(fixture.calls.filter((call) => /:(set|remove)$/.test(call))).toEqual([]);
      expect(fixture.request).not.toHaveBeenCalled();
    }
  });

  it.each([profileKey, credentialKey])("fences unknown versions in %s at every retained entry", async (key) => {
    const initial: Record<string, unknown> = retained("paired-idle");
    initial[key] = { ...(initial[key] as object), schemaVersion: 2 };
    const fixture = chromeFixture(initial);
    const background = await loadBackground(fixture);
    for (const entry of [
      () => fixture.installed("install"),
      () => fixture.installed("update"),
      fixture.startup,
      ...["connector-work", "connector-revocation-retry", "connector-retention-deadline"].map(
        (name) => () => fixture.alarm(name),
      ),
    ]) {
      await entry();
      expect((await background.status()).state).toBe("upgrade-required");
      expect(fixture.local.rows).toEqual(initial);
      expect(fixture.calls.filter((call) => /:(set|remove)$/.test(call) || call.startsWith("alarm:"))).toEqual([]);
      expect(fixture.request).not.toHaveBeenCalled();
    }
  });

  it.each(["paired-idle", "paused", "unpairing", "cleanup-pending", "upgrade-required"])(
    "opens one page for %s without mutation or transport",
    async (state) => {
      const fixture = chromeFixture();
      await loadBackground(fixture);
      Object.assign(fixture.local.rows, retained(state));
      fixture.calls.length = 0;
      await fixture.click();
      expect(fixture.chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({
        url: `${platformOrigin}/account/channels${["paired-idle", "paused", "unpairing"].includes(state) ? "/connection_A" : ""}`,
      });
      expect(fixture.calls.filter((call) => /:(set|remove)$/.test(call) || call.startsWith("alarm:"))).toEqual([]);
      expect(fixture.request).not.toHaveBeenCalled();
      expect(fixture.chrome.identity.launchWebAuthFlow).not.toHaveBeenCalled();
    },
  );

  it.each(["unpaired", "revoked", "re-pair-required"])(
    "pairs on %s and keeps a concurrent pending click inert",
    async (state) => {
      const fixture = chromeFixture(retained(state));
      await loadBackground(fixture);
      let finish!: (value: string) => void;
      fixture.chrome.identity.launchWebAuthFlow.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const first = fixture.click();
      await vi.waitFor(() => expect(fixture.chrome.identity.launchWebAuthFlow).toHaveBeenCalledOnce());
      fixture.calls.length = 0;
      await fixture.click();
      expect(fixture.calls.filter((call) => /:(set|remove)$/.test(call) || call.startsWith("alarm:"))).toEqual([]);
      expect(fixture.chrome.identity.launchWebAuthFlow).toHaveBeenCalledOnce();
      expect(fixture.chrome.tabs.create).not.toHaveBeenCalled();
      finish("https://invalid.example");
      await first;
    },
  );

  it("kills an omitted session adapter with the same production pairing path", async () => {
    const fixture = chromeFixture();
    vi.doMock("../src/adapters/chrome-session", () => ({
      chromeSession: () => ({
        ...fixture.session,
        setAccessLevel: async () => {},
      }),
    }));
    await loadBackground(fixture);
    await fixture.click();
    expect(() => expect(fixture.chrome.identity.launchWebAuthFlow).toHaveBeenCalledOnce()).toThrow();
    expect(fixture.chrome.identity.launchWebAuthFlow).not.toHaveBeenCalled();
  });
});
