import { describe, expect, it, vi } from "vitest";
import { createConnectorRetentionStore } from "../domain/connector-retention-store";
import { rawExportLifetime } from "../domain/raw-export-record";
import { backgroundFixture } from "./connector-background-test-support";
import { openDatabase, retainedRows, retentionFixture } from "./raw-retention-test-support";

function fixture() {
  const background = backgroundFixture("paired-idle");
  const raw = retentionFixture();
  const store = createConnectorRetentionStore({
    ...raw.ports,
    session: background.ports.session,
    clock: background.ports.clock,
  });
  Object.assign(background.ports, { sweep: store });
  const input = { ...raw.input(), downloadedAt: new Date(background.ports.clock.now()).toISOString() };
  return { ...background, raw, store, input };
}

describe("extension-production-bootstrap-day-after real retention sweep", () => {
  it("a synthetic blocked newer owner pauses with a retry alarm and badge without hanging background reads", async () => {
    const f = fixture();
    await f.store.write(f.input);
    const holder = await openDatabase(f.raw.indexedDB);
    holder.onversionchange = () => {};
    const upgrade = f.raw.indexedDB.open("connector-raw-exports", 2);
    const upgraded = new Promise<void>((resolve) => {
      upgrade.onsuccess = () => {
        upgrade.result.close();
        resolve();
      };
    });
    await new Promise<void>((resolve) => {
      upgrade.onblocked = () => resolve();
    });
    f.setTime(Date.parse(f.input.downloadedAt) + rawExportLifetime);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let finished = false;
      const boot = f.background.boot().then(() => {
        finished = true;
      });
      for (let attempt = 0; attempt < 12 && !finished; attempt++) await vi.advanceTimersByTimeAsync(1000);
      expect(finished).toBe(true);
      await boot;
      expect(f.ports.action.setBadge).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: "paused", pauseReason: "cleanup-failed" }),
      );
      expect(f.alarms.get("connector-retention-deadline")).toEqual({ when: f.ports.clock.now() + 30_000 });
      expect(f.ports.transport.coordinate).not.toHaveBeenCalled();
      const status = f.background.status();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await status).toMatchObject({ state: "paused", pauseReason: "cleanup-failed" });
    } finally {
      vi.useRealTimers();
      holder.close();
      await upgraded;
    }
    await f.alarm("connector-retention-deadline");
    expect(await f.background.status()).toMatchObject({ state: "upgrade-required" });
  });

  it("newer database fences boot/update/work/unpair/deadline before any state writes or effects", async () => {
    const f = fixture();
    await f.store.write(f.input);
    const db = await openDatabase(f.raw.indexedDB, 2, (db) =>
      db.createObjectStore("pending-operations").add("SYNTHETIC_FIXED_EXTERNAL_EFFECT", "pending"),
    );
    db.close();
    const before = await retainedRows(f.raw.indexedDB, 2);
    const write = vi.spyOn(f.ports.storage, "set");
    const remove = vi.spyOn(f.ports.session, "remove");
    for (const entry of [
      f.background.boot,
      () => f.installed("update"),
      f.startup,
      () => f.alarm("connector-work"),
      () => f.alarm("connector-retention-deadline"),
      () => f.command("unpair"),
    ]) {
      await entry();
      expect((await f.background.status()).state).toBe("upgrade-required");
      expect(await retainedRows(f.raw.indexedDB, 2)).toEqual(before);
    }
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(f.ports.transport.coordinate).not.toHaveBeenCalled();
    expect(f.ports.transport.request).not.toHaveBeenCalled();
  });

  it("sweep-order mutant cannot satisfy the coordinator-entry witness", async () => {
    for (const mutant of [false, true]) {
      const f = fixture();
      await f.store.write(f.input);
      vi.spyOn(f.ports.clock, "now").mockReturnValue(Date.parse(f.input.downloadedAt) + rawExportLifetime);
      let remainingAtEntry = -1;
      vi.mocked(f.ports.transport.coordinate!).mockImplementation(async () => {
        remainingAtEntry = (await retainedRows(f.raw.indexedDB)).length;
        return { outcome: "ok" };
      });
      if (mutant) vi.spyOn(f.store, "run").mockResolvedValue({ ok: true, nextDeadline: null });
      await f.alarm("connector-work");
      if (mutant) expect(() => expect(remainingAtEntry).toBe(0)).toThrow();
      else expect(remainingAtEntry).toBe(0);
    }
  });

  it("cleanup failure stays inert next day, then recovery sweeps before work", async () => {
    const f = fixture();
    await f.store.write(f.input);
    vi.spyOn(f.ports.clock, "now").mockReturnValue(Date.parse(f.input.downloadedAt) + rawExportLifetime);
    const remove = vi.spyOn(f.ports.session, "remove").mockRejectedValue(new Error("synthetic-cleanup-failure"));
    await f.alarm("connector-retention-deadline");
    expect(await f.background.status()).toMatchObject({ state: "paused", pauseReason: "cleanup-failed" });
    await f.background.boot();
    await f.alarm("connector-work");
    expect(f.ports.transport.coordinate).not.toHaveBeenCalled();
    expect(f.alarms.has("connector-retention-deadline")).toBe(true);
    remove.mockRestore();
    await f.alarm("connector-retention-deadline");
    expect((await f.background.status()).state).toBe("paired-idle");
    expect(await retainedRows(f.raw.indexedDB)).toEqual([]);
  });

  it("unpair cleans raw bytes before even an unavailable revocation transport", async () => {
    const f = fixture();
    await f.store.write(f.input);
    vi.mocked(f.ports.transport.request).mockImplementation(async () => {
      expect(await retainedRows(f.raw.indexedDB)).toEqual([]);
      return Response.json({}, { status: 503 });
    });
    await f.command("unpair");
    expect((await f.background.status()).state).toBe("unpairing");
    await expect(f.store.read("raw_A")).rejects.toThrow();
  });
});
