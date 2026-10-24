import { afterEach, describe, expect, it, vi } from "vitest";
import { chromeAction } from "../src/adapters/chrome-action";
import { chromeStorage } from "../src/adapters/chrome-storage";
import { chromeSession } from "../src/adapters/chrome-session";
import { chromeFixture } from "./chrome-test-support";

afterEach(() => vi.unstubAllGlobals());
describe("extension-popup-less-contract", () => {
  it.each([
    ["unpaired", ""],
    ["pairing-pending", "..."],
    ["paired-idle", "ON"],
    ["paused", "II"],
    ["unpairing", "..."],
    ["revoked", "!"],
    ["cleanup-pending", "!"],
    ["re-pair-required", "!"],
    ["upgrade-required", "!"],
  ] as const)("maps %s without leaking ids or secrets", async (state, text) => {
    const fixture = chromeFixture();
    vi.stubGlobal("chrome", fixture.chrome);
    const status = {
      state,
      connectionId: "secret-id-marker",
      pauseReason: null,
      pollWindowSeconds: null,
      pollWindowClamped: false,
    };
    await chromeAction().setBadge(status);
    await chromeAction().setTitle(status);
    expect(fixture.chrome.action.setBadgeText).toHaveBeenCalledExactlyOnceWith({ text });
    expect(fixture.chrome.action.setTitle).toHaveBeenCalledExactlyOnceWith({ title: state });
  });

  it.each(["local", "session"] as const)(
    "forwards real %s access level and rejects its relaxed mutant",
    async (name) => {
      const fixture = chromeFixture();
      vi.stubGlobal("chrome", fixture.chrome);
      const adapter = name === "local" ? chromeStorage() : chromeSession();
      await adapter.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      await adapter.set({ canary: true });
      expect(await adapter.get(["canary"])).toEqual({ canary: true });
      await adapter.remove(["canary"]);
      expect(await adapter.get(["canary"])).toEqual({});
      await fixture.chrome.storage[name].setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
      await expect(adapter.get(["canary"])).rejects.toThrow(`${name}-untrusted`);
    },
  );
});
