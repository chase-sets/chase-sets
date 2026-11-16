import { describe, expect, it } from "vitest";
import { refreshFixture } from "./refresh-test-support";

describe("ebay-credential-refresh-schedule", () => {
  const f = refreshFixture("schedule");
  it("first due, claim CAS and lease recovery reuse the attempt; stale lease completion writes nothing", async () => {
    const r = f.runtime();
    await f.connect(r);
    expect(await f.rows()).toMatchObject([
      { attempt: 0, schedule_generation: "1", due_at: new Date("2026-11-16T01:30:00Z"), last_outcome: "never" },
    ]);
    expect(await r.maintenance.claim()).toBeNull();
    f.advance(5400);
    const claims = await Promise.all([r.maintenance.claim(), r.maintenance.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(Boolean)!;
    expect(first.attempt).toBe(1);
    f.advance(60);
    const recovered = await r.maintenance.claim();
    expect(recovered).toMatchObject({ attempt: 1, schedule_generation: "1" });
    expect(recovered!.lease_id).not.toBe(first.lease_id);
    expect(await r.maintenance.process(first)).toBe(false);
    expect(await f.observations()).toEqual([]);
    expect(await r.maintenance.process(recovered!)).toBe(true);
    expect(await f.rows()).toMatchObject([
      { attempt: 0, schedule_generation: "2", token_generation: "1", lease_id: null, last_outcome: "succeeded" },
    ]);
    expect(await r.maintenance.claim()).toBeNull();
  });
  it("restarts without duplicate or due-now loop and fences interleaved prior-cycle completions", async () => {
    const r = f.runtime();
    await f.connect(r);
    f.advance(5400);
    const old = (await r.maintenance.claim())!;
    expect(await r.maintenance.process(old)).toBe(true);
    expect(await r.maintenance.process(old)).toBe(false);
    const restarted = f.restart(r.provider);
    expect(await restarted.sweep()).toBe(0);
    f.advance(5400);
    expect(await restarted.sweep()).toBe(1);
    expect(await f.rows()).toMatchObject([{ attempt: 0, schedule_generation: "3", token_generation: "1" }]);
    expect(await restarted.process(old)).toBe(false);
    expect(await f.observations()).toHaveLength(2);
  });
  it("retires the old generation and starts generation 1 of the successor schedule", async () => {
    const r = f.runtime({ changedMaterial: true });
    await f.connect(r);
    f.advance(5400);
    const old = (await r.maintenance.claim())!;
    expect(await r.maintenance.process(old)).toBe(true);
    expect(await f.rows()).toMatchObject([{ token_generation: "2", schedule_generation: "1", attempt: 0 }]);
    expect(await r.maintenance.process(old)).toBe(false);
    expect(await f.envelopes()).toMatchObject([{ token_generation: "2" }]);
  });
  it("initializes pre-slice custody once after restart without resetting an existing cycle", async () => {
    const r = f.runtime();
    await f.connect(r);
    await f.db().query("DELETE FROM channels_ebay_credential_refresh");
    f.advance(7200);
    expect(await r.maintenance.sweep()).toBe(1);
    expect(await f.rows()).toMatchObject([{ schedule_generation: "2", attempt: 0, last_outcome: "succeeded" }]);
    expect(await r.maintenance.sweep()).toBe(0);
    expect(await f.observations()).toHaveLength(1);
  });
});
