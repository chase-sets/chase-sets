import { describe, expect, it, vi } from "vitest";
import { backgroundFixture } from "./connector-background-test-support";
import { extensionProfileStates } from "../domain/extension-records";
import { deferred, extensionProfileKey, now } from "./extension-test-support";
import { mutatedBackground } from "./connector-background-mutants";

describe("connector-startup-alarm-reconciliation", () => {
  it.each(["paused", "upgrade-required"] as const)(
    "unconditional-reensure mutant fails the %s forbidden-alarm witness",
    async (state) => {
      const f = backgroundFixture(state, {}, mutatedBackground("unconditional-reensure"));
      await f.background.boot();
      expect(() => expect(f.alarms.has("connector-work")).toBe(false)).toThrow();
    },
  );
  it("unserialized mutant fails pause between state read and create", async () => {
    const f = backgroundFixture("paired-idle", {}, mutatedBackground("unserialized"));
    const held = deferred<void>();
    vi.mocked(f.ports.alarms.get).mockImplementationOnce(async () => {
      await held.promise;
      return undefined;
    });
    const boot = f.background.boot();
    await vi.waitFor(() => expect(f.ports.alarms.get).toHaveBeenCalled());
    await f.command("pause");
    held.resolve();
    await boot;
    expect(() => expect(f.alarms.has("connector-work")).toBe(false)).toThrow();
  });
  for (const state of extensionProfileStates) {
    for (const entry of ["boot", "startup", "install", "update", "overlap"] as const) {
      it(`${state} at ${entry} repairs only required alarms`, async () => {
        const f = backgroundFixture(state);
        vi.mocked(f.ports.transport.request).mockRejectedValue(new Error("synthetic-revocation-offline"));
        const start = () =>
          entry === "boot"
            ? f.background.boot()
            : entry === "startup"
              ? f.startup()
              : entry === "overlap"
                ? Promise.all([f.background.boot(), f.startup(), f.installed()])
                : f.installed(entry);
        await start();
        expect(f.alarms.has("connector-work")).toBe(state === "paired-idle");
        expect(f.alarms.has("connector-revocation-retry")).toBe(state === "unpairing");
        expect(f.alarms.has("connector-retention-deadline")).toBe(false);
        if (state === "upgrade-required") {
          expect(f.fake.writes() + f.fake.deletes() + f.session.writes() + f.session.deletes()).toBe(0);
          expect(f.ports.alarms.create).not.toHaveBeenCalled();
          expect(f.ports.alarms.clear).not.toHaveBeenCalled();
        }
      });
    }
  }
  it("uses the persisted 90 second period and preserves all present required schedules", async () => {
    const f = backgroundFixture("paired-idle");
    await f.ports.storage.set({
      [extensionProfileKey]: { ...(f.fake.rows()[extensionProfileKey] as object), servedPollWindowSeconds: 90 },
    });
    await f.background.boot();
    expect(f.alarms.get("connector-work")).toEqual({ periodInMinutes: 1.5 });
    f.alarms.set("connector-work", { when: Date.parse(now) + 12345, periodInMinutes: 1.5 });
    vi.mocked(f.ports.alarms.create).mockClear();
    await Promise.all([f.background.boot(), f.startup(), f.installed()]);
    expect(f.alarms.get("connector-work")).toEqual({ when: Date.parse(now) + 12345, periodInMinutes: 1.5 });
    expect(f.ports.alarms.create).not.toHaveBeenCalled();
  });
  it.each(["paired-idle", "paused"] as const)("preserves retention schedule across %s worker starts", async (state) => {
    const f = backgroundFixture(state);
    const when = Date.parse(now) + 60000;
    vi.mocked(f.ports.sweep.run).mockResolvedValue({ ok: true, nextDeadline: when });
    await f.background.boot();
    expect(f.alarms.get("connector-retention-deadline")).toEqual({ when });
    vi.mocked(f.ports.alarms.create).mockClear();
    for (const start of [
      f.background.boot,
      f.startup,
      () => f.installed(),
      () => f.installed("update"),
      () => Promise.all([f.background.boot(), f.startup(), f.installed(), f.installed("update")]),
    ]) {
      await start();
      expect(f.alarms.get("connector-retention-deadline")).toEqual({ when });
      expect(f.alarms.has("connector-work")).toBe(state === "paired-idle");
      expect(f.ports.alarms.create).not.toHaveBeenCalled();
    }
  });
  it.each(["boot", "startup", "install", "update", "overlap"] as const)(
    "preserves a future revocation retry at %s but renews an expired retry",
    async (entry) => {
      const f = backgroundFixture("unpairing");
      vi.mocked(f.ports.transport.request).mockRejectedValue(new Error("synthetic-offline"));
      const when = f.ports.clock.now() + 60000;
      f.alarms.set("connector-revocation-retry", { when });
      const start = () =>
        entry === "boot"
          ? f.background.boot()
          : entry === "startup"
            ? f.startup()
            : entry === "overlap"
              ? Promise.all([f.background.boot(), f.startup(), f.installed()])
              : f.installed(entry);
      await start();
      expect(f.alarms.get("connector-revocation-retry")).toEqual({ when });
      expect(f.ports.alarms.create).not.toHaveBeenCalled();
      f.setTime(when);
      await start();
      expect(f.alarms.get("connector-revocation-retry")?.when).toBe(when + 60000);
      expect(f.alarms.has("connector-work")).toBe(false);
    },
  );
  it("serializes a pause overlapping the missing-alarm read", async () => {
    const f = backgroundFixture("paired-idle");
    const held = deferred<void>();
    vi.mocked(f.ports.alarms.get).mockImplementationOnce(async () => {
      await held.promise;
      return undefined;
    });
    const boot = f.background.boot();
    await vi.waitFor(() => expect(f.ports.alarms.get).toHaveBeenCalled());
    const pause = f.command("pause");
    held.resolve();
    await Promise.all([boot, pause]);
    expect((await f.background.status()).state).toBe("paused");
    expect(f.alarms.has("connector-work")).toBe(false);
  });
  it("unknown retained versions leave missing alarms and all storage untouched across starts", async () => {
    const f = backgroundFixture("paired-idle");
    await f.ports.storage.set({ [extensionProfileKey]: { schemaVersion: 99 } });
    const before = {
      local: f.fake.rows(),
      session: f.session.rows(),
      writes: f.fake.writes() + f.fake.deletes() + f.session.writes() + f.session.deletes(),
    };
    for (const start of [
      f.background.boot,
      f.startup,
      () => f.installed(),
      () => f.installed("update"),
      () => Promise.all([f.background.boot(), f.startup(), f.installed(), f.installed("update")]),
    ]) {
      await start();
      expect((await f.background.status()).state).toBe("upgrade-required");
      expect(f.fake.rows()).toEqual(before.local);
      expect(f.session.rows()).toEqual(before.session);
      expect(f.fake.writes() + f.fake.deletes() + f.session.writes() + f.session.deletes()).toBe(before.writes);
      expect(f.ports.alarms.create).not.toHaveBeenCalled();
      expect(f.ports.alarms.clear).not.toHaveBeenCalled();
    }
  });
});
